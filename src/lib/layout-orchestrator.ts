import type { LayoutNodeInput, LayoutResult, PositionedNode } from "./layout";
import type { LayoutWorkerRequest, LayoutWorkerResponse } from "./layout-worker";
import type { GraphEdgeData, GraphNodeData } from "./sdl-to-graph";
import { weaklyConnectedComponents } from "./components";
import { cacheGet, cachePut, hashLayoutInputs } from "./layout-cache";

/**
 * Parallel layout orchestrator.
 *
 * Splits the schema into weakly-connected components — no edges cross
 * component boundaries by definition, so independent layout is correct,
 * not an approximation. Each non-trivial component is dispatched to a
 * pooled Worker running the existing layout-worker; singletons skip
 * dot entirely and get a grid layout for ~zero cost. Finally the
 * per-component bounding boxes are shelf-packed and coordinates merged.
 */

const SINGLETON_GAP = 20;
const SINGLETON_MAX_ROW_WIDTH = 1200;
const PACK_MARGIN = 80;
const FALLBACK_GRID_GAP = 40;

// Components above these thresholds skip dot entirely. GraphViz's
// rank + mincross + spline-routing stages grow super-linearly in the
// edge count specifically — spline routing on a few thousand edges
// drives the WASM heap past Chrome's renderer budget and crashes the
// tab. Node count matters less than edge count, so we gate on both.
// Over the limit: alphabetized grid on the main thread (no edges —
// navigation stays on the tree panel).
const LAYOUT_NODE_LIMIT = 500;
const LAYOUT_EDGE_LIMIT = 2000;

export interface OrchestratorTimings {
  similarityMs: number;
  layoutMs: number;
  totalMs: number;
  componentCount: number;
  parallelWorkers: number;
  singletonCount: number;
  fallbackNodeCount: number;
  fromCache: boolean;
  cacheLookupMs: number;
}

export interface OrchestratorResponse {
  id: number;
  result: LayoutResult;
  timings: OrchestratorTimings;
}

export interface OrchestratorRequest {
  id: number;
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  layoutNodes: LayoutNodeInput[];
  rootId?: string | null;
}

interface Pending {
  resolve: (r: LayoutWorkerResponse) => void;
  reject: (e: Error) => void;
}

/**
 * Main-thread fallback for oversized components. Places nodes on an
 * √n×√n grid sorted by id so users can still find types by name, and
 * returns zero edges — rendering 10k straight lines across random grid
 * positions would fill tile memory with visually meaningless spaghetti.
 */
function fallbackGridLayout(
  layoutNodes: readonly LayoutNodeInput[],
): LayoutResult {
  if (layoutNodes.length === 0) return { nodes: [], edgePaths: [] };
  const sorted = [...layoutNodes].sort((a, b) => a.id.localeCompare(b.id));
  const cols = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));

  const positioned: PositionedNode[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  let col = 0;
  for (const ln of sorted) {
    if (col >= cols) {
      y += rowH + FALLBACK_GRID_GAP;
      x = 0;
      col = 0;
      rowH = 0;
    }
    positioned.push({
      id: ln.id,
      width: ln.width,
      height: ln.height,
      x: x + ln.width / 2,
      y: y + ln.height / 2,
    });
    x += ln.width + FALLBACK_GRID_GAP;
    if (ln.height > rowH) rowH = ln.height;
    col++;
  }
  return { nodes: positioned, edgePaths: [] };
}

