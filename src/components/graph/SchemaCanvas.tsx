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
  onClearFocus?: () => void;
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

// Sprite LOD: controls how much detail is baked into each sprite tier.
// "full"   – all text + icons (zoom ≥ LOD_FULL)
// "bar"    – colored placeholder bars where text would be (LOD_BAR ≤ zoom < LOD_FULL)
// "chrome" – card shape + header band only (zoom < LOD_BAR)
// Tiers are cached separately so switching zoom never discards valid entries.
type SpriteLOD = "full" | "bar" | "chrome";
const LOD_FULL = 0.22; // body text (10 px) ≈ 2 CSS px below this
const LOD_BAR  = 0.07; // bars become sub-pixel below this

function computeLOD(viewK: number): SpriteLOD {
  if (viewK >= LOD_FULL) return "full";
  if (viewK >= LOD_BAR)  return "bar";
  return "chrome";
}

// Field-bar width fractions cycle through these to fake varied text lengths.
const BAR_NAME_FRACS  = [0.62, 0.50, 0.71, 0.55, 0.44, 0.68];
const BAR_FIELD_FRACS = [0.44, 0.36, 0.52, 0.38, 0.46, 0.32];
const BAR_TYPE_FRACS  = [0.24, 0.30, 0.20, 0.27, 0.22, 0.28];

// Per-node sprite DPR is decided dynamically and rebuilds when the
// user zooms in far enough that the baked bitmap would otherwise
// blur. Discrete levels (1, 2, 3, 4) keep the cache from thrashing
// while panning or making small zoom adjustments.
const MAX_SPRITE_DPR = 4;

function idealSpriteDpr(viewK: number): number {
  const monitorDpr =
    typeof window !== "undefined" ? Math.max(1, window.devicePixelRatio || 1) : 1;
  const needed = Math.ceil(monitorDpr * Math.max(1, viewK));
  return Math.min(MAX_SPRITE_DPR, Math.max(1, needed));
}

/** Caps sprite DPR so total sprite memory stays roughly bounded. */
function memoryCappedDpr(ideal: number, nodeCount: number): number {
  if (nodeCount <= 0) return ideal;
  // Back-of-envelope: assume ~220×180 px average node area, 4 bytes
  // per pixel. Target ≤ ~200 MB → dpr² ≤ 1250 / nodeCount.
  const cap = Math.max(1, Math.floor(Math.sqrt(1250 / nodeCount)));
  return Math.max(1, Math.min(ideal, cap));
}


