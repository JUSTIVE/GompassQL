import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { layoutGraph } from "@/lib/layout";
import type { GraphEdgeData, GraphNodeData } from "@/lib/sdl-to-graph";
import { computeSimilarityPairs } from "@/lib/similarity";
import { colorizeType } from "@/lib/type-colors";
import {
  HEADER_H,
  KIND_COLORS,
  KIND_COLORS_DARK,
  NODE_WIDTH,
  ROW_H,
  TOP_BODY_PAD,
  estimateNodeHeight,
} from "./node-style";

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
  points: Point[];
}

interface Props {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  focusId?: string | null;
  rootId?: string | null;
}

function rectExit(
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  dx: number,
  dy: number,
): [number, number] {
  if (dx === 0 && dy === 0) return [cx, cy];
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  const tx = absDx === 0 ? Infinity : halfW / absDx;
  const ty = absDy === 0 ? Infinity : halfH / absDy;
  const t = Math.min(tx, ty);
  return [cx + dx * t, cy + dy * t];
}

function getComputedCssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return val || fallback;
}

export function SchemaCanvas({ nodes, edges, focusId, rootId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 1, h: 1 });
  const viewRef = useRef({ x: 0, y: 0, k: 1 });
  const [viewTick, setViewTick] = useState(0);
  const dragRef = useRef({ active: false, lastX: 0, lastY: 0 });

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

  const laidNodes = useMemo<LaidNode[]>(() => {
    if (nodes.length === 0) return [];
    const input = nodes.map((n) => ({
      id: n.id,
      width: NODE_WIDTH,
      height: estimateNodeHeight(
        n.kind,
        n.fields?.length ?? 0,
        n.values?.length ?? 0,
        n.members?.length ?? 0,
      ),
    }));
    const linkInput = edges
      .filter((e) => e.source !== e.target)
      .map((e) => ({ source: e.source, target: e.target, kind: e.kind }));
    const similarityPairs = computeSimilarityPairs(nodes, edges);
    const hints = similarityPairs.map((p) => ({
      source: p.a,
      target: p.b,
      weight: p.score,
    }));
    const positioned = layoutGraph(input, linkInput, rootId ?? undefined, hints);
    const byId = new Map<string, GraphNodeData>();
    for (const n of nodes) byId.set(n.id, n);
    return positioned.map((p) => ({
      id: p.id,
      data: byId.get(p.id)!,
      cx: p.x,
      cy: p.y,
      w: p.width,
      h: p.height,
    }));
  }, [nodes, edges, rootId]);

  const nodeById = useMemo(() => {
    const m = new Map<string, LaidNode>();
    for (const n of laidNodes) m.set(n.id, n);
    return m;
  }, [laidNodes]);

  const laidEdges = useMemo<LaidEdge[]>(() => {
    const out: LaidEdge[] = [];
    for (const e of edges) {
      if (e.source === e.target) continue;
      const a = nodeById.get(e.source);
      const b = nodeById.get(e.target);
      if (!a || !b) continue;

      let sy: number;
      if (e.kind === "field" && e.sourceFieldIndex != null) {
        sy = a.cy - a.h / 2 + HEADER_H + TOP_BODY_PAD - 2 + e.sourceFieldIndex * ROW_H + 6;
      } else {
        sy = a.cy;
      }
      const sx = a.cx + a.w / 2;
      const tx = b.cx - b.w / 2;
      const ty = b.cy;

      const points = routeOrthogonal(sx, sy, tx, ty, a, b, laidNodes);
      out.push({ sourceId: e.source, targetId: e.target, kind: e.kind, nullable: e.nullable ?? false, points });
    }
    return out;
  }, [edges, nodeById, laidNodes]);

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

  // Auto-fit.
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
    setViewTick((t) => t + 1);
  }, [laidNodes, size, bounds]);

  // Focus pan.
  useEffect(() => {
    if (!focusId || size.w <= 1) return;
    const n = nodeById.get(focusId);
    if (!n) return;
    const v = viewRef.current;
    viewRef.current = { ...v, x: size.w / 2 - n.cx * v.k, y: size.h / 2 - n.cy * v.k };
    setViewTick((t) => t + 1);
  }, [focusId, nodeById, size.w, size.h]);

  // Wheel zoom.
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
      setViewTick((t) => t + 1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onMouseDown = (e: React.MouseEvent) => {
    dragRef.current = { active: true, lastX: e.clientX, lastY: e.clientY };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragRef.current.active) return;
    const dx = e.clientX - dragRef.current.lastX;
    const dy = e.clientY - dragRef.current.lastY;
    dragRef.current.lastX = e.clientX;
    dragRef.current.lastY = e.clientY;
    const v = viewRef.current;
    viewRef.current = { ...v, x: v.x + dx, y: v.y + dy };
    setViewTick((t) => t + 1);
  };
  const endDrag = () => { dragRef.current.active = false; };

  // Draw.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const bgColor = getComputedCssVar("--background", "#ffffff");
    const cardColor = getComputedCssVar("--card", "#ffffff");
    const borderColor = getComputedCssVar("--border", "#e2e8f0");
    const fgColor = getComputedCssVar("--foreground", "#0f172a");
    const mutedFg = getComputedCssVar("--muted-foreground", "#64748b");

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, size.w, size.h);

    // Dot grid pattern.
    {
      const vw = viewRef.current;
      const dotGap = 24;
      const dotR = 1;
      const dotColor = getComputedCssVar("--muted-foreground", "#94a3b8");
      ctx.fillStyle = dotColor;
      ctx.globalAlpha = 0.18;
      const startX = (vw.x % (dotGap * vw.k)) / vw.k;
      const startY = (vw.y % (dotGap * vw.k)) / vw.k;
      for (let gx = startX; gx < size.w / vw.k; gx += dotGap) {
        for (let gy = startY; gy < size.h / vw.k; gy += dotGap) {
          ctx.fillRect(gx * vw.k, gy * vw.k, dotR, dotR);
        }
      }
      ctx.globalAlpha = 1;
    }

    const v = viewRef.current;
    ctx.save();
    ctx.translate(v.x, v.y);
    ctx.scale(v.k, v.k);

    // Viewport culling: compute visible region in graph-space.
    const vpLeft = -v.x / v.k;
    const vpTop = -v.y / v.k;
    const vpRight = (size.w - v.x) / v.k;
    const vpBottom = (size.h - v.y) / v.k;
    const CULL_PAD = 100;

    const isNodeVisible = (n: LaidNode) => {
      const nLeft = n.cx - n.w / 2;
      const nRight = n.cx + n.w / 2;
      const nTop = n.cy - n.h / 2;
      const nBottom = n.cy + n.h / 2;
      return nRight >= vpLeft - CULL_PAD && nLeft <= vpRight + CULL_PAD &&
             nBottom >= vpTop - CULL_PAD && nTop <= vpBottom + CULL_PAD;
    };

    const visibleNodes = laidNodes.filter(isNodeVisible);
    const visibleNodeIds = new Set(visibleNodes.map(n => n.id));

    const isEdgeVisible = (pts: Point[]) => {
      for (const p of pts) {
        if (p.x >= vpLeft - CULL_PAD && p.x <= vpRight + CULL_PAD &&
            p.y >= vpTop - CULL_PAD && p.y <= vpBottom + CULL_PAD) return true;
      }
      return false;
    };

    // === PASS 1: Node backgrounds (cards + headers + borders) ===
    const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";
    for (const n of visibleNodes) {
      const x = n.cx - n.w / 2;
      const y = n.cy - n.h / 2;
      const color = KIND_COLORS[n.data.kind];
      const focused = n.id === focusId;

      roundRect(ctx, x, y, n.w, n.h, 6);
      ctx.fillStyle = cardColor;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = focused ? 2.5 : 1.25;
      ctx.globalAlpha = focused ? 1 : 0.75;
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.save();
      roundRect(ctx, x, y, n.w, HEADER_H, 6);
      ctx.clip();
      ctx.fillStyle = color;
      ctx.fillRect(x, y, n.w, HEADER_H);
      ctx.restore();
    }

    // === PASS 2: Edges (routed splines, on top of card backgrounds) ===
    for (const e of laidEdges) {
      if (!isEdgeVisible(e.points)) continue;
      const pts = e.points;
      if (pts.length < 2) continue;

      const stroke =
        e.kind === "implements" ? mutedFg
        : e.kind === "union" ? "#eab308"
        : "#6366f1";

      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.4;
      if (e.kind === "implements") {
        ctx.setLineDash([6, 4]);
      } else if (e.kind === "field" && e.nullable) {
        ctx.setLineDash([4, 3]);
      } else {
        ctx.setLineDash([]);
      }

      // Soften corners and draw spline. Corner-softened waypoints keep
      // the Catmull-Rom curve inside the routed corridor instead of
      // bulging toward nearby nodes.
      const softPts = softenCorners(pts, 14);
      drawCatmullRom(ctx, softPts, 0.35);
      ctx.stroke();
      ctx.setLineDash([]);

      // Arrowhead from last segment direction.
      const last = softPts[softPts.length - 1]!;
      const prev = softPts[softPts.length - 2]!;
      const adx = last.x - prev.x;
      const ady = last.y - prev.y;
      const alen = Math.hypot(adx, ady);
      if (alen > 0) {
        const ax = adx / alen;
        const ay = ady / alen;
        const sz = 7;
        ctx.fillStyle = stroke;
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(last.x - ax * sz + ay * sz * 0.4, last.y - ay * sz - ax * sz * 0.4);
        ctx.lineTo(last.x - ax * sz - ay * sz * 0.4, last.y - ay * sz + ax * sz * 0.4);
        ctx.closePath();
        ctx.fill();
      }
    }

    // === PASS 3: Node text (on top of edges) ===
    for (const n of visibleNodes) {
      const x = n.cx - n.w / 2;
      const y = n.cy - n.h / 2;
      const color = KIND_COLORS[n.data.kind];

      // Header separator.
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      ctx.moveTo(x, y + HEADER_H);
      ctx.lineTo(x + n.w, y + HEADER_H);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Kind label.
      ctx.font = `600 9px ${mono}`;
      ctx.fillStyle = "#ffffff";
      ctx.globalAlpha = 0.6;
      ctx.fillText(n.data.kind.toUpperCase(), x + 8, y + 14);
      ctx.globalAlpha = 1;

      // Name.
      ctx.font = `600 13px ${mono}`;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(truncate(n.data.name, 22), x + 8, y + 30);

      // Body.
      const bodyY = y + HEADER_H + TOP_BODY_PAD - 2;
      if (n.data.kind === "Enum") {
        ctx.font = `10px ${mono}`;
        ctx.fillStyle = mutedFg;
        for (let i = 0; i < (n.data.values?.length ?? 0); i++) {
          ctx.fillText(truncate(n.data.values![i]!, 26), x + 10, bodyY + i * ROW_H + 10);
        }
      } else if (n.data.kind === "Union") {
        ctx.font = `10px ${mono}`;
        ctx.fillStyle = mutedFg;
        for (let i = 0; i < (n.data.members?.length ?? 0); i++) {
          ctx.fillText("| " + truncate(n.data.members![i]!, 22), x + 10, bodyY + i * ROW_H + 10);
        }
      } else if (n.data.kind === "Scalar") {
        ctx.font = `italic 10px ${mono}`;
        ctx.fillStyle = mutedFg;
        ctx.fillText("custom scalar", x + 10, bodyY + 10);
      } else {
        const fields = n.data.fields ?? [];
        ctx.font = `10px ${mono}`;
        for (let i = 0; i < fields.length; i++) {
          const f = fields[i]!;
          const fy = bodyY + i * ROW_H + 10;
          ctx.fillStyle = fgColor;
          ctx.fillText(truncate(f.name, 14), x + 10, fy);
          // Colored type.
          drawColoredType(ctx, truncate(f.type, 14), x + n.w - 10, fy, mutedFg);
        }
      }
    }

    ctx.restore();
  }, [laidNodes, laidEdges, focusId, size, viewTick]);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-background"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
      style={{ cursor: "grab" }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h, display: "block" }}
      />
    </div>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
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

