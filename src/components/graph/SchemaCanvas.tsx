import { Application, Container, Graphics, Sprite, Texture, TilingSprite } from "pixi.js";
import { Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BezierSegment, LayoutResult } from "@/lib/layout";
import {
  LayoutOrchestrator,
  defaultPoolSize,
  type OrchestratorRequest,
  type OrchestratorTimings,
} from "@/lib/layout-orchestrator";
import type { GraphEdgeData, GraphNodeData, NodeKind } from "@/lib/sdl-to-graph";
import { useTheme } from "@/lib/theme";
import {
  HEADER_H,
  KIND_COLORS,
  NODE_NAME_FONT,
  ROW_H,
  TOP_BODY_PAD,
  estimateNodeHeight,
  estimateNodeWidth,
} from "./node-style";

/**
 * Pixi.js v8 schema graph renderer.
 *
 * Scene graph:
 *   Application.stage
 *    ├── gridTiling (TilingSprite) — dot grid, screen-space
 *    └── world (Container) — pan/zoom transform
 *         ├── edgeGraphics (Graphics) — all edges batched
 *         ├── arrowGraphics (Graphics) — all arrowheads
 *         ├── nodeContainer (Container) — one Sprite per node
 *         ├── hoverGraphics (Graphics) — field row highlight
 *         └── focusGraphics (Graphics) — focus ring + hover ring
 */

interface LaidNode {
  id: string;
  data: GraphNodeData;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

interface Point {
  x: number;
  y: number;
}

interface LaidEdge {
  sourceId: string;
  targetId: string;
  kind: GraphEdgeData["kind"];
  nullable: boolean;
  start: Point;
  segments: BezierSegment[];
  arrowTip?: Point;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

interface Props {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  focusId?: string | null;
  rootId?: string | null;
  onNavigate?: (typeId: string) => void;
  onClearFocus?: () => void;
}

interface EdgeGroupSpec {
  color: string;
  colorHex: number;
  dash: number[];
  dim: LaidEdge[];
  active: LaidEdge[];
}

interface EdgeGroups {
  groups: EdgeGroupSpec[];
  dimNodeIds: Set<string>;
}

interface SpriteCtx {
  cardColor: string;
  fgColor: string;
  mutedFg: string;
}

const BUILTIN_SCALARS = new Set(["String", "Int", "Float", "Boolean", "ID"]);
const CLICK_DRAG_THRESHOLD = 4;
const EMPTY_LAYOUT: LayoutResult = { nodes: [], edgePaths: [] };
const CULL_PAD = 100;
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

// Edge tiling. Large schemas tessellate millions of vertices across
// their 10k+ edges; a single monolithic `Graphics` for all of them
// blows through mobile GPU budgets. We partition world-space into
// TILE_SIZE cells, build per-tile Graphics lazily when the tile enters
// the viewport, and destroy them once they've been off-screen long
// enough. Edges whose bbox spans multiple tiles are registered in each
// overlapping tile — duplication is bounded (typically 1–2×) because
// dot's layout keeps connected nodes spatially close.
const TILE_SIZE = 2048;
const TILE_EVICT_FRAMES = 180;
const TILE_VIEW_PADDING = 256;

// Sprite viewport management. Mirrors the edge-tile strategy: only
// sprites currently inside the padded viewport get real textures;
// off-screen sprites show a tinted placeholder so texture memory
// scales with visible area instead of total node count.
const SPRITE_VIEW_PADDING = 200;
const SPRITE_EVICT_FRAMES = 180;

// Quiet-period gate for GPU uploads. While the user is actively
// panning or zooming we keep sprites on their tinted placeholder and
// defer tile/texture builds — a fast pan on a large schema can queue
// hundreds of `texImage2D` calls per second and crash mobile GPU
// drivers. Once the view has been stable for this many milliseconds
// we resume progressive builds.
const MOTION_SETTLE_MS = 150;

interface EdgeTileGroupLists {
  dim: LaidEdge[];
  active: LaidEdge[];
}

interface EdgeTile {
  key: string;
  col: number;
  row: number;
  groupLists: EdgeTileGroupLists[];
  edgeGraphics: Graphics | null;
  arrowGraphics: Graphics | null;
  lastSeenFrame: number;
}

// LOD tiers
type SpriteLOD = "full" | "bar" | "chrome";
const LOD_FULL = 0.22;
const LOD_BAR = 0.07;
// Hysteresis: once inside a tier, require a slightly larger excursion
// before exiting. Prevents oscillation (and its sprite rebuild cost)
// when the user parks their zoom right on a boundary.
const LOD_HYSTERESIS = 0.015;

function computeLOD(viewK: number, prev: SpriteLOD): SpriteLOD {
  if (prev === "full") {
    if (viewK >= LOD_FULL - LOD_HYSTERESIS) return "full";
    if (viewK >= LOD_BAR) return "bar";
    return "chrome";
  }
  if (prev === "bar") {
    if (viewK >= LOD_FULL) return "full";
    if (viewK >= LOD_BAR - LOD_HYSTERESIS) return "bar";
    return "chrome";
  }
  if (viewK >= LOD_FULL) return "full";
  if (viewK >= LOD_BAR) return "bar";
  return "chrome";
}

const BAR_NAME_FRACS = [0.62, 0.50, 0.71, 0.55, 0.44, 0.68];
const BAR_FIELD_FRACS = [0.44, 0.36, 0.52, 0.38, 0.46, 0.32];
const BAR_TYPE_FRACS = [0.24, 0.30, 0.20, 0.27, 0.22, 0.28];

// Conservative DPR caps that survive 1,400-node schemas on every
// device we care about. Per-tab GPU budget in Chrome lands around
// 500 MB even on desktop; at bar DPR=2 a 1,400-sprite schema plus
// framebuffer and internal Pixi state overruns that on an active
// pan and the renderer process dies ("Aw, Snap!"). Bar LOD is just
// fake-bar hints, DPR 1 is indistinguishable at zoom. Full LOD gets
// DPR 2 so text is still crisp for zoomed-in inspection.
function spriteDprForLod(lod: SpriteLOD): number {
  const monitorDpr =
    typeof window !== "undefined" ? Math.max(1, window.devicePixelRatio || 1) : 1;
  if (lod === "chrome") return 1;
  if (lod === "bar") return 1;
  return Math.min(2, Math.max(1, Math.ceil(monitorDpr)));
}

// LOD-aware live texture cache caps. "bar" is cheap (48 KB/texture at
// DPR=1) so we let a 1,400-node grid fully populate; "full" costs 4×
// more per texture so we keep the ceiling tight. When the cap is hit
// the drain simply stops — remaining sprites stay on the tint
// placeholder until off-screen sprites evict and free room. We never
// evict currently-in-view sprites to make space, because on a
// schema whose viewport contains more sprites than the cap allows
// that would become a permanent build→evict→rebuild churn and crash
// the GPU driver within a couple of seconds.
const MAX_TEXTURE_CACHE_BAR = 1600;
const MAX_TEXTURE_CACHE_FULL = 400;

function maxTextureCacheFor(lod: SpriteLOD): number {
  return lod === "bar" ? MAX_TEXTURE_CACHE_BAR : MAX_TEXTURE_CACHE_FULL;
}

function getComputedCssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return val || fallback;
}

function cssColorToHex(color: string): number {
  // Handle #rrggbb
  if (color.startsWith("#") && color.length === 7) {
    return parseInt(color.slice(1), 16);
  }
  // Handle #rgb
  if (color.startsWith("#") && color.length === 4) {
    const r = color[1]!;
    const g = color[2]!;
    const b = color[3]!;
    return parseInt(r + r + g + g + b + b, 16);
  }
  // Handle hsl(...) and rgb(...) via a canvas trick
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return ((d[0]! << 16) | (d[1]! << 8) | d[2]!);
    }
  }
  return 0xffffff;
}

// measureText cache
const typeWidthCache = new Map<string, number>();
const fitTextCache = new Map<string, string>();

function cachedTextWidth(ctx: CanvasRenderingContext2D, text: string): number {
  let w = typeWidthCache.get(text);
  if (w !== undefined) return w;
  w = ctx.measureText(text).width;
  typeWidthCache.set(text, w);
  return w;
}

