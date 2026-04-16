import { Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LayoutResult } from "@/lib/layout";
import type {
  LayoutWorkerRequest,
  LayoutWorkerResponse,
} from "@/lib/layout-worker";
import type { GraphEdgeData, GraphNodeData } from "@/lib/sdl-to-graph";
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

const EMPTY_LAYOUT: LayoutResult = { nodes: [], edgePaths: [] };

export function SchemaCanvas({ nodes, edges, focusId, rootId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 1, h: 1 });
  const viewRef = useRef({ x: 0, y: 0, k: 1 });
  const [viewTick, setViewTick] = useState(0);
  const dragRef = useRef({ active: false, lastX: 0, lastY: 0 });

  // Layout runs off the main thread in a Web Worker so large schemas
  // don't freeze the page. `isPending` is true from the moment a
  // request is posted until the matching response arrives; stale
  // responses (older `id`) are discarded.
  const [layoutResult, setLayoutResult] = useState<LayoutResult>(EMPTY_LAYOUT);
  const [isPending, setIsPending] = useState(nodes.length > 0);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);

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

  // One worker per canvas instance. Module-type worker so it can import
  // the layout + similarity modules directly.
  useEffect(() => {
    const worker = new Worker(new URL("@/lib/layout-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<LayoutWorkerResponse>) => {
      // Ignore results for any request that's been superseded.
      if (e.data.id !== requestIdRef.current) return;
      setLayoutResult(e.data.result);
      setIsPending(false);
    };
    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // Post a layout request whenever the input graph changes.
  useEffect(() => {
    if (nodes.length === 0) {
      // Empty input resolves instantly without a worker round-trip.
      requestIdRef.current += 1;
      setLayoutResult(EMPTY_LAYOUT);
      setIsPending(false);
      return;
    }
    const worker = workerRef.current;
    if (!worker) return;
    const layoutNodes = nodes.map((n) => ({
      id: n.id,
      width: NODE_WIDTH,
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
    return layoutResult.nodes.map((p) => ({
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
    const byEdgeId = new Map<string, { waypoints: Point[] }>();
    for (const p of layoutResult.edgePaths) {
      byEdgeId.set(p.edgeId, { waypoints: p.waypoints });
    }
    const out: LaidEdge[] = [];
    for (const e of edges) {
      if (e.source === e.target) continue;
      const a = nodeById.get(e.source);
      const b = nodeById.get(e.target);
      if (!a || !b) continue;
      const path = byEdgeId.get(e.id);
      if (!path || path.waypoints.length < 2) continue;
      // Layout emits waypoints from (source.right, source.center) to
      // (target.left, target.center). For field-level edges, shift the
      // source Y so the line exits at the field row instead of the node
      // center, then reconstruct the initial horizontal segment to match.
      const points: Point[] = path.waypoints.map((p) => ({ x: p.x, y: p.y }));
      if (e.kind === "field" && e.sourceFieldIndex != null) {
        const fieldY = a.cy - a.h / 2 + HEADER_H + TOP_BODY_PAD - 2 + e.sourceFieldIndex * ROW_H + 6;
        // Replace the leading horizontal run (same y as original first
        // point) with the field-level y so the edge leaves the correct row.
        const originalStartY = points[0]!.y;
        for (let i = 0; i < points.length; i++) {
          if (points[i]!.y !== originalStartY) break;
          points[i] = { x: points[i]!.x, y: fieldY };
        }
      }
      out.push({
        sourceId: e.source,
        targetId: e.target,
        kind: e.kind,
        nullable: e.nullable ?? false,
        points,
      });
    }
    return out;
  }, [edges, layoutResult, nodeById]);

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
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      if (e.kind === "implements") {
        ctx.setLineDash([6, 4]);
      } else if (e.kind === "field" && e.nullable) {
        ctx.setLineDash([4, 3]);
      } else {
        ctx.setLineDash([]);
      }

      // Strict orthogonal polyline with rounded corners via arcTo. The
      // layout already places waypoints through clear channels, so no
      // re-routing or splining is needed here.
      drawRoundedPolyline(ctx, pts, 8);
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
 * Draw an orthogonal polyline with rounded corners using arcTo. Each
 * interior corner is softened by a radius clamped to half the shorter
 * adjacent segment so the line stays strictly inside the routed corridor.
 */
function drawRoundedPolyline(ctx: CanvasRenderingContext2D, pts: Point[], radius: number) {
  if (pts.length < 2) return;
  ctx.beginPath();
  if (pts.length === 2) {
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    ctx.lineTo(pts[1]!.x, pts[1]!.y);
    return;
  }
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]!;
    const cur = pts[i]!;
    const next = pts[i + 1]!;
    const d1 = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const d2 = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.max(0, Math.min(radius, d1 / 2, d2 / 2));
    if (r < 1) {
      ctx.lineTo(cur.x, cur.y);
    } else {
      ctx.arcTo(cur.x, cur.y, next.x, next.y, r);
    }
  }
  ctx.lineTo(pts[pts.length - 1]!.x, pts[pts.length - 1]!.y);
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