/**
 * Return true if the horizontal/vertical segment (ax,ay)-(bx,by)
 * intersects the expanded rectangle of any node other than src/tgt.
 * Only handles axis-aligned segments (one of the two deltas is zero).
 */
function segmentHitsAnyNode(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  src: LaidNode,
  tgt: LaidNode,
  nodes: LaidNode[],
  clearance: number,
): LaidNode | null {
  const xMin = Math.min(ax, bx);
  const xMax = Math.max(ax, bx);
  const yMin = Math.min(ay, by);
  const yMax = Math.max(ay, by);
  for (const n of nodes) {
    if (n.id === src.id || n.id === tgt.id) continue;
    const nLeft = n.cx - n.w / 2 - clearance;
    const nRight = n.cx + n.w / 2 + clearance;
    const nTop = n.cy - n.h / 2 - clearance;
    const nBottom = n.cy + n.h / 2 + clearance;
    if (xMax >= nLeft && xMin <= nRight && yMax >= nTop && yMin <= nBottom) {
      return n;
    }
  }
  return null;
}

function pathIsClear(pts: Point[], src: LaidNode, tgt: LaidNode, nodes: LaidNode[], clearance: number): boolean {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (segmentHitsAnyNode(a.x, a.y, b.x, b.y, src, tgt, nodes, clearance)) return false;
  }
  return true;
}