function fitText(ctx: CanvasRenderingContext2D, s: string, maxWidth: number): string {
  const cacheKey = `${s}|${maxWidth}`;
  const cached = fitTextCache.get(cacheKey);
  if (cached !== undefined) return cached;

  if (ctx.measureText(s).width <= maxWidth) {
    fitTextCache.set(cacheKey, s);
    return s;
  }
  const ellipsis = "…";
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const cand = s.slice(0, mid) + ellipsis;
    if (ctx.measureText(cand).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  const result = lo > 0 ? s.slice(0, lo) + ellipsis : ellipsis;
  fitTextCache.set(cacheKey, result);
  return result;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function roundRectTopOnly(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function drawColoredType(
  ctx: CanvasRenderingContext2D,
  typeStr: string,
  rightX: number,
  y: number,
) {
  const w = cachedTextWidth(ctx, typeStr);
  ctx.fillStyle = "#f59e0b";
  ctx.fillText(typeStr, rightX - w, y);
}

const RELAY_COLOR = "#F26A03";
const RELAY_SVG_PATH = new Path2D(
  "M2.264 4.937A2.264 2.264 0 1 0 4.456 7.77h10.339a1.792 1.792 0 0 1 0 3.583h-5.73a3.037 3.037 0 0 0-3.034 3.033a3.036 3.036 0 0 0 3.033 3.033h10.494a2.264 2.264 0 1 0 0-1.242H9.064a1.793 1.793 0 0 1-1.791-1.791c0-.988.803-1.792 1.791-1.792h5.73a3.036 3.036 0 0 0 3.034-3.033a3.036 3.036 0 0 0-3.033-3.033H4.427a2.265 2.265 0 0 0-2.163-1.592",
);

function drawRelayIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
  const scale = 8 / 24;
  ctx.save();
  ctx.fillStyle = RELAY_COLOR;
  ctx.globalAlpha = 0.85;
  ctx.translate(cx - 12 * scale, cy - 12 * scale);
  ctx.scale(scale, scale);
  ctx.fill(RELAY_SVG_PATH);
  ctx.restore();
}

function bodyRowCount(n: LaidNode): number {
  const d = n.data;
  if (d.kind === "Enum") return (d.values ?? []).length;
  if (d.kind === "Union") return (d.members ?? []).length;
  if (d.kind === "Scalar") return 1;
  return (d.fields ?? []).length;
}

function drawNodeSprite(
  ctx: CanvasRenderingContext2D,
  n: LaidNode,
  { cardColor, fgColor, mutedFg }: SpriteCtx,
  lod: SpriteLOD,
) {
  const w = n.w;
  const h = n.h;
  const color = KIND_COLORS[n.data.kind];

  if (lod === "chrome") {
    roundRect(ctx, 0, 0, w, h, 6);
    ctx.fillStyle = color;
    ctx.fill();
    return;
  }

  roundRect(ctx, 0, 0, w, h, 6);
  ctx.fillStyle = cardColor;
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  ctx.globalAlpha = 0.75;
  ctx.stroke();
  ctx.globalAlpha = 1;

  roundRectTopOnly(ctx, 0, 0, w, HEADER_H, 6);
  ctx.fillStyle = color;
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = 0.75;
  ctx.beginPath();
  ctx.moveTo(0, HEADER_H);
  ctx.lineTo(w, HEADER_H);
  ctx.stroke();
  ctx.globalAlpha = 1;

  if (lod === "bar") {
    const avail = w - 16;
    const nFrac = BAR_NAME_FRACS[0]!;
    ctx.fillStyle = "#ffffff";
    ctx.globalAlpha = 0.55;
    roundRect(ctx, 8, 23, avail * nFrac, 5, 2.5);
    ctx.fill();
    ctx.globalAlpha = 1;

    const bodyY = HEADER_H + TOP_BODY_PAD - 2;
    const rowCount = bodyRowCount(n);
    for (let i = 0; i < rowCount; i++) {
      const fy = bodyY + i * ROW_H + 3;
      const ff = BAR_FIELD_FRACS[i % BAR_FIELD_FRACS.length]!;
      const tf = BAR_TYPE_FRACS[i % BAR_TYPE_FRACS.length]!;
      const typeBarW = avail * tf;
      ctx.fillStyle = fgColor;
      ctx.globalAlpha = 0.35;
      roundRect(ctx, 10, fy, avail * ff, 4, 2);
      ctx.fill();
      ctx.fillStyle = "#f59e0b";
      ctx.globalAlpha = 0.45;
      roundRect(ctx, w - 10 - typeBarW, fy, typeBarW, 4, 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    return;
  }

  // full tier
  ctx.font = `600 9px ${MONO}`;
  ctx.fillStyle = "#ffffff";
  ctx.globalAlpha = 0.6;
  ctx.fillText(n.data.kind.toUpperCase(), 8, 14);
  ctx.globalAlpha = 1;

  ctx.font = NODE_NAME_FONT;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(fitText(ctx, n.data.name, w - 16), 8, 30);

  const bodyY = HEADER_H + TOP_BODY_PAD - 2;
  if (n.data.kind === "Enum") {
    ctx.font = `10px ${MONO}`;
    ctx.fillStyle = mutedFg;
    const values = n.data.values ?? [];
    for (let i = 0; i < values.length; i++) {
      ctx.fillText(values[i]!.name, 10, bodyY + i * ROW_H + 10);
    }
  } else if (n.data.kind === "Union") {
    ctx.font = `10px ${MONO}`;
    ctx.fillStyle = mutedFg;
    const members = n.data.members ?? [];
    for (let i = 0; i < members.length; i++) {
      ctx.fillText("| " + members[i]!, 10, bodyY + i * ROW_H + 10);
    }
  } else if (n.data.kind === "Scalar") {
    ctx.font = `italic 10px ${MONO}`;
    ctx.fillStyle = mutedFg;
    ctx.fillText("custom scalar", 10, bodyY + 10);
  } else {
    const fields = n.data.fields ?? [];
    ctx.font = `10px ${MONO}`;
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i]!;
      const fy = bodyY + i * ROW_H + 10;
      ctx.fillStyle = fgColor;
      ctx.globalAlpha = f.isDeprecated ? 0.4 : 1;
      ctx.fillText(f.name, 10, fy);
      if (f.isDeprecated) {
        const nameW = ctx.measureText(f.name).width;
        ctx.strokeStyle = fgColor;
        ctx.lineWidth = 0.75;
        ctx.beginPath();
        ctx.moveTo(10, fy - 3.5);
        ctx.lineTo(10 + nameW, fy - 3.5);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (f.isRelayConnection) {
        const typeW = ctx.measureText(f.type).width;
        const iconCx = w - 10 - typeW - 8;
        drawRelayIcon(ctx, iconCx, fy - 2);
        ctx.font = `10px ${MONO}`;
      }
      drawColoredType(ctx, f.type, w - 10, fy);
    }
  }
}

/**
 * Shared "chrome/bar LOD" placeholder texture for one node kind.
 * Small (256×128 DPR 1 = 128 KB) and reused across every sprite of
 * that kind — so a 1,400-node schema only ever needs 6 placeholder
 * uploads total (one per NodeKind) instead of 1,400. Each texture
 * paints a rounded card silhouette with the kind's accent color as
 * the header strip and a low-alpha body tint beneath.
 */
function buildKindPlaceholderTexture(kind: NodeKind): Texture {
  const w = 256;
  const h = 128;
  const headerH = 32;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Texture.WHITE;
  const color = KIND_COLORS[kind];

  // Body: low-alpha kind color so the card reads as "muted" behind the
  // header. The card stays legible on both light and dark backgrounds
  // because Pixi composites against the scene's actual background.
  roundRect(ctx, 0, 0, w, h, 10);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.18;
  ctx.fill();

  // Header: full-opacity kind color strip across the top.
  ctx.globalAlpha = 1;
  roundRectTopOnly(ctx, 0, 0, w, headerH, 10);
  ctx.fillStyle = color;
  ctx.fill();

  // Outline to sharpen the card edge after scaling.
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1.5;
  roundRect(ctx, 0.75, 0.75, w - 1.5, h - 1.5, 9.5);
  ctx.stroke();
  ctx.globalAlpha = 1;

  return Texture.from(canvas);
}

// ─── Dashed bezier walker ─────────────────────────────────────────────

/** Sample a cubic bezier at parameter t */
function cubicBezier(
  p0: Point, p1: Point, p2: Point, p3: Point, t: number,
): Point {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  return {
    x: mt2 * mt * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t2 * t * p3.x,
    y: mt2 * mt * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t2 * t * p3.y,
  };
}

/**
 * Draw a dashed bezier path on a Pixi Graphics object.
 * Pixi v8 has no setLineDash, so we walk the curve parametrically
 * and alternate moveTo (gap) / lineTo (dash).
 */
function drawDashedBezierEdge(
  g: Graphics,
  edge: LaidEdge,
  dash: number[],
  color: number,
  alpha: number,
  strokeWidth: number,
) {
  const STEPS = 20;
  let arcLen = 0;
  let dashIndex = 0;
  let dashPos = 0;
  let drawing = true; // start with dash

  const points: Point[] = [];

  // Collect all points along the bezier chain
  let prevPt: Point = edge.start;
  points.push(prevPt);
  for (const seg of edge.segments) {
    for (let i = 1; i <= STEPS; i++) {
      const t = i / STEPS;
      const pt = cubicBezier(prevPt, seg.c1, seg.c2, seg.end, t);
      // approximate: use start and end of segment as p0
      points.push(pt);
    }
    prevPt = seg.end;
  }
  if (edge.arrowTip) {
    points.push(edge.arrowTip);
  }

  // Walk and dash
  let penDown = false;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const curr = points[i]!;
    const segLen = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    if (segLen < 0.001) continue;

    let consumed = 0;
    while (consumed < segLen) {
      const dashLen = dash[dashIndex % dash.length]!;
      const remaining = dashLen - dashPos;
      const available = segLen - consumed;
      const advance = Math.min(remaining, available);
      const t = consumed / segLen;
      const nextT = (consumed + advance) / segLen;
      const startPt = {
        x: prev.x + (curr.x - prev.x) * t,
        y: prev.y + (curr.y - prev.y) * t,
      };
      const endPt = {
        x: prev.x + (curr.x - prev.x) * nextT,
        y: prev.y + (curr.y - prev.y) * nextT,
      };

      if (drawing) {
        if (!penDown) {
          g.moveTo(startPt.x, startPt.y);
          penDown = true;
        }
        g.lineTo(endPt.x, endPt.y);
      } else {
        penDown = false;
        arcLen += advance;
        void arcLen;
      }

      dashPos += advance;
      consumed += advance;

      if (dashPos >= dashLen) {
        dashPos = 0;
        dashIndex++;
        drawing = !drawing;
      }
    }
  }
}

/** Draw a solid bezier edge path on a Pixi Graphics object */
function drawSolidBezierEdge(g: Graphics, edge: LaidEdge) {
  g.moveTo(edge.start.x, edge.start.y);
  for (const seg of edge.segments) {
    g.bezierCurveTo(seg.c1.x, seg.c1.y, seg.c2.x, seg.c2.y, seg.end.x, seg.end.y);
  }
  if (edge.arrowTip) {
    g.lineTo(edge.arrowTip.x, edge.arrowTip.y);
  }
}

/**
 * Build the edge + arrow Graphics for a single tile. The scope of a
 * tile is bounded, so vertex-buffer size per Graphics stays small even
 * when the whole schema has 10k+ edges. Called lazily the first time a
 * tile enters the viewport; destroyed after it's been off-screen long.
 */
function buildEdgeTileGraphics(
  tile: EdgeTile,
  groups: EdgeGroupSpec[],
): { edge: Graphics; arrow: Graphics } {
  const edge = new Graphics();
  const arrow = new Graphics();
  const DIM = 0.1;
  const STROKE_W = 1.4;

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi]!;
    const lists = tile.groupLists[gi];
    if (!lists) continue;
    const colorHex = group.colorHex;

    if (lists.dim.length > 0) {
      if (group.dash.length > 0) {
        for (const e of lists.dim) {
          drawDashedBezierEdge(edge, e, group.dash, colorHex, DIM, STROKE_W);
        }
        edge.stroke({ width: STROKE_W, color: colorHex, alpha: DIM });
      } else {
        edge.beginPath();
        for (const e of lists.dim) drawSolidBezierEdge(edge, e);
        edge.stroke({ width: STROKE_W, color: colorHex, alpha: DIM });
      }
      arrow.beginPath();
      for (const e of lists.dim) drawArrowHead(arrow, e);
      arrow.fill({ color: colorHex, alpha: DIM });
    }

    if (lists.active.length > 0) {
      if (group.dash.length > 0) {
        for (const e of lists.active) {
          drawDashedBezierEdge(edge, e, group.dash, colorHex, 1, STROKE_W);
        }
        edge.stroke({ width: STROKE_W, color: colorHex, alpha: 1 });
      } else {
        edge.beginPath();
        for (const e of lists.active) drawSolidBezierEdge(edge, e);
        edge.stroke({ width: STROKE_W, color: colorHex, alpha: 1 });
      }
      arrow.beginPath();
      for (const e of lists.active) drawArrowHead(arrow, e);
      arrow.fill({ color: colorHex, alpha: 1 });
    }
  }

  return { edge, arrow };
}