export function SchemaCanvas({ nodes, edges, focusId, rootId, onNavigate, onClearFocus }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 1, h: 1 });
  const viewRef = useRef({ x: 0, y: 0, k: 1 });
  const fpsRef = useRef<{ times: number[]; history: number[]; lastSampleAt: number }>({
    times: [],
    history: Array<number>(40).fill(0),
    lastSampleAt: 0,
  });
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
  const hoveredFieldRef = useRef<{ nodeId: string; fieldIndex: number } | null>(null);
  const hoveredNodeRef = useRef<string | null>(null);
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
  const edgeGroups = useMemo((): EdgeGroups => {
    const buckets: [LaidEdge[], string, number[]][] = [
      [[], "#6366f1", []],   // fieldSolid
      [[], "#6366f1", [4, 3]], // fieldNullable
      [[], "#eab308", []],  // union
      [[], "#64748b", [6, 4]], // implements (muted-foreground fallback)
      [[], "#f97316", [3, 3]], // arg
    ];
    for (const e of laidEdges) {
      if (e.kind === "implements") buckets[3]![0].push(e);
      else if (e.kind === "union") buckets[2]![0].push(e);
      else if (e.kind === "arg") buckets[4]![0].push(e);
      else if (e.kind === "field" && e.nullable) buckets[1]![0].push(e);
      else buckets[0]![0].push(e);
    }
    const shouldDim = focusId && focusId !== rootId;
    const groups: EdgeGroupSpec[] = buckets.map(([edges, color, dash]) => {
      if (!shouldDim) return { color, dash, dim: [], active: edges };
      return {
        color,
        dash,
        dim: edges.filter((e) => e.sourceId !== focusId && e.targetId !== focusId),
        active: edges.filter((e) => e.sourceId === focusId || e.targetId === focusId),
      };
    });

    let dimNodeIds = new Set<string>();
    if (shouldDim && focusId) {
      const connectedIds = new Set<string>([focusId]);
      for (const e of laidEdges) {
        if (e.sourceId === focusId) connectedIds.add(e.targetId);
        else if (e.targetId === focusId) connectedIds.add(e.sourceId);
      }
      for (const e of laidEdges) {
        const src = e.sourceId, tgt = e.targetId;
        if (!connectedIds.has(src)) dimNodeIds.add(src);
        if (!connectedIds.has(tgt)) dimNodeIds.add(tgt);
      }
    }

    return { groups, dimNodeIds };
  }, [laidEdges, focusId, rootId]);

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

  // Sprite cache and DPR are managed as refs so upgrades take effect
  // in the same frame (no React state update cycle lag). The draw loop
  // computes the needed DPR on every frame and clears the cache in-place
  // when the DPR needs to rise, then rebuilds lazily from there.
  const spriteCacheRef = useRef(new Map<string, HTMLCanvasElement>());
  const spriteDprRef = useRef(0);
  useEffect(() => {
    spriteCacheRef.current.clear();
    spriteDprRef.current = 0;
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

  const hitTestField = (
    worldX: number,
    worldY: number,
  ): { nodeId: string; fieldIndex: number; navigableTarget: string | null } | null => {
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
        const nav =
          !BUILTIN_SCALARS.has(f.typeName) && nodeById.has(f.typeName) ? f.typeName : null;
        return { nodeId: n.id, fieldIndex: rowIdx, navigableTarget: nav };
      }
      if (data.kind === "Union") {
        const m = data.members?.[rowIdx];
        if (!m) return null;
        const nav = !BUILTIN_SCALARS.has(m) && nodeById.has(m) ? m : null;
        return { nodeId: n.id, fieldIndex: rowIdx, navigableTarget: nav };
      }
      if (data.kind === "Enum") {
        const v = data.values?.[rowIdx];
        if (!v) return null;
        return { nodeId: n.id, fieldIndex: rowIdx, navigableTarget: null };
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
      setViewTick((t) => t + 1);
      return;
    }
    const world = screenToWorld(e.clientX, e.clientY);
    if (!world) {
      if (hoveredFieldRef.current !== null) {
        hoveredFieldRef.current = null;
        setViewTick((t) => t + 1);
      }
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
      prev.fieldIndex === hit.fieldIndex;
    let dirty = false;
    if (!same) {
      hoveredFieldRef.current = hit ? { nodeId: hit.nodeId, fieldIndex: hit.fieldIndex } : null;
      dirty = true;
    }
    if (hoveredNodeRef.current !== hoveredNode) {
      hoveredNodeRef.current = hoveredNode;
      dirty = true;
    }
    if (dirty) setViewTick((t) => t + 1);
  };
  const endDrag = () => {
    dragRef.current.active = false;
    let dirty = false;
    if (hoveredFieldRef.current !== null) { hoveredFieldRef.current = null; dirty = true; }
    if (hoveredNodeRef.current !== null) { hoveredNodeRef.current = null; dirty = true; }
    if (dirty) setViewTick((t) => t + 1);
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

  // Draw loop. When a node is focused, run a continuous RAF loop so the
  // focus ring pulse animates smoothly. Otherwise run one-shot to avoid
  // unnecessary per-frame work during idle.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);

    const draw = () => {
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
        edgeGroups.dimNodeIds,
        hoveredNodeRef.current,
        hoveredFieldRef.current,
        spriteCacheRef.current,
        spriteDprRef,
        fpsRef,
      );
    };

    if (focusId) {
      const loop = () => {
        rafRef.current = requestAnimationFrame(loop);
        draw();
      };
      rafRef.current = requestAnimationFrame(loop);
    } else {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        draw();
      });
    }

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [laidNodes, laidEdges, edgeGroups, focusId, size, viewTick, nodeById]);

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