/**
 * Insert short waypoints on either side of each interior corner. This
 * constrains the Catmull-Rom spline so it rounds tightly inside the
 * L-corner corridor instead of bulging toward the nearest obstacle.
 */
function softenCorners(pts: Point[], radius = 14): Point[] {
  if (pts.length <= 2) return pts.slice();
  const out: Point[] = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]!;
    const cur = pts[i]!;
    const next = pts[i + 1]!;
    const dx1 = cur.x - prev.x;
    const dy1 = cur.y - prev.y;
    const d1 = Math.hypot(dx1, dy1);
    const dx2 = next.x - cur.x;
    const dy2 = next.y - cur.y;
    const d2 = Math.hypot(dx2, dy2);
    const r1 = Math.min(radius, d1 / 2.2);
    const r2 = Math.min(radius, d2 / 2.2);
    if (r1 > 1) {
      out.push({ x: cur.x - (dx1 / d1) * r1, y: cur.y - (dy1 / d1) * r1 });
    }
    out.push(cur);
    if (r2 > 1) {
      out.push({ x: cur.x + (dx2 / d2) * r2, y: cur.y + (dy2 / d2) * r2 });
    }
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

/**
 * Find a clear horizontal Y band that spans from fromX to toX, starting
 * from a preferred Y and walking outward. Returns a Y value where a
 * horizontal segment [fromX..toX] does not hit any node (other than
 * src/tgt). Falls back to routing outside the graph if no band exists.
 */