function layoutSingletonsGrid(
  layoutNodes: readonly LayoutNodeInput[],
): { nodes: PositionedNode[]; width: number; height: number } {
  const nodes: PositionedNode[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  let maxW = 0;
  for (const ln of layoutNodes) {
    if (x > 0 && x + ln.width > SINGLETON_MAX_ROW_WIDTH) {
      y += rowH + SINGLETON_GAP;
      x = 0;
      rowH = 0;
    }
    nodes.push({
      id: ln.id,
      width: ln.width,
      height: ln.height,
      x: x + ln.width / 2,
      y: y + ln.height / 2,
    });
    x += ln.width + SINGLETON_GAP;
    if (ln.height > rowH) rowH = ln.height;
    if (x > maxW) maxW = x;
  }
  return { nodes, width: maxW, height: y + rowH };
}

interface BoxedResult {
  result: LayoutResult;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  w: number;
  h: number;
}

function boundingBox(result: LayoutResult): BoxedResult {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of result.nodes) {
    const x1 = n.x - n.width / 2;
    const y1 = n.y - n.height / 2;
    const x2 = n.x + n.width / 2;
    const y2 = n.y + n.height / 2;
    if (x1 < minX) minX = x1;
    if (y1 < minY) minY = y1;
    if (x2 > maxX) maxX = x2;
    if (y2 > maxY) maxY = y2;
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }
  return {
    result,
    minX,
    minY,
    maxX,
    maxY,
    w: maxX - minX,
    h: maxY - minY,
  };
}

function shelfPack(boxes: BoxedResult[]): Array<{
  box: BoxedResult;
  offsetX: number;
  offsetY: number;
}> {
  // First fit decreasing height
  const sorted = [...boxes].sort((a, b) => b.h - a.h);
  const totalArea = sorted.reduce((s, b) => s + b.w * b.h, 0);
  const target = Math.max(1200, Math.sqrt(totalArea) * 1.5);

  const out: Array<{ box: BoxedResult; offsetX: number; offsetY: number }> = [];
  let shelfX = 0;
  let shelfY = 0;
  let shelfH = 0;

  for (const b of sorted) {
    if (shelfX > 0 && shelfX + b.w > target) {
      shelfY += shelfH + PACK_MARGIN;
      shelfX = 0;
      shelfH = 0;
    }
    out.push({
      box: b,
      offsetX: shelfX - b.minX,
      offsetY: shelfY - b.minY,
    });
    shelfX += b.w + PACK_MARGIN;
    if (b.h > shelfH) shelfH = b.h;
  }
  return out;
}

function mergeResults(
  placements: Array<{ box: BoxedResult; offsetX: number; offsetY: number }>,
): LayoutResult {
  const merged: LayoutResult = { nodes: [], edgePaths: [] };
  for (const { box, offsetX, offsetY } of placements) {
    for (const n of box.result.nodes) {
      merged.nodes.push({
        id: n.id,
        width: n.width,
        height: n.height,
        x: n.x + offsetX,
        y: n.y + offsetY,
      });
    }
    for (const ep of box.result.edgePaths) {
      merged.edgePaths.push({
        edgeId: ep.edgeId,
        source: ep.source,
        target: ep.target,
        start: { x: ep.start.x + offsetX, y: ep.start.y + offsetY },
        segments: ep.segments.map((s) => ({
          c1: { x: s.c1.x + offsetX, y: s.c1.y + offsetY },
          c2: { x: s.c2.x + offsetX, y: s.c2.y + offsetY },
          end: { x: s.end.x + offsetX, y: s.end.y + offsetY },
        })),
        arrowTip: ep.arrowTip
          ? { x: ep.arrowTip.x + offsetX, y: ep.arrowTip.y + offsetY }
          : undefined,
      });
    }
  }
  return merged;
}

export class LayoutOrchestrator {
  private workers: Worker[] = [];
  private freeWorkers: Worker[] = [];
  private pending = new Map<number, Pending>();
  private queue: Array<{
    req: LayoutWorkerRequest;
    resolve: Pending["resolve"];
    reject: Pending["reject"];
  }> = [];
  private nextWorkerId = 0;
  private destroyed = false;
  private onFatalError: ((e: Error) => void) | null = null;

  constructor(poolSize: number) {
    const size = Math.max(1, poolSize);
    for (let i = 0; i < size; i++) this.spawnWorker();
  }

  setFatalHandler(fn: (e: Error) => void) {
    this.onFatalError = fn;
  }

  private spawnWorker(): Worker {
    const w = new Worker("/layout-worker.js", { type: "module" });
    w.onmessage = (e: MessageEvent<LayoutWorkerResponse>) =>
      this.onMessage(w, e.data);
    w.onerror = (err) => {
      const msg = err.message ?? "layout worker error";
      this.onFatalError?.(new Error(msg));
      for (const p of this.pending.values()) p.reject(new Error(msg));
      this.pending.clear();
      this.queue = [];
    };
    this.workers.push(w);
    this.freeWorkers.push(w);
    return w;
  }

