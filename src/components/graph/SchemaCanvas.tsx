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

      // Draw smooth spline through waypoints.
      drawCatmullRom(ctx, pts, 0.5);
      ctx.stroke();
      ctx.setLineDash([]);

      // Arrowhead from last segment direction.
      const last = pts[pts.length - 1]!;
      const prev = pts[pts.length - 2]!;
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
 * Orthogonal edge routing: horizontal/vertical segments through gaps
 * between node columns. Forward edges use an L/Z shape; back-edges
 * route above or below all nodes.
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
  const CLEARANCE = 30;

  if (tx > sx + 10) {
    // Forward edge: route through the horizontal gap.
    const midX = (sx + tx) / 2;

    // Check if the vertical segment at midX crosses any node.
    const minY = Math.min(sy, ty);
    const maxY = Math.max(sy, ty);
    let blocked = false;
    for (const n of allNodes) {
      if (n.id === sourceNode.id || n.id === targetNode.id) continue;
      const nLeft = n.cx - n.w / 2 - CLEARANCE;
      const nRight = n.cx + n.w / 2 + CLEARANCE;
      const nTop = n.cy - n.h / 2 - CLEARANCE;
      const nBottom = n.cy + n.h / 2 + CLEARANCE;
      if (midX >= nLeft && midX <= nRight && nTop <= maxY && nBottom >= minY) {
        blocked = true;
        break;
      }
    }

    if (!blocked) {
      return [
        { x: sx, y: sy },
        { x: midX, y: sy },
        { x: midX, y: ty },
        { x: tx, y: ty },
      ];
    }

    // Blocked: route above or below the blocking area.
    let topY = Infinity;
    let bottomY = -Infinity;
    for (const n of allNodes) {
      topY = Math.min(topY, n.cy - n.h / 2);
      bottomY = Math.max(bottomY, n.cy + n.h / 2);
    }
    const avgY = (sy + ty) / 2;
    const useTop = Math.abs(avgY - topY) < Math.abs(avgY - bottomY);
    const routeY = useTop ? topY - CLEARANCE - 20 : bottomY + CLEARANCE + 20;

    return [
      { x: sx, y: sy },
      { x: midX, y: sy },
      { x: midX, y: routeY },
      { x: midX + (tx - sx) * 0.3, y: routeY },
      { x: midX + (tx - sx) * 0.3, y: ty },
      { x: tx, y: ty },
    ];
  }

  // Back-edge or same-column: route around via top or bottom.
  let topY = Infinity;
  let bottomY = -Infinity;
  for (const n of allNodes) {
    topY = Math.min(topY, n.cy - n.h / 2);
    bottomY = Math.max(bottomY, n.cy + n.h / 2);
  }
  const avgY = (sy + ty) / 2;
  const useTop = Math.abs(avgY - topY) <= Math.abs(avgY - bottomY);
  const routeY = useTop ? topY - CLEARANCE - 30 : bottomY + CLEARANCE + 30;

  const exitX = sourceNode.cx + sourceNode.w / 2 + 20;
  const entryX = targetNode.cx - targetNode.w / 2 - 20;

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