/** Draw arrowhead for an edge onto a Pixi Graphics already set up for fill */
function drawArrowHead(g: Graphics, edge: LaidEdge) {
  const lastSeg = edge.segments[edge.segments.length - 1]!;
  const tangentFrom = edge.arrowTip ? lastSeg.end : lastSeg.c2;
  const tangentTo = edge.arrowTip ?? lastSeg.end;
  const adx = tangentTo.x - tangentFrom.x;
  const ady = tangentTo.y - tangentFrom.y;
  const alen = Math.hypot(adx, ady);
  if (alen <= 0) return;
  const ax = adx / alen;
  const ay = ady / alen;
  const sz = 7;
  g.moveTo(tangentTo.x, tangentTo.y);
  g.lineTo(tangentTo.x - ax * sz + ay * sz * 0.4, tangentTo.y - ay * sz - ax * sz * 0.4);
  g.lineTo(tangentTo.x - ax * sz - ay * sz * 0.4, tangentTo.y - ay * sz + ax * sz * 0.4);
  g.closePath();
}

// ─── Dot grid tile builder ────────────────────────────────────────────

function buildDotGridTexture(dotColor: number, alpha: number): Texture {
  const size = 24;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const r = (dotColor >> 16) & 0xff;
  const gv = (dotColor >> 8) & 0xff;
  const b = dotColor & 0xff;
  ctx.fillStyle = `rgba(${r},${gv},${b},${alpha})`;
  ctx.fillRect(0, 0, 1, 1);
  return Texture.from(canvas);
}

// ─── Main component ───────────────────────────────────────────────────

