import { Application, Container, Graphics, Sprite, Texture, TilingSprite } from "pixi.js";
import { Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BezierSegment, LayoutResult } from "@/lib/layout";
import type { LayoutWorkerRequest, LayoutWorkerResponse } from "@/lib/layout-worker";
import type { GraphEdgeData, GraphNodeData } from "@/lib/sdl-to-graph";
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

// LOD tiers
type SpriteLOD = "full" | "bar" | "chrome";
const LOD_FULL = 0.22;
const LOD_BAR = 0.07;

function computeLOD(viewK: number): SpriteLOD {
  if (viewK >= LOD_FULL) return "full";
  if (viewK >= LOD_BAR) return "bar";
  return "chrome";
}

const BAR_NAME_FRACS = [0.62, 0.50, 0.71, 0.55, 0.44, 0.68];
const BAR_FIELD_FRACS = [0.44, 0.36, 0.52, 0.38, 0.46, 0.32];
const BAR_TYPE_FRACS = [0.24, 0.30, 0.20, 0.27, 0.22, 0.28];

const MAX_SPRITE_DPR = 4;

function idealSpriteDpr(viewK: number): number {
  const monitorDpr =
    typeof window !== "undefined" ? Math.max(1, window.devicePixelRatio || 1) : 1;
  const needed = Math.ceil(monitorDpr * Math.max(1, viewK));
  return Math.min(MAX_SPRITE_DPR, Math.max(1, needed));
}