  private onMessage(w: Worker, resp: LayoutWorkerResponse) {
    if (this.destroyed) return;
    const p = this.pending.get(resp.id);
    if (p) {
      this.pending.delete(resp.id);
      p.resolve(resp);
    }
    this.freeWorkers.push(w);
    this.flushQueue();
  }

  private flushQueue() {
    while (this.queue.length > 0 && this.freeWorkers.length > 0) {
      const w = this.freeWorkers.shift()!;
      const task = this.queue.shift()!;
      this.pending.set(task.req.id, {
        resolve: task.resolve,
        reject: task.reject,
      });
      w.postMessage(task.req);
    }
  }

  private dispatch(
    payload: Omit<LayoutWorkerRequest, "id">,
  ): Promise<LayoutWorkerResponse> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextWorkerId;
      const req: LayoutWorkerRequest = { ...payload, id };
      this.queue.push({ req, resolve, reject });
      this.flushQueue();
    });
  }

  async layout(req: OrchestratorRequest): Promise<OrchestratorResponse> {
    const tStart = performance.now();

    // 0. Cache lookup. Hit returns immediately; miss falls through to
    // the full layout pipeline and we write the result back at the end.
    const cacheHash = await hashLayoutInputs({
      nodes: req.nodes,
      edges: req.edges,
      layoutNodes: req.layoutNodes,
    });
    const cached = await cacheGet(cacheHash);
    const tCacheLookupEnd = performance.now();
    if (cached) {
      return {
        id: req.id,
        result: cached,
        timings: {
          similarityMs: 0,
          layoutMs: 0,
          totalMs: +(tCacheLookupEnd - tStart).toFixed(1),
          componentCount: 0,
          singletonCount: 0,
          fallbackNodeCount: 0,
          parallelWorkers: this.workers.length,
          fromCache: true,
          cacheLookupMs: +(tCacheLookupEnd - tStart).toFixed(1),
        },
      };
    }

    // 1. Weakly-connected components
    const comps = weaklyConnectedComponents(req.nodes, req.edges);

    // 2. Partition: singletons vs multi-node components
    const layoutNodeById = new Map(req.layoutNodes.map((n) => [n.id, n]));
    const nodeById = new Map(req.nodes.map((n) => [n.id, n]));
    const singletonLayoutNodes: LayoutNodeInput[] = [];
    const multiComps: Array<{
      nodes: GraphNodeData[];
      edges: GraphEdgeData[];
      layoutNodes: LayoutNodeInput[];
    }> = [];

    // Only edges internal to a component are layout-relevant; precompute.
    const compOfNode = new Map<string, number>();
    for (let i = 0; i < comps.length; i++) {
      for (const id of comps[i]!.nodeIds) compOfNode.set(id, i);
    }

    const edgesByComp: GraphEdgeData[][] = comps.map(() => []);
    for (const e of req.edges) {
      const ci = compOfNode.get(e.source);
      if (ci == null) continue;
      if (compOfNode.get(e.target) !== ci) continue;
      edgesByComp[ci]!.push(e);
    }

    const fallbackResults: LayoutResult[] = [];
    let fallbackNodeCount = 0;

    for (let i = 0; i < comps.length; i++) {
      const comp = comps[i]!;
      if (comp.nodeIds.size === 1) {
        const id = [...comp.nodeIds][0]!;
        const ln = layoutNodeById.get(id);
        if (ln) singletonLayoutNodes.push(ln);
        continue;
      }
      const compNodeIds = [...comp.nodeIds];
      const compLayoutNodes: LayoutNodeInput[] = [];
      for (const id of compNodeIds) {
        const ln = layoutNodeById.get(id);
        if (ln) compLayoutNodes.push(ln);
      }

      const compEdgeCount = edgesByComp[i]!.length;
      if (
        comp.nodeIds.size > LAYOUT_NODE_LIMIT ||
        compEdgeCount > LAYOUT_EDGE_LIMIT
      ) {
        // Oversized component — skip dot, lay out as alphabetical grid
        // on the main thread. Prevents GraphViz's WASM heap from
        // taking the tab down on very large schemas.
        fallbackResults.push(fallbackGridLayout(compLayoutNodes));
        fallbackNodeCount += comp.nodeIds.size;
        continue;
      }

      const compNodes: GraphNodeData[] = [];
      for (const id of compNodeIds) {
        const n = nodeById.get(id);
        if (n) compNodes.push(n);
      }
      multiComps.push({
        nodes: compNodes,
        edges: edgesByComp[i]!,
        layoutNodes: compLayoutNodes,
      });
    }

    // 3. Dispatch multi-node components in parallel. Each component's
    // full `GraphNodeData[]` can be 5–10 MB on a big schema; we strip
    // it down to just the fields the worker actually needs so the
    // structured-clone into each Worker doesn't duplicate that memory.
    const tDispatchStart = performance.now();
    const compResponses = await Promise.all(
      multiComps.map((c) => {
        const knownIds = c.nodes.map((n) => n.id);
        const unions = c.nodes
          .filter((n) => n.kind === "Union")
          .map((n) => ({ id: n.id, members: n.members ?? [] }));
        const minEdges = c.edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          kind: e.kind,
        }));
        return this.dispatch({
          unions,
          knownIds,
          edges: minEdges,
          layoutNodes: c.layoutNodes,
          rootId: null,
        });
      }),
    );
    const tLayoutDone = performance.now();

    // 4. Compose boxes: multi-comp results + fallback grids + singleton grid (if any)
    const boxes: BoxedResult[] = compResponses.map((r) =>
      boundingBox(r.result),
    );
    for (const fr of fallbackResults) boxes.push(boundingBox(fr));
    if (singletonLayoutNodes.length > 0) {
      const { nodes: gridNodes } = layoutSingletonsGrid(singletonLayoutNodes);
      boxes.push(
        boundingBox({
          nodes: gridNodes,
          edgePaths: [],
        }),
      );
    }

    // 5. Pack + merge
    const placements = shelfPack(boxes);
    const merged = mergeResults(placements);

    const tEnd = performance.now();

    const similarityMs = compResponses.reduce(
      (max, r) => Math.max(max, r.timings.similarityMs),
      0,
    );

    // 6. Fire-and-forget cache write. IndexedDB put runs off the
    // critical path so the caller sees the result immediately.
    cachePut(cacheHash, merged).catch(() => {
      // swallow — cache is best-effort
    });

    return {
      id: req.id,
      result: merged,
      timings: {
        similarityMs: +similarityMs.toFixed(1),
        layoutMs: +(tLayoutDone - tDispatchStart).toFixed(1),
        totalMs: +(tEnd - tStart).toFixed(1),
        componentCount: multiComps.length,
        singletonCount: singletonLayoutNodes.length,
        fallbackNodeCount,
        parallelWorkers: this.workers.length,
        fromCache: false,
        cacheLookupMs: +(tCacheLookupEnd - tStart).toFixed(1),
      },
    };
  }

  terminate() {
    this.destroyed = true;
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.freeWorkers = [];
    for (const p of this.pending.values()) p.reject(new Error("terminated"));
    this.pending.clear();
    this.queue = [];
  }
}

export function defaultPoolSize(): number {
  if (typeof navigator === "undefined") return 2;
  const hc = navigator.hardwareConcurrency ?? 0;
  // deviceMemory is reported in GB (e.g. 4, 8). Only Chromium exposes
  // it; Safari/Firefox leave it undefined so assume a modern laptop.
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // Each Worker carries its own GraphViz WASM instance (~10–30 MB
  // resident). On 4 GB phones with ~256 MB tab budget, spinning up 4
  // of those on top of the edge/sprite tile caches OOMs the renderer.
  if (isMobile || mem <= 4) return 1;
  if (!hc || hc <= 2) return 2;
  return Math.min(4, hc - 2);
}