interface EdgeGroupSpec {
  color: string;
  dash: number[];
  dim: LaidEdge[];
  active: LaidEdge[];
}

interface EdgeGroups {
  groups: EdgeGroupSpec[];
  dimNodeIds: Set<string>;
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
  dimNodeIds: Set<string>,
  hoveredNodeId: string | null,
  hoveredField: { nodeId: string; fieldIndex: number } | null,
  spriteCache: Map<string, HTMLCanvasElement>,
  spriteDprRef: { current: number },
  fpsRef: { current: { times: number[]; history: number[]; lastSampleAt: number } },
): void {
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.ceil(size.w * dpr);
  const targetH = Math.ceil(size.h * dpr);
  if (canvas.width !== targetW) canvas.width = targetW;
  if (canvas.height !== targetH) canvas.height = targetH;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Compute the needed sprite DPR for this frame and upgrade in-place
  // if the zoom level demands sharper sprites. Clearing and rebuilding
  // happens lazily within the same frame — no React re-render required.
  const neededDpr = memoryCappedDpr(idealSpriteDpr(view.k), laidNodes.length);
  if (neededDpr > spriteDprRef.current) {
    spriteCache.clear();
    spriteDprRef.current = neededDpr;
  }
  const spriteDpr = spriteDprRef.current || neededDpr;
  const lod = computeLOD(view.k);

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

  // PASS A — edges. Skipped entirely at "chrome" LOD (nodes are solid
  // color pills; edges would only add visual noise at that scale).
  const DIM = 0.1;
  const vp: [number, number, number, number] = [vpLeft, vpTop, vpRight, vpBottom];
  if (lod !== "chrome") {
    for (const g of edgeGroups.groups) {
      drawEdgeBatch(ctx, g.dim, g.color, g.dash, ...vp, DIM);
      drawEdgeBatch(ctx, g.active, g.color, g.dash, ...vp, 1);
    }
    ctx.setLineDash([]);
  }
  void focusId; // used indirectly via edgeGroups + focus ring below

  // PASS B — nodes. One drawImage per visible node using the sprite
  // cache. Sprites carry the full card (chrome + text) at the current
  // sprite DPR level; they're rebuilt only when the zoom level rises
  // enough to warrant more resolution, so pan/zoom stays one blit per
  // node per frame.
  const spriteContext = { cardColor, fgColor, mutedFg };
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
    const sprite = getOrBuildSprite(spriteCache, n, spriteContext, spriteDpr, lod);
    if (sprite) {
      const isDim = dimNodeIds.has(n.id);
      if (isDim) ctx.globalAlpha = DIM;
      ctx.drawImage(sprite, nLeft, nTop, n.w, n.h);
      if (isDim) ctx.globalAlpha = 1;
    }
  }

  // PASS B.5 — hovered field row highlight.
  if (hoveredField) {
    const n = nodeById.get(hoveredField.nodeId);
    if (n) {
      const nodeLeft = n.cx - n.w / 2;
      const nodeTop = n.cy - n.h / 2;
      const bodyTop = HEADER_H + TOP_BODY_PAD - 2;
      const hy = nodeTop + bodyTop + hoveredField.fieldIndex * ROW_H;
      ctx.fillStyle = fgColor;
      ctx.globalAlpha = 0.07;
      const hpad = 4;
      roundRect(ctx, nodeLeft + hpad, hy, n.w - hpad * 2, ROW_H, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // PASS C — hover ring + focus ring + expanding ripple pulse.
  if (hoveredNodeId && hoveredNodeId !== focusId) {
    const n = nodeById.get(hoveredNodeId);
    if (n) {
      const color = KIND_COLORS[n.data.kind];
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.4;
      const pad = 3;
      roundRect(ctx, n.cx - n.w / 2 - pad, n.cy - n.h / 2 - pad, n.w + pad * 2, n.h + pad * 2, 9);
      ctx.stroke();
      ctx.restore();
    }
  }

  if (focusId) {
    const n = nodeById.get(focusId);
    if (n) {
      const color = KIND_COLORS[n.data.kind];

      // Ripple: t goes 0→1 over 1.6 s, then restarts.
      const t = (performance.now() % 1600) / 1600;
      const ripplePad = t * 18;
      const rippleAlpha = (1 - t) * 0.6;

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.globalAlpha = rippleAlpha;
      roundRect(
        ctx,
        n.cx - n.w / 2 - ripplePad,
        n.cy - n.h / 2 - ripplePad,
        n.w + ripplePad * 2,
        n.h + ripplePad * 2,
        6 + ripplePad,
      );
      ctx.stroke();
      ctx.restore();

      // Static base ring, always visible.
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.globalAlpha = 0.75;
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      const pad = 3;
      roundRect(
        ctx,
        n.cx - n.w / 2 - pad,
        n.cy - n.h / 2 - pad,
        n.w + pad * 2,
        n.h + pad * 2,
        9,
      );
      ctx.stroke();
      ctx.restore();
    }
  }

  ctx.restore();

  // Silence unused — keep laidEdges in scope for future hit-testing.
  void laidEdges;

  // FPS overlay — bottom-right corner, screen-space (identity transform).
  const now = performance.now();
  const fp = fpsRef.current;

  // Rolling 1-second window for current FPS.
  fp.times.push(now);
  let lo = 0;
  while (lo < fp.times.length && now - fp.times[lo]! > 1000) lo++;
  if (lo > 0) fp.times.splice(0, lo);
  const fps = fp.times.length;

  // Sample into history every 200 ms.
  if (now - fp.lastSampleAt >= 200) {
    fp.history.push(fps);
    if (fp.history.length > 40) fp.history.shift();
    fp.lastSampleAt = now;
  }

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const CHART_W = 82;
  const CHART_H = 28;
  const PAD = 8;
  const TEXT_H = 16;
  const panelW = CHART_W + PAD * 2;
  const panelH = CHART_H + TEXT_H + PAD * 2;
  const px = canvas.width  - panelW - 10;
  const py = canvas.height - panelH - 10;

  // Panel background.
  ctx.fillStyle = mutedFg;
  ctx.globalAlpha = 0.06;
  roundRect(ctx, px, py, panelW, panelH, 5);
  ctx.fill();

  // Bars.
  const maxFps = 65;
  const barW = CHART_W / fp.history.length;
  const chartX = px + PAD;
  const chartY = py + PAD;
  ctx.fillStyle = mutedFg;
  for (let i = 0; i < fp.history.length; i++) {
    const v = fp.history[i]!;
    const bh = Math.max(1, (v / maxFps) * CHART_H);
    const isLow = v < 30;
    ctx.globalAlpha = isLow ? 0.55 : 0.28;
    ctx.fillStyle = isLow ? "#f87171" : mutedFg;
    ctx.fillRect(
      chartX + i * barW,
      chartY + CHART_H - bh,
      Math.max(1, barW - 1),
      bh,
    );
  }

  // FPS text.
  ctx.font = `600 11px ${MONO}`;
  ctx.fillStyle = mutedFg;
  ctx.globalAlpha = 0.55;
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText(`${fps} fps`, px + panelW - PAD, py + panelH - PAD + 2);

  ctx.restore();
}

function drawDotGrid(
  ctx: CanvasRenderingContext2D,
  size: { w: number; h: number },
  view: { x: number; y: number; k: number },
  dotColor: string,
) {
  const dotGap = 24;
  const dotR = 1;
  const step = dotGap * view.k;
  // Below ~6 px the grid is too dense to be useful and costs ~100k fillRect calls.
  if (step < 6) return;
  const { w, h } = size;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.fillStyle = dotColor;
  ctx.globalAlpha = 0.18;
  const startX = ((view.x % step) + step) % step;
  const startY = ((view.y % step) + step) % step;
  for (let px = startX; px < w; px += step) {
    for (let py = startY; py < h; py += step) {
      ctx.fillRect(px, py, dotR, dotR);
    }
  }
  ctx.restore();
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
  alpha = 1,
) {
  if (edges.length === 0) return;

  ctx.save();
  ctx.globalAlpha = alpha;
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
  if (!anyVisible) { ctx.restore(); return; }
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
  ctx.restore();
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
  dpr: number,
  lod: SpriteLOD,
): HTMLCanvasElement | null {
  const key = `${n.id}:${lod}`;
  const existing = cache.get(key);
  if (existing) return existing;
  if (typeof document === "undefined") return null;
  const can = document.createElement("canvas");
  can.width = Math.ceil(n.w * dpr);
  can.height = Math.ceil(n.h * dpr);
  const c = can.getContext("2d");
  if (!c) return null;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawNodeSprite(c, n, ctxColors, lod);
  cache.set(key, can);
  return can;
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

  // "chrome" tier: render as a solid color pill — no card chrome, no text.
  if (lod === "chrome") {
    roundRect(ctx, 0, 0, w, h, 6);
    ctx.fillStyle = color;
    ctx.fill();
    return;
  }

  // Card background + unfocused border.
  roundRect(ctx, 0, 0, w, h, 6);
  ctx.fillStyle = cardColor;
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  ctx.globalAlpha = 0.75;
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Header band.
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

  // "bar" tier: draw placeholder bars where text would be.
  if (lod === "bar") {
    const avail = w - 16;
    // Name bar in header.
    const nFrac = BAR_NAME_FRACS[0]!;
    ctx.fillStyle = "#ffffff";
    ctx.globalAlpha = 0.55;
    roundRect(ctx, 8, 23, avail * nFrac, 5, 2.5);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Body placeholder bars: one row pair (field + type) per content row.
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
      ctx.fillStyle = "#f59e0b"; // amber-400
      ctx.globalAlpha = 0.45;
      roundRect(ctx, w - 10 - typeBarW, fy, typeBarW, 4, 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    return;
  }

  // "full" tier: kind label.
  ctx.font = `600 9px ${MONO}`;
  ctx.fillStyle = "#ffffff";
  ctx.globalAlpha = 0.6;
  ctx.fillText(n.data.kind.toUpperCase(), 8, 14);
  ctx.globalAlpha = 1;

  // "full" tier: node name.
  ctx.font = NODE_NAME_FONT;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(fitText(ctx, n.data.name, w - 16), 8, 30);

  // "full" tier: body.
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
      ctx.fillText(f.name, 10, fy);
      if (f.isRelayConnection) {
        const typeW = ctx.measureText(f.type).width;
        const iconCx = w - 10 - typeW - 8;
        drawRelayIcon(ctx, iconCx, fy - 2);
        ctx.font = `10px ${MONO}`;
      }
      drawColoredType(ctx, f.type, w - 10, fy, mutedFg);
    }
  }
}

function bodyRowCount(n: LaidNode): number {
  const d = n.data;
  if (d.kind === "Enum")   return (d.values ?? []).length;
  if (d.kind === "Union")  return (d.members ?? []).length;
  if (d.kind === "Scalar") return 1;
  return (d.fields ?? []).length;
}

// ─── Relay icon ─────────────────────────────────────────────────────

/** Draws a tiny 3-node relay network icon (8×7 px) centred at (cx, cy). */
function drawRelayIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
  ctx.save();
  const color = "#8b5cf6"; // violet-500 — relay brand color
  const r = 1.5;
  const pts = [
    { x: cx, y: cy - 3.5 },
    { x: cx - 3.5, y: cy + 2 },
    { x: cx + 3.5, y: cy + 2 },
  ];
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.8;
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  ctx.lineTo(pts[1]!.x, pts[1]!.y);
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  ctx.lineTo(pts[2]!.x, pts[2]!.y);
  ctx.moveTo(pts[1]!.x, pts[1]!.y);
  ctx.lineTo(pts[2]!.x, pts[2]!.y);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
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
