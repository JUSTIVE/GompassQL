import { Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BezierSegment, LayoutResult } from "@/lib/layout";
import type { LayoutWorkerRequest, LayoutWorkerResponse } from "@/lib/layout-worker";
import type { GraphEdgeData, GraphNodeData } from "@/lib/sdl-to-graph";
import { useTheme } from "@/lib/theme";
import { colorizeType } from "@/lib/type-colors";
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
 * Canvas-based schema graph renderer.
 *
 * Rendering is structured for throughput on hundreds of nodes:
 *
 *   • Layout runs off the main thread in a worker; only positions/
 *     beziers come back. No React reconciliation per node.
 *   • Each node card (background + header + kind label + name + field
 *     rows) is pre-rendered once to its own offscreen canvas — per-node
 *     sprite caching. The main draw loop blits the sprite with a single
 *     `drawImage` per visible node instead of 30+ `fillText` calls.
 *     Cache is invalidated on theme change or new layout.
 *   • Edges are batched by (color, dash) into four groups. Each group
 *     draws with one `beginPath`, one `setLineDash`, one `stroke` and
 *     one `fill` — draw calls and context-state changes scale with the
 *     number of distinct styles, not with the number of edges.
 *   • Viewport culling skips invisible nodes and edges (bbox test) so
 *     only what's on-screen pays the draw cost.
 *   • View changes (pan / zoom / focus) go through a `requestAnimation-
 *     Frame`-coalesced path so rapid events don't stack up redraws.
 *   • Canvas resolution is re-set only when the element actually
 *     resizes; each draw reuses the existing backing store and skips
 *     allocation churn.
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
}

const BUILTIN_SCALARS = new Set(["String", "Int", "Float", "Boolean", "ID"]);
const CLICK_DRAG_THRESHOLD = 4;

function getComputedCssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return val || fallback;
}

const EMPTY_LAYOUT: LayoutResult = { nodes: [], edgePaths: [] };
const CULL_PAD = 100;
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

// Per-node sprite DPR. Matches the window's DPR so text stays sharp,
// capped at 2× to keep worst-case memory bounded (400 nodes × 220×200 ×
// 4 bytes × 4 ≈ 140MB at DPR=2; higher DPR rarely looks better on text).
function spriteDpr(): number {
  if (typeof window === "undefined") return 1;
  return Math.min(2, Math.max(1, window.devicePixelRatio || 1));
}