function findClearBandY(
  preferredY: number,
  fromX: number,
  toX: number,
  src: LaidNode,
  tgt: LaidNode,
  nodes: LaidNode[],
  clearance: number,
): number {
  const xMin = Math.min(fromX, toX);
  const xMax = Math.max(fromX, toX);
  // Collect Y intervals of nodes that overlap [xMin, xMax].
  const intervals: Array<[number, number]> = [];
  let globalTop = Infinity;
  let globalBottom = -Infinity;
  for (const n of nodes) {
    globalTop = Math.min(globalTop, n.cy - n.h / 2);
    globalBottom = Math.max(globalBottom, n.cy + n.h / 2);
    if (n.id === src.id || n.id === tgt.id) continue;
    const nLeft = n.cx - n.w / 2 - clearance;
    const nRight = n.cx + n.w / 2 + clearance;
    if (nRight < xMin || nLeft > xMax) continue;
    intervals.push([n.cy - n.h / 2 - clearance, n.cy + n.h / 2 + clearance]);
  }
  if (intervals.length === 0) return preferredY;

  // Merge overlapping intervals.
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) {
      last[1] = Math.max(last[1], iv[1]);
    } else {
      merged.push([iv[0], iv[1]]);
    }
  }

  // If preferred Y is already in a gap, use it.
  const inBlock = merged.find((iv) => preferredY >= iv[0] && preferredY <= iv[1]);
  if (!inBlock) return preferredY;

  // Otherwise pick the nearest gap edge: just above or just below the
  // block containing preferredY. Prefer the closer side.
  const above = inBlock[0] - clearance;
  const below = inBlock[1] + clearance;
  const aboveClear = !merged.some((iv) => iv !== inBlock && above >= iv[0] && above <= iv[1]);
  const belowClear = !merged.some((iv) => iv !== inBlock && below >= iv[0] && below <= iv[1]);
  if (aboveClear && belowClear) {
    return Math.abs(above - preferredY) <= Math.abs(below - preferredY) ? above : below;
  }
  if (aboveClear) return above;
  if (belowClear) return below;
  // Both sides abut another block — route outside the graph entirely.
  const outsideTop = globalTop - clearance - 20;
  const outsideBottom = globalBottom + clearance + 20;
  return Math.abs(outsideTop - preferredY) <= Math.abs(outsideBottom - preferredY)
    ? outsideTop
    : outsideBottom;
}

/**
 * Orthogonal edge routing: horizontal/vertical segments through gaps
 * between node columns. Searches multiple channel X positions and Y
 * bands to avoid crossing any node rectangle.
 */