export function SchemaCanvas({ nodes, edges, focusId, rootId, onNavigate, onClearFocus }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pixiContainerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1, h: 1 });
  const viewRef = useRef({ x: 0, y: 0, k: 1 });

  const dragRef = useRef({
    active: false,
    lastX: 0,
    lastY: 0,
    startX: 0,
    startY: 0,
    moved: false,
  });

  const hoveredFieldRef = useRef<{ nodeId: string; fieldIndex: number; isRelayHover: boolean } | null>(null);
  const hoveredNodeRef = useRef<string | null>(null);
  const [cursor, setCursor] = useState<"grab" | "pointer">("grab");
  const { resolved: themeResolved } = useTheme();
  const currentLodRef = useRef<SpriteLOD>("full");
  const [lodTick, setLodTick] = useState(0);
  const [appReady, setAppReady] = useState(false);

  // Layout state
  const [layoutResult, setLayoutResult] = useState<LayoutResult>(EMPTY_LAYOUT);
  const [isPending, setIsPending] = useState(nodes.length > 0);
  const [lastTiming, setLastTiming] = useState<OrchestratorTimings | null>(null);
  const lastTimingRef = useRef<OrchestratorTimings | null>(null);
  const orchestratorRef = useRef<LayoutOrchestrator | null>(null);
  const requestIdRef = useRef(0);

  // Pixi app + scene graph refs
  const appRef = useRef<Application | null>(null);
  const sceneRef = useRef<{
    gridTiling: TilingSprite | null;
    world: Container | null;
    edgeTileContainer: Container | null;
    arrowTileContainer: Container | null;
    nodeContainer: Container | null;
    hoverGraphics: Graphics | null;
    focusGraphics: Graphics | null;
  }>({
    gridTiling: null,
    world: null,
    edgeTileContainer: null,
    arrowTileContainer: null,
    nodeContainer: null,
    hoverGraphics: null,
    focusGraphics: null,
  });

  // Node sprite/texture cache
  const textureCacheRef = useRef(new Map<string, Texture>());
  const spriteDprRef = useRef(0);
  const nodeSpritesRef = useRef(new Map<string, Sprite>());
  const spriteCtxRef = useRef<SpriteCtx | null>(null);

  // Edge tile cache — spatial grid of per-tile Graphics. See `TILE_SIZE`
  // below. Each tile is built lazily when it first enters the viewport
  // and destroyed after `TILE_EVICT_FRAMES` frames off-screen, capping
  // GPU memory so large schemas don't crash the mobile renderer.
  const edgeTilesRef = useRef(new Map<string, EdgeTile>());
  const frameCounterRef = useRef(0);

  // Per-sprite viewport bookkeeping. `spriteLastSeenFrameRef` tracks
  // the last frame a sprite was inside the (padded) viewport so the
  // ticker can destroy textures for sprites that have been off-screen
  // for long enough — this is what lets us crank DPR up on the "full"
  // tier without holding textures for all N nodes at once.
  const spriteLastSeenFrameRef = useRef(new Map<string, number>());
  const lastSpriteSweepViewRef = useRef({ x: 0, y: 0, k: 0, lod: "full" as SpriteLOD });
  // Progressive sprite-creation queue. On a big schema the viewport
  // sweep can discover thousands of nodes needing a Sprite at once
  // (e.g. zooming out to see the whole graph). Allocating that many
  // `new Sprite` + `addChild` pairs in a single frame overwhelms
  // the Pixi renderer hard enough to crash the tab, so we defer to
  // this queue and drain a budgeted chunk per frame.
  const spriteCreateQueueRef = useRef<LaidNode[] | null>(null);

  // Shared "kind placeholder" textures — one per node kind. Used as
  // sprite source at chrome/bar LOD instead of Texture.WHITE + tint.
  // Lets us paint rounded corners and a header strip (proper card
  // silhouette) without paying for 1,400 individual texture uploads.
  const kindTextureCacheRef = useRef<Map<NodeKind, Texture>>(new Map());
  // Last timestamp the view changed significantly. Texture uploads
  // (Pixi `Texture.from(canvas)` → WebGL `texImage2D`) and tile
  // Graphics builds are gated on this: during an active pan/zoom we
  // pause all GPU uploads so the mobile driver doesn't get flooded
  // and crash the renderer. Once the view has been stable for
  // `MOTION_SETTLE_MS` we resume building progressively.
  const lastViewChangeAtRef = useRef(0);

  // Progressive sprite build queue — filled by the node useEffect,
  // drained by the ticker a few nodes per frame (budget-limited).
  interface SpriteBuildQueue {
    nodes: LaidNode[];
    lod: SpriteLOD;
    dpr: number;
    spriteCtx: SpriteCtx;
    dimNodeIds: Set<string>;
  }
  const spriteBuildQueueRef = useRef<SpriteBuildQueue | null>(null);

  // FPS state for overlay
  const [fpsDisplay, setFpsDisplay] = useState(0);
  const fpsHistoryRef = useRef<number[]>(new Array(60).fill(0));
  const chartCanvasRef = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: Math.max(1, r.width), h: Math.max(1, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Pool of layout workers. Orchestrator splits the graph into
  // weakly-connected components and dispatches each to a free worker
  // in parallel, so large schemas finish in wall-clock ~= (biggest
  // component time) rather than (sum of all components).
  useEffect(() => {
    const orch = new LayoutOrchestrator(defaultPoolSize());
    orch.setFatalHandler((err) => {
      console.error("layout orchestrator error:", err.message);
      setIsPending(false);
    });
    orchestratorRef.current = orch;
    return () => {
      orch.terminate();
      orchestratorRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (nodes.length === 0) {
      requestIdRef.current += 1;
      setLayoutResult(EMPTY_LAYOUT);
      setIsPending(false);
      return;
    }
    const orch = orchestratorRef.current;
    if (!orch) return;
    const layoutNodes = nodes.map((n) => ({
      id: n.id,
      width: estimateNodeWidth(
        n.name,
        n.kind === "Enum"
          ? (n.values?.map((v) => [v.name, ""] as const) ?? [])
          : n.kind === "Union"
            ? (n.members?.map((m) => ["| " + m, ""] as const) ?? [])
            : (n.fields?.map((x) => [x.name, x.typeName] as const) ?? []),
      ),
      height: estimateNodeHeight(
        n.kind,
        n.fields?.length ?? 0,
        n.values?.length ?? 0,
        n.members?.length ?? 0,
      ),
    }));
    const id = ++requestIdRef.current;
    setIsPending(true);
    const request: OrchestratorRequest = {
      id,
      nodes,
      edges,
      layoutNodes,
      rootId: rootId ?? null,
    };
    orch
      .layout(request)
      .then((resp) => {
        if (resp.id !== requestIdRef.current) return;
        setLayoutResult(resp.result);
        setLastTiming(resp.timings);
        lastTimingRef.current = resp.timings;
        setIsPending(false);
      })
      .catch((err: Error) => {
        console.error("layout failed:", err.message);
        setIsPending(false);
      });
  }, [nodes, edges, rootId]);

  const laidNodes = useMemo<LaidNode[]>(() => {
    const byId = new Map<string, GraphNodeData>();
    for (const n of nodes) byId.set(n.id, n);
    return layoutResult.nodes
      .filter((p) => byId.has(p.id))
      .map((p) => ({
        id: p.id,
        data: byId.get(p.id)!,
        cx: p.x,
        cy: p.y,
        w: p.width,
        h: p.height,
      }));
  }, [layoutResult, nodes]);

  const nodeById = useMemo(() => {
    const m = new Map<string, LaidNode>();
    for (const n of laidNodes) m.set(n.id, n);
    return m;
  }, [laidNodes]);

  const laidEdges = useMemo<LaidEdge[]>(() => {
    const byEdgeId = new Map<string, (typeof layoutResult.edgePaths)[number]>();
    for (const p of layoutResult.edgePaths) byEdgeId.set(p.edgeId, p);
    const out: LaidEdge[] = [];
    for (const e of edges) {
      if (e.source === e.target) continue;
      const a = nodeById.get(e.source);
      const b = nodeById.get(e.target);
      if (!a || !b) continue;
      const path = byEdgeId.get(e.id);
      if (!path || path.segments.length === 0) continue;

      let start: Point = { x: path.start.x, y: path.start.y };
      let segments: BezierSegment[] = path.segments;
      const arrowTip = path.arrowTip;

      if (e.kind === "field" && e.sourceFieldIndex != null && b.cx > a.cx && segments.length > 0) {
        const exitX = a.cx + a.w / 2;
        const exitY = a.cy - a.h / 2 + HEADER_H + TOP_BODY_PAD - 2 + e.sourceFieldIndex * ROW_H + 6;
        const origC1 = segments[0]!.c1;
        const tangentLen = Math.hypot(origC1.x - start.x, origC1.y - start.y);
        const c1Offset = Math.max(tangentLen, 32);
        start = { x: exitX, y: exitY };
        segments = [
          {
            c1: { x: exitX + c1Offset, y: exitY },
            c2: segments[0]!.c2,
            end: segments[0]!.end,
          },
          ...segments.slice(1),
        ];
      }

      let minX = start.x, maxX = start.x, minY = start.y, maxY = start.y;
      for (const s of segments) {
        if (s.c1.x < minX) minX = s.c1.x; else if (s.c1.x > maxX) maxX = s.c1.x;
        if (s.c1.y < minY) minY = s.c1.y; else if (s.c1.y > maxY) maxY = s.c1.y;
        if (s.c2.x < minX) minX = s.c2.x; else if (s.c2.x > maxX) maxX = s.c2.x;
        if (s.c2.y < minY) minY = s.c2.y; else if (s.c2.y > maxY) maxY = s.c2.y;
        if (s.end.x < minX) minX = s.end.x; else if (s.end.x > maxX) maxX = s.end.x;
        if (s.end.y < minY) minY = s.end.y; else if (s.end.y > maxY) maxY = s.end.y;
      }
      if (arrowTip) {
        if (arrowTip.x < minX) minX = arrowTip.x; else if (arrowTip.x > maxX) maxX = arrowTip.x;
        if (arrowTip.y < minY) minY = arrowTip.y; else if (arrowTip.y > maxY) maxY = arrowTip.y;
      }

      out.push({
        sourceId: e.source,
        targetId: e.target,
        kind: e.kind,
        nullable: e.nullable ?? false,
        start,
        segments,
        arrowTip,
        bbox: { minX, minY, maxX, maxY },
      });
    }
    return out;
  }, [edges, layoutResult, nodeById]);

  const edgeGroups = useMemo((): EdgeGroups => {
    const buckets: [LaidEdge[], string, number, number[]][] = [
      [[], "#6366f1", 0x6366f1, []],
      [[], "#6366f1", 0x6366f1, [4, 3]],
      [[], "#eab308", 0xeab308, []],
      [[], "#64748b", 0x64748b, [6, 4]],
      [[], "#f97316", 0xf97316, [3, 3]],
    ];
    for (const e of laidEdges) {
      if (e.kind === "implements") buckets[3]![0].push(e);
      else if (e.kind === "union") buckets[2]![0].push(e);
      else if (e.kind === "arg") buckets[4]![0].push(e);
      else if (e.kind === "field" && e.nullable) buckets[1]![0].push(e);
      else buckets[0]![0].push(e);
    }
    const shouldDim = focusId && focusId !== rootId;
    const groups: EdgeGroupSpec[] = buckets.map(([edgeList, color, colorHex, dash]) => {
      if (!shouldDim) return { color, colorHex, dash, dim: [], active: edgeList };
      return {
        color,
        colorHex,
        dash,
        dim: edgeList.filter((e) => e.sourceId !== focusId && e.targetId !== focusId),
        active: edgeList.filter((e) => e.sourceId === focusId || e.targetId === focusId),
      };
    });

    const dimNodeIds = new Set<string>();
    if (shouldDim && focusId) {
      const connectedIds = new Set<string>([focusId]);
      for (const e of laidEdges) {
        if (e.sourceId === focusId) connectedIds.add(e.targetId);
        else if (e.targetId === focusId) connectedIds.add(e.sourceId);
      }
      for (const e of laidEdges) {
        if (!connectedIds.has(e.sourceId)) dimNodeIds.add(e.sourceId);
        if (!connectedIds.has(e.targetId)) dimNodeIds.add(e.targetId);
      }
    }

    return { groups, dimNodeIds };
  }, [laidEdges, focusId, rootId]);

  const bounds = useMemo(() => {
    if (laidNodes.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of laidNodes) {
      const x1 = n.cx - n.w / 2, y1 = n.cy - n.h / 2;
      const x2 = n.cx + n.w / 2, y2 = n.cy + n.h / 2;
      if (x1 < minX) minX = x1;
      if (y1 < minY) minY = y1;
      if (x2 > maxX) maxX = x2;
      if (y2 > maxY) maxY = y2;
    }
    return { minX, minY, maxX, maxY };
  }, [laidNodes]);

  // Auto-fit + focus pan (merged into one effect to reduce effect count).
  // Auto-fit runs once per unique (nodeCount, viewport size) to center the
  // whole graph. Focus pan runs on explicit type selection in the tree.
  const fittedKey = useRef("");
  const FOCUS_MIN_ZOOM = 0.9;
  useEffect(() => {
    if (laidNodes.length === 0 || size.w <= 1) return;
    // Auto-fit: only fires when the key changes (new layout or resize)
    const key = `${laidNodes.length}:${Math.round(size.w)}:${Math.round(size.h)}`;
    if (fittedKey.current !== key) {
      fittedKey.current = key;
      const pad = 80;
      const gW = bounds.maxX - bounds.minX + pad * 2;
      const gH = bounds.maxY - bounds.minY + pad * 2;
      const k = Math.min(size.w / gW, size.h / gH, 1.4);
      const cx = (bounds.minX + bounds.maxX) / 2;
      const cy = (bounds.minY + bounds.maxY) / 2;
      viewRef.current = { x: size.w / 2 - cx * k, y: size.h / 2 - cy * k, k };
    }
    // Focus pan: centers + zooms to the focused type
    if (focusId && focusId !== rootId) {
      const n = nodeById.get(focusId);
      if (n) {
        const v = viewRef.current;
        const k = Math.max(v.k, FOCUS_MIN_ZOOM);
        viewRef.current = {
          k,
          x: size.w / 2 - n.cx * k,
          y: size.h / 2 - n.cy * k,
        };
      }
    }
  }, [laidNodes, size, bounds, focusId, nodeById]);

  // Wheel zoom
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const scale = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const v = viewRef.current;
      const k = Math.max(0.05, Math.min(4, v.k * scale));
      const ratio = k / v.k;
      viewRef.current = { k, x: mx - (mx - v.x) * ratio, y: my - (my - v.y) * ratio };
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Hit-testing helpers
  const screenToWorld = (clientX: number, clientY: number): Point | null => {
    const el = containerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const v = viewRef.current;
    return {
      x: (clientX - rect.left - v.x) / v.k,
      y: (clientY - rect.top - v.y) / v.k,
    };
  };

  const hitTestField = (
    worldX: number,
    worldY: number,
  ): { nodeId: string; fieldIndex: number; navigableTarget: string | null; isRelayHover: boolean } | null => {
    for (const n of laidNodes) {
      const left = n.cx - n.w / 2;
      const right = n.cx + n.w / 2;
      const top = n.cy - n.h / 2;
      const bottom = n.cy + n.h / 2;
      if (worldX < left || worldX > right || worldY < top || worldY > bottom) continue;
      const localX = worldX - left;
      const localY = worldY - top;
      const bodyTop = HEADER_H + TOP_BODY_PAD - 2;
      if (localY < bodyTop) return null;
      const rowIdx = Math.floor((localY - bodyTop) / ROW_H);
      const data = n.data;
      if (data.kind === "Object" || data.kind === "Interface" || data.kind === "Input") {
        const f = data.fields?.[rowIdx];
        if (!f) return null;
        const nav =
          !BUILTIN_SCALARS.has(f.typeName) && nodeById.has(f.typeName) ? f.typeName : null;
        const isRelayHover = !!f.isRelayConnection && localX > n.w - 44;
        return { nodeId: n.id, fieldIndex: rowIdx, navigableTarget: nav, isRelayHover };
      }
      if (data.kind === "Union") {
        const m = data.members?.[rowIdx];
        if (!m) return null;
        const nav = !BUILTIN_SCALARS.has(m) && nodeById.has(m) ? m : null;
        return { nodeId: n.id, fieldIndex: rowIdx, navigableTarget: nav, isRelayHover: false };
      }
      if (data.kind === "Enum") {
        const v = data.values?.[rowIdx];
        if (!v) return null;
        return { nodeId: n.id, fieldIndex: rowIdx, navigableTarget: null, isRelayHover: false };
      }
      return null;
    }
    return null;
  };

  const hitTestFieldTarget = (worldX: number, worldY: number): string | null =>
    hitTestField(worldX, worldY)?.navigableTarget ?? null;

  const hitTestNodeHeader = (worldX: number, worldY: number): string | null => {
    for (const n of laidNodes) {
      const left = n.cx - n.w / 2;
      const right = n.cx + n.w / 2;
      const top = n.cy - n.h / 2;
      if (worldX >= left && worldX <= right && worldY >= top && worldY <= top + HEADER_H) {
        return n.id;
      }
    }
    return null;
  };

  const hitTestNode = (worldX: number, worldY: number): string | null => {
    for (const n of laidNodes) {
      if (
        worldX >= n.cx - n.w / 2 &&
        worldX <= n.cx + n.w / 2 &&
        worldY >= n.cy - n.h / 2 &&
        worldY <= n.cy + n.h / 2
      ) return n.id;
    }
    return null;
  };

  const onMouseDown = (e: React.MouseEvent) => {
    dragRef.current = {
      active: true,
      lastX: e.clientX,
      lastY: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const drag = dragRef.current;
    if (drag.active) {
      const dx = e.clientX - drag.lastX;
      const dy = e.clientY - drag.lastY;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      if (
        Math.abs(e.clientX - drag.startX) > CLICK_DRAG_THRESHOLD ||
        Math.abs(e.clientY - drag.startY) > CLICK_DRAG_THRESHOLD
      ) {
        drag.moved = true;
      }
      const v = viewRef.current;
      viewRef.current = { ...v, x: v.x + dx, y: v.y + dy };
      return;
    }
    const world = screenToWorld(e.clientX, e.clientY);
    if (!world) {
      hoveredFieldRef.current = null;
      return;
    }
    const hit = hitTestField(world.x, world.y);
    const hoveredNode = hitTestNode(world.x, world.y);
    if (onNavigate) setCursor(hit?.navigableTarget ? "pointer" : "grab");
    const prev = hoveredFieldRef.current;
    const same =
      prev !== null &&
      hit !== null &&
      prev.nodeId === hit.nodeId &&
      prev.fieldIndex === hit.fieldIndex &&
      prev.isRelayHover === hit.isRelayHover;
    if (!same) {
      hoveredFieldRef.current = hit
        ? { nodeId: hit.nodeId, fieldIndex: hit.fieldIndex, isRelayHover: hit.isRelayHover }
        : null;
    }
    hoveredNodeRef.current = hoveredNode;
  };

  const endDrag = () => {
    dragRef.current.active = false;
    hoveredFieldRef.current = null;
    hoveredNodeRef.current = null;
  };

  const onClick = (e: React.MouseEvent) => {
    if (dragRef.current.moved) return;
    const world = screenToWorld(e.clientX, e.clientY);
    if (!world) return;
    const fieldHit = hitTestFieldTarget(world.x, world.y);
    if (fieldHit) { onNavigate?.(fieldHit); return; }
    const nodeId = hitTestNodeHeader(world.x, world.y);
    if (nodeId) { onNavigate?.(nodeId); return; }
    onClearFocus?.();
  };

  // Touch gestures
  const hitTestRef = useRef(hitTestFieldTarget);
  hitTestRef.current = hitTestFieldTarget;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    type Pt = { x: number; y: number; startX: number; startY: number };
    const points = new Map<number, Pt>();
    let mode: "none" | "pan" | "pinch" = "none";
    let panMoved = false;
    let pinchStartDist = 0;
    let pinchStartK = 1;

    const enterPan = () => { mode = "pan"; panMoved = false; };
    const enterPinch = () => {
      const arr = [...points.values()];
      if (arr.length < 2) return;
      pinchStartDist = Math.hypot(arr[0]!.x - arr[1]!.x, arr[0]!.y - arr[1]!.y);
      pinchStartK = viewRef.current.k;
      mode = "pinch";
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i]!;
        points.set(t.identifier, { x: t.clientX, y: t.clientY, startX: t.clientX, startY: t.clientY });
      }
      if (points.size === 1) enterPan();
      else if (points.size >= 2) enterPinch();
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
      const before = new Map<number, { x: number; y: number }>();
      for (const [id, p] of points) before.set(id, { x: p.x, y: p.y });
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i]!;
        const existing = points.get(t.identifier);
        if (!existing) continue;
        existing.x = t.clientX;
        existing.y = t.clientY;
      }
      if (mode === "pan" && points.size === 1) {
        const arr = [...points.entries()];
        const [id, pt] = arr[0]!;
        const prev = before.get(id);
        if (!prev) return;
        const dx = pt.x - prev.x;
        const dy = pt.y - prev.y;
        if (
          Math.abs(pt.x - pt.startX) > CLICK_DRAG_THRESHOLD ||
          Math.abs(pt.y - pt.startY) > CLICK_DRAG_THRESHOLD
        ) panMoved = true;
        const v = viewRef.current;
        viewRef.current = { ...v, x: v.x + dx, y: v.y + dy };
        return;
      }
      if (mode === "pinch" && points.size >= 2) {
        const arr = [...points.values()];
        const a = arr[0]!, b = arr[1]!;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchStartDist <= 0) return;
        const newK = Math.max(0.05, Math.min(4, pinchStartK * (dist / pinchStartDist)));
        const rect = el.getBoundingClientRect();
        const cx = (a.x + b.x) / 2 - rect.left;
        const cy = (a.y + b.y) / 2 - rect.top;
        const v = viewRef.current;
        const ratio = newK / v.k;
        viewRef.current = { k: newK, x: cx - (cx - v.x) * ratio, y: cy - (cy - v.y) * ratio };
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      const ended: Touch[] = [];
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i]!;
        if (points.has(t.identifier)) { ended.push(t); points.delete(t.identifier); }
      }
      if (mode === "pinch" && points.size === 1) {
        const remaining = [...points.values()][0]!;
        remaining.startX = remaining.x;
        remaining.startY = remaining.y;
        enterPan();
        return;
      }
      if (points.size === 0) {
        const wasTap = mode === "pan" && !panMoved && ended.length > 0;
        mode = "none";
        if (!wasTap) return;
        const onNav = onNavigateRef.current;
        if (!onNav) return;
        const t = ended[ended.length - 1]!;
        const rect = el.getBoundingClientRect();
        const v = viewRef.current;
        const wx = (t.clientX - rect.left - v.x) / v.k;
        const wy = (t.clientY - rect.top - v.y) / v.k;
        const hit = hitTestRef.current(wx, wy);
        if (hit) onNav(hit);
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: false });
    el.addEventListener("touchcancel", onTouchEnd, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);

  // ─── Pixi Application init ────────────────────────────────────────

  useEffect(() => {
    const mountEl = pixiContainerRef.current;
    if (!mountEl) return;

    // Cap framebuffer resolution at 2× regardless of monitor DPR. A
    // retina-3x 4K display at native resolution is a ~115 MB backbuffer
    // before any content, which alone can push the GPU process over its
    // per-tab budget and fire "Aw, Snap!" on first render.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // Use themeResolved (from React context) for the first-frame
    // background. We can't read CSS vars here because React fires
    // child effects before parent — ThemeProvider hasn't toggled the
    // .dark class on <html> yet, so getComputedStyle still returns
    // the light-mode value. The background sync effect (below) picks
    // up the real CSS var once both the app and the theme are ready.
    const initBgHex = themeResolved === "dark" ? 0x0a0a0a : 0xffffff;
    const app = new Application();

    let destroyed = false;
    app.init({
      width: size.w,
      height: size.h,
      resolution: dpr,
      autoDensity: true,
      antialias: true,
      backgroundAlpha: 1,
      backgroundColor: initBgHex,
      preference: "webgl",
    }).then(() => {
      if (destroyed) {
        app.destroy(true);
        return;
      }

      mountEl.appendChild(app.canvas as HTMLCanvasElement);

      // Scene graph
      // Build the dot grid texture immediately so the grid doesn't
      // start as a solid white Texture.WHITE covering the dark bg.
      const initMutedFg = getComputedCssVar("--muted-foreground", "#64748b");
      const initGridTex = buildDotGridTexture(cssColorToHex(initMutedFg), 0.18);
      const gridTiling = new TilingSprite({
        texture: initGridTex,
        width: size.w,
        height: size.h,
      });
      gridTiling.tileScale.set(1);

      const world = new Container();
      world.cullable = true;

      const edgeTileContainer = new Container();
      const arrowTileContainer = new Container();
      const nodeContainer = new Container();
      nodeContainer.cullable = true;
      const hoverGraphics = new Graphics();
      const focusGraphics = new Graphics();

      world.addChild(edgeTileContainer);
      world.addChild(arrowTileContainer);
      world.addChild(nodeContainer);
      world.addChild(hoverGraphics);
      world.addChild(focusGraphics);

      app.stage.addChild(gridTiling);
      app.stage.addChild(world);

      appRef.current = app;
      setAppReady(true);
      sceneRef.current = {
        gridTiling,
        world,
        edgeTileContainer,
        arrowTileContainer,
        nodeContainer,
        hoverGraphics,
        focusGraphics,
      };

      // Build one shared placeholder texture per NodeKind. Sprites at
      // chrome/bar LOD point at the matching entry so every colored
      // card shares the same upload instead of us uploading 1,400
      // of them.
      for (const kind of Object.keys(KIND_COLORS) as NodeKind[]) {
        kindTextureCacheRef.current.set(
          kind,
          buildKindPlaceholderTexture(kind),
        );
      }

      // FPS tick counter
      let fpsTimes: number[] = [];
      let lastFpsSampleAt = 0;

      app.ticker.add(() => {
        const scene = sceneRef.current;
        if (!scene.world) return;

        const v = viewRef.current;
        const sw = app.screen.width;
        const sh = app.screen.height;

        // Sync world transform
        scene.world.position.set(v.x, v.y);
        scene.world.scale.set(v.k, v.k);

        // Detect LOD change → trigger node/edge rebuild
        const newLod = computeLOD(v.k, currentLodRef.current);
        if (newLod !== currentLodRef.current) {
          currentLodRef.current = newLod;
          setLodTick((t) => t + 1);
        }

        // Sync grid tiling
        if (scene.gridTiling) {
          scene.gridTiling.width = sw;
          scene.gridTiling.height = sh;
          scene.gridTiling.tilePosition.set(v.x % 24, v.y % 24);
          scene.gridTiling.tileScale.set(v.k, v.k);
        }

        // Hover highlight
        if (scene.hoverGraphics) {
          scene.hoverGraphics.clear();
          const hoveredField = hoveredFieldRef.current;
          if (hoveredField) {
            const n = nodeByIdRef.current.get(hoveredField.nodeId);
            if (n) {
              const fgHex = cssColorToHex(getComputedCssVar("--foreground", "#0f172a"));
              const nodeLeft = n.cx - n.w / 2;
              const nodeTop = n.cy - n.h / 2;
              const bodyTop = HEADER_H + TOP_BODY_PAD - 2;
              const hy = nodeTop + bodyTop + hoveredField.fieldIndex * ROW_H;
              const hpad = 4;
              scene.hoverGraphics.roundRect(nodeLeft + hpad, hy, n.w - hpad * 2, ROW_H, 3);
              scene.hoverGraphics.fill({ color: fgHex, alpha: 0.07 });
            }
          }
        }

        // Focus + hover rings
        if (scene.focusGraphics) {
          scene.focusGraphics.clear();

          const hoveredNodeId = hoveredNodeRef.current;
          const focusIdVal = focusIdRef.current;

          if (hoveredNodeId && hoveredNodeId !== focusIdVal) {
            const n = nodeByIdRef.current.get(hoveredNodeId);
            if (n) {
              const colorStr = KIND_COLORS[n.data.kind];
              const colorHex = cssColorToHex(colorStr);
              const pad = 3;
              scene.focusGraphics.roundRect(
                n.cx - n.w / 2 - pad, n.cy - n.h / 2 - pad,
                n.w + pad * 2, n.h + pad * 2, 9,
              );
              scene.focusGraphics.stroke({ width: 1.5, color: colorHex, alpha: 0.4 });
            }
          }

          if (focusIdVal) {
            const n = nodeByIdRef.current.get(focusIdVal);
            if (n) {
              const colorStr = KIND_COLORS[n.data.kind];
              const colorHex = cssColorToHex(colorStr);

              const t = (performance.now() % 1600) / 1600;
              const ripplePad = t * 18;
              const rippleAlpha = (1 - t) * 0.6;

              scene.focusGraphics.roundRect(
                n.cx - n.w / 2 - ripplePad, n.cy - n.h / 2 - ripplePad,
                n.w + ripplePad * 2, n.h + ripplePad * 2, 6 + ripplePad,
              );
              scene.focusGraphics.stroke({ width: 2, color: colorHex, alpha: rippleAlpha });

              const pad = 3;
              scene.focusGraphics.roundRect(
                n.cx - n.w / 2 - pad, n.cy - n.h / 2 - pad,
                n.w + pad * 2, n.h + pad * 2, 9,
              );
              scene.focusGraphics.stroke({ width: 2.5, color: colorHex, alpha: 0.75 });
            }
          }
        }

        // Edge tile visibility + lazy build. Per frame: step the
        // counter, intersect each tile with the padded viewport,
        // lazy-build the tile's Graphics on first visit, and evict
        // tiles that have been off-screen for long enough to free GPU
        // memory. This is the core mobile-memory fix — a monolithic
        // Graphics holding all 10k+ edges at once overflows WebGL
        // vertex budgets on low-end devices.
        frameCounterRef.current++;
        const tiles = edgeTilesRef.current;
        if (tiles.size > 0 && scene.edgeTileContainer && scene.arrowTileContainer) {
          const viewMinX = -v.x / v.k - TILE_VIEW_PADDING;
          const viewMinY = -v.y / v.k - TILE_VIEW_PADDING;
          const viewMaxX = (sw - v.x) / v.k + TILE_VIEW_PADDING;
          const viewMaxY = (sh - v.y) / v.k + TILE_VIEW_PADDING;

          const liveGroups = edgeGroupsRef.current.groups;
          const frame = frameCounterRef.current;
          // Cap tile lazy-build time per frame. A zoom-out or sudden
          // pan can pull many tiles into view at once; without this
          // budget they'd all tessellate in the same frame and drop
          // 30–60 ms. Also gated on motion settle — the same mobile
          // GPU driver that dies from rapid texture uploads also
          // dies from rapid vertex-buffer uploads during a fast pan.
          const TILE_BUILD_BUDGET_MS = 2;
          const tileStable =
            performance.now() - lastViewChangeAtRef.current >= MOTION_SETTLE_MS;
          const buildDeadline = performance.now() + TILE_BUILD_BUDGET_MS;

          for (const tile of tiles.values()) {
            const tileMinX = tile.col * TILE_SIZE;
            const tileMinY = tile.row * TILE_SIZE;
            const tileMaxX = tileMinX + TILE_SIZE;
            const tileMaxY = tileMinY + TILE_SIZE;
            const intersects = !(
              tileMaxX < viewMinX ||
              tileMinX > viewMaxX ||
              tileMaxY < viewMinY ||
              tileMinY > viewMaxY
            );

            if (intersects) {
              tile.lastSeenFrame = frame;
              if (!tile.edgeGraphics) {
                if (!tileStable) continue;
                if (performance.now() >= buildDeadline) continue;
                const built = buildEdgeTileGraphics(tile, liveGroups);
                tile.edgeGraphics = built.edge;
                tile.arrowGraphics = built.arrow;
                scene.edgeTileContainer.addChild(tile.edgeGraphics);
                scene.arrowTileContainer.addChild(tile.arrowGraphics);
              }
              tile.edgeGraphics.visible = true;
              if (tile.arrowGraphics) tile.arrowGraphics.visible = true;
            } else {
              if (tile.edgeGraphics) tile.edgeGraphics.visible = false;
              if (tile.arrowGraphics) tile.arrowGraphics.visible = false;
              if (
                tile.edgeGraphics &&
                frame - tile.lastSeenFrame > TILE_EVICT_FRAMES
              ) {
                tile.edgeGraphics.destroy();
                tile.edgeGraphics = null;
                if (tile.arrowGraphics) {
                  tile.arrowGraphics.destroy();
                  tile.arrowGraphics = null;
                }
              }
            }
          }
        }

        // Progressive sprite creation drain. The sweep below can
        // enqueue thousands of nodes needing a Sprite in one pass;
        // draining them here with a small per-frame budget keeps
        // `new Sprite` + `addChild` load bounded per frame and
        // prevents the Pixi renderer from stalling out.
        const spriteCreateQueue = spriteCreateQueueRef.current;
        if (
          spriteCreateQueue &&
          spriteCreateQueue.length > 0 &&
          scene.nodeContainer
        ) {
          const nodeContainer = scene.nodeContainer;
          const createDeadline = performance.now() + 2;
          while (
            spriteCreateQueue.length > 0 &&
            performance.now() < createDeadline
          ) {
            const node = spriteCreateQueue.pop()!;
            if (nodeSpritesRef.current.has(node.id)) continue;
            const kindTex = kindTextureCacheRef.current.get(node.data.kind);
            const sprite = new Sprite(kindTex ?? Texture.WHITE);
            sprite.position.set(node.cx - node.w / 2, node.cy - node.h / 2);
            sprite.width = node.w;
            sprite.height = node.h;
            sprite.cullable = true;
            if (!kindTex) {
              sprite.tint = cssColorToHex(KIND_COLORS[node.data.kind]);
            }
            nodeContainer.addChild(sprite);
            nodeSpritesRef.current.set(node.id, sprite);
          }
          if (spriteCreateQueue.length === 0) {
            spriteCreateQueueRef.current = null;
          }
        }

        // Sprite viewport sweep. Runs on any significant view change
        // (pan/zoom/LOD). Sprites are queued for progressive creation
        // (only for nodes currently in the padded viewport) and
        // destroyed once off-screen for SPRITE_EVICT_FRAMES — so memory
        // scales with visible area instead of total node count.
        const laidNodesLive = laidNodesRef.current;
        if (
          laidNodesLive.length > 0 &&
          spriteCtxRef.current &&
          scene.nodeContainer
        ) {
          const nodeContainer = scene.nodeContainer;
          const spriteCtx = spriteCtxRef.current;
          const lod = currentLodRef.current;
          const dpr = spriteDprForLod(lod);
          spriteDprRef.current = dpr;

          const prev = lastSpriteSweepViewRef.current;
          const viewMoved =
            Math.abs(v.x - prev.x) > 40 ||
            Math.abs(v.y - prev.y) > 40 ||
            Math.abs(v.k - prev.k) / Math.max(0.0001, prev.k) > 0.05 ||
            lod !== prev.lod;

          if (viewMoved) {
            lastSpriteSweepViewRef.current = { x: v.x, y: v.y, k: v.k, lod };
            lastViewChangeAtRef.current = performance.now();

            const vpMinX = -v.x / v.k - SPRITE_VIEW_PADDING;
            const vpMinY = -v.y / v.k - SPRITE_VIEW_PADDING;
            const vpMaxX = (sw - v.x) / v.k + SPRITE_VIEW_PADDING;
            const vpMaxY = (sh - v.y) / v.k + SPRITE_VIEW_PADDING;

            let queue = spriteBuildQueueRef.current;
            if (queue && (queue.lod !== lod || queue.dpr !== dpr)) {
              queue = null;
              spriteBuildQueueRef.current = null;
            }
            const queuedIds = queue
              ? new Set(queue.nodes.map((n) => n.id))
              : new Set<string>();

            // Iterate laidNodes (not sparse sprite map) so in-view
            // nodes without a sprite get one lazily and off-view ones
            // go away. Upfront Sprite allocation for all 1,400 nodes
            // stalled the Pixi renderer hard enough to crash the tab.
            const idsToEvict = new Set<string>();
            for (const node of laidNodesLive) {
              const inView = !(
                node.cx + node.w / 2 < vpMinX ||
                node.cx - node.w / 2 > vpMaxX ||
                node.cy + node.h / 2 < vpMinY ||
                node.cy - node.h / 2 > vpMaxY
              );
              const id = node.id;
              let sprite = nodeSpritesRef.current.get(id);

              if (inView) {
                if (!sprite) {
                  // Defer to the progressive create queue. Allocating
                  // here would synchronously spawn N sprites when the
                  // viewport first covers a big grid.
                  if (!spriteCreateQueueRef.current) {
                    spriteCreateQueueRef.current = [];
                  }
                  spriteCreateQueueRef.current.push(node);
                  spriteLastSeenFrameRef.current.set(
                    id,
                    frameCounterRef.current,
                  );
                  continue;
                }
                spriteLastSeenFrameRef.current.set(id, frameCounterRef.current);
                // Non-full LOD: show the shared per-kind placeholder.
                // Six uploads total, reused across every sprite of the
                // same kind — cheap and gives a proper card silhouette
                // instead of the old solid tinted rectangle.
                if (lod !== "full") {
                  const kindTex = kindTextureCacheRef.current.get(
                    node.data.kind,
                  );
                  if (kindTex && sprite.texture !== kindTex) {
                    sprite.texture = kindTex;
                    sprite.tint = 0xffffff;
                  }
                  continue;
                }
                const key = `${id}:${lod}`;
                const cachedTex = textureCacheRef.current.get(key);
                if (cachedTex) {
                  if (sprite.texture !== cachedTex) {
                    sprite.texture = cachedTex;
                    sprite.tint = 0xffffff;
                  }
                } else if (!queuedIds.has(id)) {
                  if (!spriteBuildQueueRef.current) {
                    spriteBuildQueueRef.current = {
                      nodes: [],
                      lod,
                      dpr,
                      spriteCtx,
                      dimNodeIds: new Set<string>(),
                    };
                  }
                  spriteBuildQueueRef.current.nodes.push(node);
                  queuedIds.add(id);
                }
              } else if (sprite) {
                const last = spriteLastSeenFrameRef.current.get(id) ?? 0;
                if (frameCounterRef.current - last > SPRITE_EVICT_FRAMES) {
                  idsToEvict.add(id);
                  nodeContainer.removeChild(sprite);
                  sprite.destroy();
                  nodeSpritesRef.current.delete(id);
                  spriteLastSeenFrameRef.current.delete(id);
                }
              }
            }

            // Second pass: single scan over the texture cache — drop
            // keys whose id prefix is in the evict set. Safe to delete
            // during Map iteration; V8 skips removed unvisited entries.
            if (idsToEvict.size > 0) {
              for (const key of textureCacheRef.current.keys()) {
                const sep = key.indexOf(":");
                if (sep < 0) continue;
                const ownerId = key.slice(0, sep);
                if (idsToEvict.has(ownerId)) {
                  const tex = textureCacheRef.current.get(key);
                  if (tex) tex.destroy(true);
                  textureCacheRef.current.delete(key);
                }
              }
            }
          }
        }

        // Progressive sprite building — drain the queue a few nodes
        // per frame (4ms budget). Gated on view stability: while the
        // user is actively panning or zooming, a steady stream of
        // `Texture.from(canvas)` uploads crashes mobile GPU drivers,
        // so we wait for MOTION_SETTLE_MS of no significant view
        // change before resuming. Sprites stay on their tint
        // placeholder until then.
        const buildQ = spriteBuildQueueRef.current;
        const motionStable =
          performance.now() - lastViewChangeAtRef.current >= MOTION_SETTLE_MS;
        if (buildQ && buildQ.nodes.length > 0 && motionStable) {
          const deadline = performance.now() + 4;
          const lodCap = maxTextureCacheFor(buildQ.lod);
          while (buildQ.nodes.length > 0 && performance.now() < deadline) {
            if (textureCacheRef.current.size >= lodCap) break;
            const n = buildQ.nodes.pop()!;
            const key = `${n.id}:${buildQ.lod}`;
            if (textureCacheRef.current.has(key)) continue;

            const pw = Math.ceil(n.w * buildQ.dpr);
            const ph = Math.ceil(n.h * buildQ.dpr);
            const can = document.createElement("canvas");
            can.width = pw;
            can.height = ph;
            const c2d = can.getContext("2d");
            if (c2d) {
              c2d.setTransform(buildQ.dpr, 0, 0, buildQ.dpr, 0, 0);
              drawNodeSprite(c2d, n, buildQ.spriteCtx, buildQ.lod);
              const tex = Texture.from(can);
              textureCacheRef.current.set(key, tex);
              const spr = nodeSpritesRef.current.get(n.id);
              if (spr) {
                spr.texture = tex;
                spr.tint = 0xffffff;
              }
            }
          }
          if (buildQ.nodes.length === 0) {
            // Drain complete: every sprite currently in view has a
            // texture for `buildQ.lod`. Any cached texture keyed to a
            // different LOD is unused by live sprites, so release it
            // to cap GPU memory during LOD zigzags (zoom-in, zoom-out,
            // zoom-in again without pause). The viewport sweep handles
            // the orthogonal case — sprites that stayed off-screen.
            const keepSuffix = `:${buildQ.lod}`;
            const toDelete: string[] = [];
            for (const key of textureCacheRef.current.keys()) {
              if (!key.endsWith(keepSuffix)) toDelete.push(key);
            }
            for (const key of toDelete) {
              const tex = textureCacheRef.current.get(key);
              if (tex) tex.destroy(true);
              textureCacheRef.current.delete(key);
            }
            spriteBuildQueueRef.current = null;
          }
        }

        // FPS sampling
        const now = performance.now();
        fpsTimes.push(now);
        let lo = 0;
        while (lo < fpsTimes.length && now - fpsTimes[lo]! > 1000) lo++;
        if (lo > 0) fpsTimes.splice(0, lo);
        if (now - lastFpsSampleAt >= 200) {
          lastFpsSampleAt = now;
          const fps = fpsTimes.length;
          setFpsDisplay(fps);
          const hist = fpsHistoryRef.current;
          hist.push(fps);
          if (hist.length > 60) hist.shift();
          // Draw chart directly — no React re-render needed.
          const cc = chartCanvasRef.current;
          if (cc) {
            const cw = cc.width;
            const ch = cc.height;
            const cctx = cc.getContext("2d");
            if (cctx) {
              cctx.clearRect(0, 0, cw, ch);
              const maxFps = 65;
              const barW = cw / hist.length;
              for (let i = 0; i < hist.length; i++) {
                const v = hist[i]!;
                const bh = Math.max(1, (v / maxFps) * ch);
                const isLow = v < 30;
                cctx.fillStyle = isLow ? "rgba(248,113,113,0.7)" : "rgba(148,163,184,0.35)";
                cctx.fillRect(i * barW, ch - bh, Math.max(1, barW - 1), bh);
              }
            }
          }
        }
      });
    });

    return () => {
      destroyed = true;
      const app = appRef.current;
      if (app) {
        app.destroy(true, { children: true, texture: true });
        appRef.current = null;
      }
      sceneRef.current = {
        gridTiling: null,
        world: null,
        edgeTileContainer: null,
        arrowTileContainer: null,
        nodeContainer: null,
        hoverGraphics: null,
        focusGraphics: null,
      };
      // Explicit tile cache teardown. Pixi destroys Graphics children
      // via app.destroy, but holding stale references in the ref would
      // leak when the component remounts.
      edgeTilesRef.current.clear();
      for (const tex of kindTextureCacheRef.current.values()) {
        tex.destroy(true);
      }
      kindTextureCacheRef.current.clear();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep focusId accessible in the ticker without re-init
  const focusIdRef = useRef(focusId ?? null);
  focusIdRef.current = focusId ?? null;

  // Keep nodeById accessible in the ticker
  const nodeByIdRef = useRef(nodeById);
  nodeByIdRef.current = nodeById;

  // Keep `laidNodes` accessible in the ticker without re-adding the
  // ticker callback each render — the ticker is registered once and
  // captures its surrounding closure's `laidNodes` value (initially
  // empty), so state updates need this ref to be seen.
  const laidNodesRef = useRef(laidNodes);
  laidNodesRef.current = laidNodes;

  // Resize Pixi renderer
  useEffect(() => {
    const app = appRef.current;
    if (!app || size.w <= 1 || size.h <= 1) return;
    app.renderer.resize(size.w, size.h);
    const scene = sceneRef.current;
    if (scene.gridTiling) {
      scene.gridTiling.width = size.w;
      scene.gridTiling.height = size.h;
    }
  }, [size]);

  // Rebuild dot grid texture when theme changes
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene.gridTiling) return;
    const mutedFg = getComputedCssVar("--muted-foreground", "#64748b");
    const mutedHex = cssColorToHex(mutedFg);
    const tex = buildDotGridTexture(mutedHex, 0.18);
    scene.gridTiling.texture = tex;
    scene.gridTiling.tileScale.set(1);
  }, [themeResolved]);

  // Keep a reference to the latest edgeGroups (with colors/dashes) so
  // the ticker can rebuild a tile's Graphics on demand without closing
  // over a stale effect value.
  const edgeGroupsRef = useRef(edgeGroups);
  edgeGroupsRef.current = edgeGroups;

  // Rebuild tile assignments when the edge set or focus-dim state
  // changes. This only touches the in-memory grouping structure —
  // Graphics objects themselves are destroyed and recreated lazily by
  // the ticker as tiles come into view.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene.edgeTileContainer || !scene.arrowTileContainer) return;

    // Drop old tile Graphics. New grouping means existing vertex
    // buffers are invalid.
    for (const tile of edgeTilesRef.current.values()) {
      tile.edgeGraphics?.destroy();
      tile.arrowGraphics?.destroy();
    }
    edgeTilesRef.current.clear();
    scene.edgeTileContainer.removeChildren();
    scene.arrowTileContainer.removeChildren();

    const lod = currentLodRef.current;
    if (lod === "chrome") return;

    const groupCount = edgeGroups.groups.length;
    const assign = (edge: LaidEdge, gi: number, isActive: boolean) => {
      const minCol = Math.floor(edge.bbox.minX / TILE_SIZE);
      const maxCol = Math.floor(edge.bbox.maxX / TILE_SIZE);
      const minRow = Math.floor(edge.bbox.minY / TILE_SIZE);
      const maxRow = Math.floor(edge.bbox.maxY / TILE_SIZE);
      for (let c = minCol; c <= maxCol; c++) {
        for (let r = minRow; r <= maxRow; r++) {
          const key = `${c},${r}`;
          let tile = edgeTilesRef.current.get(key);
          if (!tile) {
            tile = {
              key,
              col: c,
              row: r,
              groupLists: Array.from({ length: groupCount }, () => ({
                dim: [],
                active: [],
              })),
              edgeGraphics: null,
              arrowGraphics: null,
              lastSeenFrame: 0,
            };
            edgeTilesRef.current.set(key, tile);
          }
          const list = tile.groupLists[gi]!;
          if (isActive) list.active.push(edge);
          else list.dim.push(edge);
        }
      }
    };

    edgeGroups.groups.forEach((group, gi) => {
      for (const e of group.dim) assign(e, gi, false);
      for (const e of group.active) assign(e, gi, true);
    });
    // Deliberately omit `lodTick`: rebuilding tile assignments (and
    // destroying all live tile Graphics) on every LOD crossing was the
    // real source of the boundary frame drop — many tiles would all
    // lazy-rebuild on the next frame. The tile structure is
    // LOD-independent; only the container visibility toggles below
    // react to LOD changes.
  }, [laidEdges, edgeGroups]);

  // chrome LOD hides edges entirely. Toggle container visibility on
  // the root tile containers — no per-tile destroy/rebuild needed.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene.edgeTileContainer || !scene.arrowTileContainer) return;
    const show = currentLodRef.current !== "chrome";
    scene.edgeTileContainer.visible = show;
    scene.arrowTileContainer.visible = show;
  }, [lodTick]);

  // Effect A: sprite lifecycle reset. Runs only when the node set or
  // theme changes. Destroys any pre-existing textures and sprites so
  // the ticker's viewport sweep can rebuild from scratch — crucially,
  // we do NOT upfront-allocate the 1,400+ `new Sprite` + `addChild`
  // pairs anymore. On a big schema that synchronous loop would stall
  // the Pixi renderer hard enough to crash the tab ("GPU stall due to
  // ReadPixels"). Sprites are now created lazily per viewport sweep
  // (see ticker below), so mount stays cheap regardless of node count.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene.nodeContainer) return;

    for (const tex of textureCacheRef.current.values()) tex.destroy(true);
    textureCacheRef.current.clear();
    spriteDprRef.current = 0;

    for (const spr of nodeSpritesRef.current.values()) spr.destroy();
    nodeSpritesRef.current.clear();
    scene.nodeContainer.removeChildren();

    const cardColor = getComputedCssVar("--card", "#ffffff");
    const fgColor = getComputedCssVar("--foreground", "#0f172a");
    const mutedFg = getComputedCssVar("--muted-foreground", "#64748b");
    const spriteCtx: SpriteCtx = { cardColor, fgColor, mutedFg };
    spriteCtxRef.current = spriteCtx;

    spriteLastSeenFrameRef.current.clear();
    spriteBuildQueueRef.current = null;
    spriteCreateQueueRef.current = null;
  }, [laidNodes, themeResolved]);

  // Dim/undim node sprites when focus changes — lightweight alpha-only
  // update, no texture rebuild. Separated from the sprite build effect
  // so focus changes don't destroy+recreate all sprites (which caused
  // a visible flash as placeholders briefly appeared).
  useEffect(() => {
    const { dimNodeIds } = edgeGroups;
    const DIM = 0.1;
    for (const [id, sprite] of nodeSpritesRef.current) {
      sprite.alpha = dimNodeIds.has(id) ? DIM : 1;
    }
  }, [edgeGroups]);

  // FPS + timing overlay state
  const fpsOverlayRef = useRef<HTMLDivElement>(null);

  // Background color sync — runs on theme change AND when app first
  // becomes ready (async init may finish after the initial effect).
  useEffect(() => {
    const app = appRef.current;
    if (!app) return;
    const bgColor = getComputedCssVar("--background", "#ffffff");
    const bgHex = cssColorToHex(bgColor);
    app.renderer.background.color = bgHex;
  }, [themeResolved, appReady]);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-background"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
      onClick={onClick}
      style={{ cursor, touchAction: "none" }}
    >
      <div ref={pixiContainerRef} style={{ width: size.w, height: size.h }} />

      {isPending && (
        <div
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/60 backdrop-blur-sm"
          role="status"
          aria-live="polite"
        >
          <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card/90 px-6 py-5 shadow-lg">
            <Loader2 className="h-7 w-7 animate-spin text-primary" />
            <div className="text-sm font-medium">
              Laying out {nodes.length.toLocaleString()} types…
            </div>
            <div className="text-xs text-muted-foreground">
              Large schemas may take a few seconds.
            </div>
          </div>
        </div>
      )}

      {/* FPS overlay with real-time chart */}
      <div
        ref={fpsOverlayRef}
        className="pointer-events-none absolute bottom-4 right-4 rounded-lg border border-border/20 bg-background/10 px-3 py-2 font-mono text-xs text-muted-foreground/60 backdrop-blur-sm"
        style={{ minWidth: 280 }}
      >
        <canvas
          ref={chartCanvasRef}
          width={260}
          height={48}
          className="mb-1.5 rounded"
          style={{ width: 260, height: 48, display: "block" }}
        />
        <div className="flex items-baseline justify-between gap-4">
          <span>{fpsDisplay} fps</span>
          <span>{laidNodes.length} nodes · {laidEdges.length} edges</span>
        </div>
        {lastTiming && (
          <div className="mt-1 space-y-0.5 opacity-70">
            {lastTiming.fromCache ? (
              <div>cached · total {lastTiming.totalMs.toFixed(0)}ms</div>
            ) : (
              <>
                <div>similarity {lastTiming.similarityMs.toFixed(0)}ms max</div>
                <div>layout {lastTiming.layoutMs.toFixed(0)}ms · total {lastTiming.totalMs.toFixed(0)}ms</div>
                <div>
                  {lastTiming.componentCount} comp · {lastTiming.singletonCount} singletons · {lastTiming.parallelWorkers}w
                </div>
                {lastTiming.fallbackNodeCount > 0 && (
                  <div>fallback grid: {lastTiming.fallbackNodeCount} nodes</div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