export function SchemaCanvas({ nodes, edges, focusId, rootId, onNavigate }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 1, h: 1 });
  const viewRef = useRef({ x: 0, y: 0, k: 1 });
  const [viewTick, setViewTick] = useState(0);
  const dragRef = useRef({
    active: false,
    lastX: 0,
    lastY: 0,
    startX: 0,
    startY: 0,
    moved: false,
  });
  const rafRef = useRef<number | null>(null);
  const [cursor, setCursor] = useState<"grab" | "pointer">("grab");
  const { resolved: themeResolved } = useTheme();

  // Layout runs off the main thread in a dedicated Web Worker bundled
  // separately at `/layout-worker.js`. `isPending` is true from the
  // moment a request is posted until the matching response arrives;
  // stale responses (older `id`) are discarded.
  const [layoutResult, setLayoutResult] = useState<LayoutResult>(EMPTY_LAYOUT);
  const [isPending, setIsPending] = useState(nodes.length > 0);
  const [lastTiming, setLastTiming] = useState<LayoutWorkerResponse["timings"] | null>(null);
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

  // One worker per canvas instance.
  useEffect(() => {
    const worker = new Worker("/layout-worker.js", { type: "module" });
    worker.onmessage = (e: MessageEvent<LayoutWorkerResponse>) => {
      if (e.data.id !== requestIdRef.current) return;
      setLayoutResult(e.data.result);
      setLastTiming(e.data.timings);
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
      width: estimateNodeWidth(n.name, n.fields?.map((x) => [x.name, x.typeName] as const) ?? []),
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

      // Snap forward field-edges to the field row's right edge on the
      // source node by rewriting the first bezier's start + c1 (so the
      // curve *departs* horizontally at the row, then blends back into
      // the original c2/end — no seam, no kink, single smooth bezier).
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

      // A cubic bezier's convex hull is contained in its four control
      // points, so start + every (c1, c2, end) + arrowTip is a safe
      // bounding box for culling.
      let minX = start.x,
        maxX = start.x,
        minY = start.y,
        maxY = start.y;
      for (const s of segments) {
        if (s.c1.x < minX) minX = s.c1.x;
        else if (s.c1.x > maxX) maxX = s.c1.x;
        if (s.c1.y < minY) minY = s.c1.y;
        else if (s.c1.y > maxY) maxY = s.c1.y;
        if (s.c2.x < minX) minX = s.c2.x;
        else if (s.c2.x > maxX) maxX = s.c2.x;
        if (s.c2.y < minY) minY = s.c2.y;
        else if (s.c2.y > maxY) maxY = s.c2.y;
        if (s.end.x < minX) minX = s.end.x;
        else if (s.end.x > maxX) maxX = s.end.x;
        if (s.end.y < minY) minY = s.end.y;
        else if (s.end.y > maxY) maxY = s.end.y;
      }
      if (arrowTip) {
        if (arrowTip.x < minX) minX = arrowTip.x;
        else if (arrowTip.x > maxX) maxX = arrowTip.x;
        if (arrowTip.y < minY) minY = arrowTip.y;
        else if (arrowTip.y > maxY) maxY = arrowTip.y;
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

  // Edge groups — pre-partitioned by (color, dash) so the draw loop
  // doesn't re-partition every frame. Each group renders with one
  // beginPath / one stroke / one fill call regardless of edge count.
  const edgeGroups = useMemo(() => {
    const implementsGroup: LaidEdge[] = [];
    const unionGroup: LaidEdge[] = [];
    const fieldNullable: LaidEdge[] = [];
    const fieldSolid: LaidEdge[] = [];
    for (const e of laidEdges) {
      if (e.kind === "implements") implementsGroup.push(e);
      else if (e.kind === "union") unionGroup.push(e);
      else if (e.kind === "field" && e.nullable) fieldNullable.push(e);
      else fieldSolid.push(e);
    }
    return { implementsGroup, unionGroup, fieldNullable, fieldSolid };
  }, [laidEdges]);

  const bounds = useMemo(() => {
    if (laidNodes.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of laidNodes) {
      const x1 = n.cx - n.w / 2,
        y1 = n.cy - n.h / 2;
      const x2 = n.cx + n.w / 2,
        y2 = n.cy + n.h / 2;
      if (x1 < minX) minX = x1;
      if (y1 < minY) minY = y1;
      if (x2 > maxX) maxX = x2;
      if (y2 > maxY) maxY = y2;
    }
    return { minX, minY, maxX, maxY };
  }, [laidNodes]);

  // Sprite cache — one offscreen canvas per node, rebuilt whenever a
  // new layout arrives or the theme changes. The map starts empty; the
  // draw loop populates entries lazily so invisible nodes never pay
  // the sprite-build cost. Dependencies baked into the map identity
  // means stale sprites are garbage-collected as soon as inputs change.
  const spriteCache = useMemo(() => {
    return new Map<string, HTMLCanvasElement>();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laidNodes, themeResolved]);

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

  // Focus pan + zoom. Raises zoom to a readable floor so selecting a
  // type in the tree actually looks like the canvas moved TO it.
  const FOCUS_MIN_ZOOM = 0.9;
  useEffect(() => {
    if (!focusId || size.w <= 1) return;
    const n = nodeById.get(focusId);
    if (!n) return;
    const v = viewRef.current;
    const k = Math.max(v.k, FOCUS_MIN_ZOOM);
    viewRef.current = {
      k,
      x: size.w / 2 - n.cx * k,
      y: size.h / 2 - n.cy * k,
    };
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

  const hitTestFieldTarget = (worldX: number, worldY: number): string | null => {
    for (const n of laidNodes) {
      const left = n.cx - n.w / 2;
      const right = n.cx + n.w / 2;
      const top = n.cy - n.h / 2;
      const bottom = n.cy + n.h / 2;
      if (worldX < left || worldX > right || worldY < top || worldY > bottom) continue;
      const localY = worldY - top;
      const bodyTop = HEADER_H + TOP_BODY_PAD - 2;
      if (localY < bodyTop) return null;
      const rowIdx = Math.floor((localY - bodyTop) / ROW_H);
      const data = n.data;
      if (data.kind === "Object" || data.kind === "Interface" || data.kind === "Input") {
        const f = data.fields?.[rowIdx];
        if (!f) return null;
        if (BUILTIN_SCALARS.has(f.typeName)) return null;
        return nodeById.has(f.typeName) ? f.typeName : null;
      }
      if (data.kind === "Union") {
        const m = data.members?.[rowIdx];
        if (!m) return null;
        if (BUILTIN_SCALARS.has(m)) return null;
        return nodeById.has(m) ? m : null;
      }
      return null;
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
      setViewTick((t) => t + 1);
      return;
    }
    if (!onNavigate) return;
    const world = screenToWorld(e.clientX, e.clientY);
    if (!world) return;
    const hit = hitTestFieldTarget(world.x, world.y);
    setCursor(hit ? "pointer" : "grab");
  };
  const endDrag = () => {
    dragRef.current.active = false;
  };
  const onClick = (e: React.MouseEvent) => {
    if (!onNavigate) return;
    if (dragRef.current.moved) return;
    const world = screenToWorld(e.clientX, e.clientY);
    if (!world) return;
    const hit = hitTestFieldTarget(world.x, world.y);
    if (hit) onNavigate(hit);
  };

  // Touch gestures: 1-finger pan, 2-finger pinch zoom, tap-to-navigate.
  // Refs hold the latest closures so the listener block can stay bound
  // once instead of re-attaching on every render.
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

    const enterPan = () => {
      mode = "pan";
      panMoved = false;
    };

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
        points.set(t.identifier, {
          x: t.clientX,
          y: t.clientY,
          startX: t.clientX,
          startY: t.clientY,
        });
      }
      if (points.size === 1) enterPan();
      else if (points.size >= 2) enterPinch();
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();

      // Snapshot pre-move positions so we can compute a per-finger
      // delta even when several touches move in the same frame.
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
        ) {
          panMoved = true;
        }
        const v = viewRef.current;
        viewRef.current = { ...v, x: v.x + dx, y: v.y + dy };
        setViewTick((t) => t + 1);
        return;
      }

      if (mode === "pinch" && points.size >= 2) {
        const arr = [...points.values()];
        const a = arr[0]!;
        const b = arr[1]!;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchStartDist <= 0) return;
        const newK = Math.max(0.05, Math.min(4, pinchStartK * (dist / pinchStartDist)));
        const rect = el.getBoundingClientRect();
        const cx = (a.x + b.x) / 2 - rect.left;
        const cy = (a.y + b.y) / 2 - rect.top;
        const v = viewRef.current;
        const ratio = newK / v.k;
        viewRef.current = {
          k: newK,
          x: cx - (cx - v.x) * ratio,
          y: cy - (cy - v.y) * ratio,
        };
        setViewTick((t) => t + 1);
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      const ended: Touch[] = [];
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i]!;
        if (points.has(t.identifier)) {
          ended.push(t);
          points.delete(t.identifier);
        }
      }

      // Lifting one finger of a pinch leaves us in single-finger pan
      // mode; reset the pan baseline so the next move doesn't jump.
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

  // RAF-coalesced draw. Every effect-triggering change enqueues one
  // frame; any enqueues before the frame fires collapse into that
  // frame. Prevents back-pressure during rapid pan/zoom events.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      drawFrame(
        canvas,
        ctx,
        size,
        viewRef.current,
        laidNodes,
        laidEdges,
        edgeGroups,
        nodeById,
        focusId ?? null,
        spriteCache,
      );
    });

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [laidNodes, laidEdges, edgeGroups, focusId, size, viewTick, nodeById, spriteCache]);

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
      <canvas ref={canvasRef} style={{ width: size.w, height: size.h, display: "block" }} />
      {lastTiming && (
        <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-md border border-border bg-card/90 px-2 py-1 text-xs text-muted-foreground tabular-nums shadow-sm backdrop-blur">
          layout {lastTiming.layoutMs.toFixed(0)}ms · total {lastTiming.totalMs.toFixed(0)}ms
        </div>
      )}
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