function routeOrthogonal(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  sourceNode: LaidNode,
  targetNode: LaidNode,
  allNodes: LaidNode[],
): Point[] {
  const CLEARANCE = 24;

  if (tx > sx + 10) {
    // Forward edge. Try the natural midX, then walk outward to find a
    // vertical channel that's clear of all non-endpoint nodes.
    const baseMid = (sx + tx) / 2;
    const span = tx - sx;
    const maxOff = Math.max(40, span * 0.45);
    const candidates: number[] = [baseMid];
    for (let off = 30; off <= maxOff; off += 30) {
      candidates.push(baseMid - off);
      candidates.push(baseMid + off);
    }

    for (const mid of candidates) {
      if (mid <= sx + 10 || mid >= tx - 10) continue;
      const path: Point[] = [
        { x: sx, y: sy },
        { x: mid, y: sy },
        { x: mid, y: ty },
        { x: tx, y: ty },
      ];
      if (pathIsClear(path, sourceNode, targetNode, allNodes, CLEARANCE)) {
        return path;
      }
    }

    // No simple L/Z worked. Route via a clear horizontal band, picking
    // the nearest gap to the average row. Two-bend Z through that band.
    const avgY = (sy + ty) / 2;
    const bandY = findClearBandY(avgY, sx, tx, sourceNode, targetNode, allNodes, CLEARANCE);
    // Find clear midX that avoids nodes along both vertical legs.
    for (const mid of candidates) {
      if (mid <= sx + 10 || mid >= tx - 10) continue;
      const path: Point[] = [
        { x: sx, y: sy },
        { x: mid, y: sy },
        { x: mid, y: bandY },
        { x: mid + Math.sign(tx - sx) * 30, y: bandY },
        { x: mid + Math.sign(tx - sx) * 30, y: ty },
        { x: tx, y: ty },
      ];
      if (pathIsClear(path, sourceNode, targetNode, allNodes, CLEARANCE)) {
        return path;
      }
    }
    // Last resort: route around the outside.
    const exitX = sourceNode.cx + sourceNode.w / 2 + 16;
    const entryX = targetNode.cx - targetNode.w / 2 - 16;
    return [
      { x: sx, y: sy },
      { x: exitX, y: sy },
      { x: exitX, y: bandY },
      { x: entryX, y: bandY },
      { x: entryX, y: ty },
      { x: tx, y: ty },
    ];
  }

  // Back-edge or same-column: route around via top or bottom using the
  // nearest clear band rather than the full envelope.
  const avgY = (sy + ty) / 2;
  const exitX = sourceNode.cx + sourceNode.w / 2 + 20;
  const entryX = targetNode.cx - targetNode.w / 2 - 20;
  const routeY = findClearBandY(
    avgY,
    Math.min(exitX, entryX),
    Math.max(exitX, entryX),
    sourceNode,
    targetNode,
    allNodes,
    CLEARANCE,
  );
  return [
    { x: sx, y: sy },
    { x: exitX, y: sy },
    { x: exitX, y: routeY },
    { x: entryX, y: routeY },
    { x: entryX, y: ty },
    { x: tx, y: ty },
  ];
}

/**
 * Draw a Catmull-Rom spline through the given points, converted to
 * cubic bezier segments for Canvas2D. Produces a smooth C1 curve
 * that passes through every waypoint.
 */
function drawCatmullRom(
  ctx: CanvasRenderingContext2D,
  pts: Point[],
  tension = 0.5,
) {
  if (pts.length < 2) return;
  if (pts.length === 2) {
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    ctx.lineTo(pts[1]!.x, pts[1]!.y);
    return;
  }

  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(i + 2, pts.length - 1)]!;

    const t = tension;
    const cp1x = p1.x + (p2.x - p0.x) * t / 3;
    const cp1y = p1.y + (p2.y - p0.y) * t / 3;
    const cp2x = p2.x - (p3.x - p1.x) * t / 3;
    const cp2y = p2.y - (p3.y - p1.y) * t / 3;

    ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
  }
}

function drawColoredType(
  ctx: CanvasRenderingContext2D,
  typeStr: string,
  rightX: number,
  y: number,
  defaultColor: string,
) {
  const segments = colorizeType(typeStr);
  const totalWidth = ctx.measureText(typeStr).width;
  let cx = rightX - totalWidth;
  for (const seg of segments) {
    ctx.fillStyle = seg.color;
    ctx.fillText(seg.text, cx, y);
    cx += ctx.measureText(seg.text).width;
  }
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