function memoryCappedDpr(ideal: number, nodeCount: number): number {
  if (nodeCount <= 0) return ideal;
  const cap = Math.max(1, Math.floor(Math.sqrt(1250 / nodeCount)));
  return Math.max(1, Math.min(ideal, cap));
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
  const [lastTiming, setLastTiming] = useState<LayoutWorkerResponse["timings"] | null>(null);
  const lastTimingRef = useRef<LayoutWorkerResponse["timings"] | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);

  // Pixi app + scene graph refs
  const appRef = useRef<Application | null>(null);
  const sceneRef = useRef<{
    gridTiling: TilingSprite | null;
    world: Container | null;
    edgeGraphics: Graphics | null;
    arrowGraphics: Graphics | null;
    nodeContainer: Container | null;
    hoverGraphics: Graphics | null;
    focusGraphics: Graphics | null;
  }>({
    gridTiling: null,
    world: null,
    edgeGraphics: null,
    arrowGraphics: null,
    nodeContainer: null,
    hoverGraphics: null,
    focusGraphics: null,
  });

  // Node sprite/texture cache
  const textureCacheRef = useRef(new Map<string, Texture>());
  const spriteDprRef = useRef(0);
  const nodeSpritesRef = useRef(new Map<string, Sprite>());

  // FPS state for overlay
  const [fpsDisplay, setFpsDisplay] = useState(0);

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

  // One worker per canvas instance.
  useEffect(() => {
    const worker = new Worker("/layout-worker.js", { type: "module" });
    worker.onmessage = (e: MessageEvent<LayoutWorkerResponse>) => {
      if (e.data.id !== requestIdRef.current) return;
      setLayoutResult(e.data.result);
      setLastTiming(e.data.timings);
      lastTimingRef.current = e.data.timings;
      setIsPending(false);
    };
    worker.onerror = (err) => {
      console.error("layout worker error:", err.message ?? err);
      setIsPending(false);
    };
    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (nodes.length === 0) {
      requestIdRef.current += 1;
      setLayoutResult(EMPTY_LAYOUT);
      setIsPending(false);
      return;
    }
    const worker = workerRef.current;
    if (!worker) return;
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
    const request: LayoutWorkerRequest = {
      id,
      nodes,
      edges,
      layoutNodes,
      rootId: rootId ?? null,
    };
    worker.postMessage(request);
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

  // Auto-fit
  const fittedKey = useRef("");
  useEffect(() => {
    if (laidNodes.length === 0 || size.w <= 1) return;
    const key = `${laidNodes.length}:${Math.round(size.w)}:${Math.round(size.h)}`;
    if (fittedKey.current === key) return;
    fittedKey.current = key;
    const pad = 80;
    const gW = bounds.maxX - bounds.minX + pad * 2;
    const gH = bounds.maxY - bounds.minY + pad * 2;
    const k = Math.min(size.w / gW, size.h / gH, 1.4);
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    viewRef.current = { x: size.w / 2 - cx * k, y: size.h / 2 - cy * k, k };
  }, [laidNodes, size, bounds]);

  // Focus pan + zoom
  const FOCUS_MIN_ZOOM = 0.9;
  useEffect(() => {
    if (!focusId || focusId === rootId || size.w <= 1) return;
    const n = nodeById.get(focusId);
    if (!n) return;
    const v = viewRef.current;
    const k = Math.max(v.k, FOCUS_MIN_ZOOM);
    viewRef.current = {
      k,
      x: size.w / 2 - n.cx * k,
      y: size.h / 2 - n.cy * k,
    };
  }, [focusId, nodeById, size.w, size.h]);

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

    const dpr = window.devicePixelRatio || 1;
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
      const gridTiling = new TilingSprite({
        texture: Texture.WHITE,
        width: size.w,
        height: size.h,
      });
      gridTiling.tileScale.set(1);

      const world = new Container();
      world.cullable = true;

      const edgeGraphics = new Graphics();
      const arrowGraphics = new Graphics();
      const nodeContainer = new Container();
      nodeContainer.cullable = true;
      const hoverGraphics = new Graphics();
      const focusGraphics = new Graphics();

      world.addChild(edgeGraphics);
      world.addChild(arrowGraphics);
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
        edgeGraphics,
        arrowGraphics,
        nodeContainer,
        hoverGraphics,
        focusGraphics,
      };

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
        const newLod = computeLOD(v.k);
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

        // FPS sampling
        const now = performance.now();
        fpsTimes.push(now);
        let lo = 0;
        while (lo < fpsTimes.length && now - fpsTimes[lo]! > 1000) lo++;
        if (lo > 0) fpsTimes.splice(0, lo);
        if (now - lastFpsSampleAt >= 500) {
          lastFpsSampleAt = now;
          setFpsDisplay(fpsTimes.length);
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
        edgeGraphics: null,
        arrowGraphics: null,
        nodeContainer: null,
        hoverGraphics: null,
        focusGraphics: null,
      };
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep focusId accessible in the ticker without re-init
  const focusIdRef = useRef(focusId ?? null);
  focusIdRef.current = focusId ?? null;

  // Keep nodeById accessible in the ticker
  const nodeByIdRef = useRef(nodeById);
  nodeByIdRef.current = nodeById;

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

  // Rebuild edges when laidEdges/edgeGroups change
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene.edgeGraphics || !scene.arrowGraphics) return;

    const eg = scene.edgeGraphics;
    const ag = scene.arrowGraphics;
    eg.clear();
    ag.clear();

    const lod = computeLOD(viewRef.current.k);
    if (lod === "chrome") return;

    const DIM = 0.1;
    const STROKE_W = 1.4;

    for (const g of edgeGroups.groups) {
      const colorHex = g.colorHex;

      // Dim edges
      if (g.dim.length > 0) {
        if (g.dash.length > 0) {
          for (const edge of g.dim) {
            drawDashedBezierEdge(eg, edge, g.dash, colorHex, DIM, STROKE_W);
          }
          eg.stroke({ width: STROKE_W, color: colorHex, alpha: DIM });
        } else {
          eg.beginPath();
          for (const edge of g.dim) {
            drawSolidBezierEdge(eg, edge);
          }
          eg.stroke({ width: STROKE_W, color: colorHex, alpha: DIM });
        }
        // Arrowheads for dim
        ag.beginPath();
        for (const edge of g.dim) {
          drawArrowHead(ag, edge);
        }
        ag.fill({ color: colorHex, alpha: DIM });
      }

      // Active edges
      if (g.active.length > 0) {
        if (g.dash.length > 0) {
          for (const edge of g.active) {
            drawDashedBezierEdge(eg, edge, g.dash, colorHex, 1, STROKE_W);
          }
          eg.stroke({ width: STROKE_W, color: colorHex, alpha: 1 });
        } else {
          eg.beginPath();
          for (const edge of g.active) {
            drawSolidBezierEdge(eg, edge);
          }
          eg.stroke({ width: STROKE_W, color: colorHex, alpha: 1 });
        }
        // Arrowheads for active
        ag.beginPath();
        for (const edge of g.active) {
          drawArrowHead(ag, edge);
        }
        ag.fill({ color: colorHex, alpha: 1 });
      }
    }
  }, [laidEdges, edgeGroups, lodTick]);

  // Rebuild node textures and sprites when laidNodes or theme changes
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene.nodeContainer) return;

    // Destroy old textures
    for (const tex of textureCacheRef.current.values()) {
      tex.destroy(true);
    }
    textureCacheRef.current.clear();
    spriteDprRef.current = 0;

    // Clear old sprites
    for (const spr of nodeSpritesRef.current.values()) {
      spr.destroy();
    }
    nodeSpritesRef.current.clear();
    scene.nodeContainer.removeChildren();

    const cardColor = getComputedCssVar("--card", "#ffffff");
    const fgColor = getComputedCssVar("--foreground", "#0f172a");
    const mutedFg = getComputedCssVar("--muted-foreground", "#64748b");
    const spriteCtx: SpriteCtx = { cardColor, fgColor, mutedFg };

    const viewK = viewRef.current.k;
    const lod = computeLOD(viewK);
    const dpr = memoryCappedDpr(idealSpriteDpr(viewK), laidNodes.length);
    spriteDprRef.current = dpr;

    const { dimNodeIds } = edgeGroups;
    const DIM = 0.1;

    for (const n of laidNodes) {
      const key = `${n.id}:${lod}`;
      let tex = textureCacheRef.current.get(key);
      if (!tex) {
        const pw = Math.ceil(n.w * dpr);
        const ph = Math.ceil(n.h * dpr);
        const can = document.createElement("canvas");
        can.width = pw;
        can.height = ph;
        const ctx = can.getContext("2d");
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          drawNodeSprite(ctx, n, spriteCtx, lod);
          tex = Texture.from(can);
          textureCacheRef.current.set(key, tex);
        }
      }
      if (!tex) continue;

      const sprite = new Sprite(tex);
      sprite.position.set(n.cx - n.w / 2, n.cy - n.h / 2);
      sprite.width = n.w;
      sprite.height = n.h;
      sprite.alpha = dimNodeIds.has(n.id) ? DIM : 1;
      sprite.cullable = true;

      scene.nodeContainer.addChild(sprite);
      nodeSpritesRef.current.set(n.id, sprite);
    }
  }, [laidNodes, themeResolved, edgeGroups, lodTick]);

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

      {/* FPS overlay */}
      <div
        ref={fpsOverlayRef}
        className="pointer-events-none absolute bottom-4 right-4 rounded-lg border border-border/20 bg-background/10 px-3 py-2 font-mono text-xs text-muted-foreground/60 backdrop-blur-sm"
        style={{ minWidth: 120 }}
      >
        <div className="flex items-baseline justify-between gap-4">
          <span>{fpsDisplay} fps</span>
          <span>{laidNodes.length} nodes · {laidEdges.length} edges</span>
        </div>
        {lastTiming && (
          <div className="mt-1 space-y-0.5 opacity-70">
            <div>similarity {lastTiming.similarityMs.toFixed(0)}ms</div>
            <div>layout {lastTiming.layoutMs.toFixed(0)}ms · total {lastTiming.totalMs.toFixed(0)}ms</div>
          </div>
        )}
      </div>
    </div>
  );
}