// ─── Draw frame ──────────────────────────────────────────────────────

interface EdgeGroups {
  implementsGroup: LaidEdge[];
  unionGroup: LaidEdge[];
  fieldNullable: LaidEdge[];
  fieldSolid: LaidEdge[];
}

function drawFrame(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  size: { w: number; h: number },
  view: { x: number; y: number; k: number },
  laidNodes: LaidNode[],
  laidEdges: LaidEdge[],
  edgeGroups: EdgeGroups,
  nodeById: Map<string, LaidNode>,
  focusId: string | null,
  spriteCache: Map<string, HTMLCanvasElement>,
) {
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.ceil(size.w * dpr);
  const targetH = Math.ceil(size.h * dpr);
  if (canvas.width !== targetW) canvas.width = targetW;
  if (canvas.height !== targetH) canvas.height = targetH;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const bgColor = getComputedCssVar("--background", "#ffffff");
  const cardColor = getComputedCssVar("--card", "#ffffff");
  const fgColor = getComputedCssVar("--foreground", "#0f172a");
  const mutedFg = getComputedCssVar("--muted-foreground", "#64748b");

  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, size.w, size.h);

  drawDotGrid(ctx, size, view, mutedFg);

  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.k, view.k);

  const vpLeft = -view.x / view.k;
  const vpTop = -view.y / view.k;
  const vpRight = (size.w - view.x) / view.k;
  const vpBottom = (size.h - view.y) / view.k;

  ctx.lineWidth = 1.4;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // PASS A — edges, batched by style. Each group is one beginPath/
  // stroke and one beginPath/fill regardless of member count.
  drawEdgeBatch(ctx, edgeGroups.implementsGroup, mutedFg, [6, 4], vpLeft, vpTop, vpRight, vpBottom);
  drawEdgeBatch(ctx, edgeGroups.unionGroup, "#eab308", [], vpLeft, vpTop, vpRight, vpBottom);
  drawEdgeBatch(ctx, edgeGroups.fieldNullable, "#6366f1", [4, 3], vpLeft, vpTop, vpRight, vpBottom);
  drawEdgeBatch(ctx, edgeGroups.fieldSolid, "#6366f1", [], vpLeft, vpTop, vpRight, vpBottom);
  ctx.setLineDash([]);

  // PASS B — node chrome (background, header band, border) via the
  // sprite cache. Sprites only carry vector chrome, never text — text
  // is rasterized fresh in PASS B-text below at the current zoom level
  // so glyphs stay sharp instead of upscaling a baked bitmap.
  const spriteContext = { cardColor, fgColor, mutedFg };
  const visibleNodesForFrame: LaidNode[] = [];
  for (const n of laidNodes) {
    const nLeft = n.cx - n.w / 2;
    const nRight = n.cx + n.w / 2;
    const nTop = n.cy - n.h / 2;
    const nBottom = n.cy + n.h / 2;
    if (
      nRight < vpLeft - CULL_PAD ||
      nLeft > vpRight + CULL_PAD ||
      nBottom < vpTop - CULL_PAD ||
      nTop > vpBottom + CULL_PAD
    ) {
      continue;
    }
    const sprite = getOrBuildSprite(spriteCache, n, spriteContext);
    if (sprite) ctx.drawImage(sprite, nLeft, nTop, n.w, n.h);
    visibleNodesForFrame.push(n);
  }

  // PASS B-text — node labels drawn directly under the world transform
  // so the browser anti-aliases glyphs at the final on-screen size. No
  // bitmap upscaling means text reads cleanly at any zoom level.
  for (const n of visibleNodesForFrame) {
    drawNodeText(ctx, n, fgColor, mutedFg);
  }

  // PASS C — focus ring on top.
  if (focusId) {
    const n = nodeById.get(focusId);
    if (n) {
      const color = KIND_COLORS[n.data.kind];
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      roundRect(ctx, n.cx - n.w / 2, n.cy - n.h / 2, n.w, n.h, 6);
      ctx.stroke();
    }
  }

  ctx.restore();

  // Silence unused — keep laidEdges in scope for future hit-testing.
  void laidEdges;
}

function drawDotGrid(
  ctx: CanvasRenderingContext2D,
  size: { w: number; h: number },
  view: { x: number; y: number; k: number },
  dotColor: string,
) {
  const dotGap = 24;
  const dotR = 1;
  ctx.fillStyle = dotColor;
  ctx.globalAlpha = 0.18;
  const step = dotGap * view.k;
  const startX = ((view.x % step) + step) % step;
  const startY = ((view.y % step) + step) % step;
  for (let px = startX; px < size.w; px += step) {
    for (let py = startY; py < size.h; py += step) {
      ctx.fillRect(px, py, dotR, dotR);
    }
  }
  ctx.globalAlpha = 1;
}

function drawEdgeBatch(
  ctx: CanvasRenderingContext2D,
  edges: LaidEdge[],
  color: string,
  dash: number[],
  vpLeft: number,
  vpTop: number,
  vpRight: number,
  vpBottom: number,
) {
  if (edges.length === 0) return;

  // One path for every stroke in this style group.
  ctx.strokeStyle = color;
  ctx.setLineDash(dash);
  ctx.beginPath();
  let anyVisible = false;
  for (const e of edges) {
    const bb = e.bbox;
    if (
      bb.maxX < vpLeft - CULL_PAD ||
      bb.minX > vpRight + CULL_PAD ||
      bb.maxY < vpTop - CULL_PAD ||
      bb.minY > vpBottom + CULL_PAD
    ) {
      continue;
    }
    anyVisible = true;
    ctx.moveTo(e.start.x, e.start.y);
    for (const seg of e.segments) {
      ctx.bezierCurveTo(seg.c1.x, seg.c1.y, seg.c2.x, seg.c2.y, seg.end.x, seg.end.y);
    }
    if (e.arrowTip) ctx.lineTo(e.arrowTip.x, e.arrowTip.y);
  }
  if (!anyVisible) return;
  ctx.stroke();

  // One path for every arrowhead fill in this group. Dashes don't
  // apply to fill() but reset for safety downstream.
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.beginPath();
  for (const e of edges) {
    const bb = e.bbox;
    if (
      bb.maxX < vpLeft - CULL_PAD ||
      bb.minX > vpRight + CULL_PAD ||
      bb.maxY < vpTop - CULL_PAD ||
      bb.minY > vpBottom + CULL_PAD
    ) {
      continue;
    }
    const lastSeg = e.segments[e.segments.length - 1]!;
    const tangentFrom = e.arrowTip ? lastSeg.end : lastSeg.c2;
    const tangentTo = e.arrowTip ?? lastSeg.end;
    const adx = tangentTo.x - tangentFrom.x;
    const ady = tangentTo.y - tangentFrom.y;
    const alen = Math.hypot(adx, ady);
    if (alen <= 0) continue;
    const ax = adx / alen;
    const ay = ady / alen;
    const sz = 7;
    ctx.moveTo(tangentTo.x, tangentTo.y);
    ctx.lineTo(tangentTo.x - ax * sz + ay * sz * 0.4, tangentTo.y - ay * sz - ax * sz * 0.4);
    ctx.lineTo(tangentTo.x - ax * sz - ay * sz * 0.4, tangentTo.y - ay * sz + ax * sz * 0.4);
    ctx.closePath();
  }
  ctx.fill();
}

// ─── Sprite cache ────────────────────────────────────────────────────

interface SpriteCtx {
  cardColor: string;
  fgColor: string;
  mutedFg: string;
}

function getOrBuildSprite(
  cache: Map<string, HTMLCanvasElement>,
  n: LaidNode,
  ctxColors: SpriteCtx,
): HTMLCanvasElement | null {
  const existing = cache.get(n.id);
  if (existing) return existing;
  if (typeof document === "undefined") return null;
  const dpr = spriteDpr();
  const can = document.createElement("canvas");
  can.width = Math.ceil(n.w * dpr);
  can.height = Math.ceil(n.h * dpr);
  const c = can.getContext("2d");
  if (!c) return null;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawNodeSprite(c, n, ctxColors);
  cache.set(n.id, can);
  return can;
}

function drawNodeSprite(
  ctx: CanvasRenderingContext2D,
  n: LaidNode,
  { cardColor }: SpriteCtx,
) {
  const w = n.w;
  const h = n.h;
  const color = KIND_COLORS[n.data.kind];

  // Card background + unfocused border. Focus ring is drawn on the
  // main canvas so sprites don't need to rebuild on focus change.
  roundRect(ctx, 0, 0, w, h, 6);
  ctx.fillStyle = cardColor;
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  ctx.globalAlpha = 0.75;
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Header band — rounded on top, flat on the bottom so it butts up
  // cleanly against the body separator without the subtle corner
  // curves the full rounded-rect used to leave behind.
  roundRectTopOnly(ctx, 0, 0, w, HEADER_H, 6);
  ctx.fillStyle = color;
  ctx.fill();

  // Header separator.
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = 0.75;
  ctx.beginPath();
  ctx.moveTo(0, HEADER_H);
  ctx.lineTo(w, HEADER_H);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/**
 * Draws all label text for a node in world coordinates. The caller
 * has already applied the view transform, so each glyph is rasterized
 * by the browser at its true on-screen pixel size — no bitmap blur
 * when the user zooms in.
 */
function drawNodeText(
  ctx: CanvasRenderingContext2D,
  n: LaidNode,
  fgColor: string,
  mutedFg: string,
) {
  const left = n.cx - n.w / 2;
  const top = n.cy - n.h / 2;
  const w = n.w;

  // Kind label.
  ctx.font = `600 9px ${MONO}`;
  ctx.fillStyle = "#ffffff";
  ctx.globalAlpha = 0.6;
  ctx.fillText(n.data.kind.toUpperCase(), left + 8, top + 14);
  ctx.globalAlpha = 1;

  // Name. fitText re-measures against the card's actual width so the
  // clamped MAX_WIDTH case (absurdly long names) still gets a pixel-
  // accurate ellipsis.
  ctx.font = NODE_NAME_FONT;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(fitText(ctx, n.data.name, w - 16), left + 8, top + 30);

  // Body.
  const bodyY = top + HEADER_H + TOP_BODY_PAD - 2;
  if (n.data.kind === "Enum") {
    ctx.font = `10px ${MONO}`;
    ctx.fillStyle = mutedFg;
    const values = n.data.values ?? [];
    for (let i = 0; i < values.length; i++) {
      ctx.fillText(values[i]!.name, left + 10, bodyY + i * ROW_H + 10);
    }
  } else if (n.data.kind === "Union") {
    ctx.font = `10px ${MONO}`;
    ctx.fillStyle = mutedFg;
    const members = n.data.members ?? [];
    for (let i = 0; i < members.length; i++) {
      ctx.fillText("| " + members[i]!, left + 10, bodyY + i * ROW_H + 10);
    }
  } else if (n.data.kind === "Scalar") {
    ctx.font = `italic 10px ${MONO}`;
    ctx.fillStyle = mutedFg;
    ctx.fillText("custom scalar", left + 10, bodyY + 10);
  } else {
    const fields = n.data.fields ?? [];
    ctx.font = `10px ${MONO}`;
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i]!;
      const fy = bodyY + i * ROW_H + 10;
      ctx.fillStyle = fgColor;
      ctx.fillText(f.name, left + 10, fy);
      drawColoredType(ctx, f.type, left + w - 10, fy, mutedFg);
    }
  }
}

// ─── Drawing helpers ─────────────────────────────────────────────────

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

/** Rectangle with rounded top corners and flat bottom. Used for the
 *  header band so its bottom sits flush against the body separator. */
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
  void defaultColor;
}

// function truncate(s: string, n: number) {
//   return s.length > n ? s.slice(0, n - 1) + "…" : s;
// }

/**
 * Shorten `s` to the longest prefix (+ "…") that still fits within
 * `maxWidth` pixels using the currently-set canvas font.
 */
function fitText(ctx: CanvasRenderingContext2D, s: string, maxWidth: number): string {
  if (ctx.measureText(s).width <= maxWidth) return s;
  const ellipsis = "…";
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const cand = s.slice(0, mid) + ellipsis;
    if (ctx.measureText(cand).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? s.slice(0, lo) + ellipsis : ellipsis;
}
