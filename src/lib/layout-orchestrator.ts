import type { LayoutNodeInput, LayoutResult, PositionedNode } from "./layout";
import type { LayoutWorkerRequest, LayoutWorkerResponse } from "./layout-worker";
import type { GraphEdgeData, GraphNodeData } from "./sdl-to-graph";
import type { UnionInput } from "./similarity";
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

// Chunk targets — single dot call is limited to this many nodes /
// edges. Components above these sizes are recursively bisected
// (alphabetically) into sub-chunks, each laid out as its own dot
// invocation. Cross-chunk edges are drawn as a single straight-line
// polyline segment after the sub-layouts are shelf-packed. Keeping
// each dot call modest prevents GraphViz's WASM heap from growing
// past the renderer's per-tab budget during polyline routing, which
// is where most hub-heavy schemas (e.g. Relay `Node` interface with
// 100+ implementors) used to abort.
const CHUNK_TARGET_NODES = 500;
const CHUNK_TARGET_EDGES = 4000;

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
  /** Fired as chunks complete. `done` counts leaf dot dispatches that
   *  finished; `total` is the estimated dispatch count for the whole
   *  request (computed before dispatching, based on CHUNK_TARGET_NODES).
   *  Callers can use these to render a progress bar on huge schemas. */
  onProgress?: (done: number, total: number) => void;
}

interface Pending {
  resolve: (r: LayoutWorkerResponse) => void;
  reject: (e: Error) => void;
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

    // 3. Dispatch multi-node components in parallel. Components above
    // CHUNK_TARGET_NODES / CHUNK_TARGET_EDGES are recursively bisected
    // into sub-chunks and stitched back together with shelf-packing;
    // cross-chunk edges are emitted as straight polyline segments
    // post-layout. This keeps each GraphViz invocation modest so its
    // WASM heap never has to route polylines across more than a few
    // hundred nodes at once.
    //
    // Pre-compute an estimate of total leaf dispatches so the caller's
    // progress callback can render a determinate bar from the start.
    // Each multi-comp contributes ceil(nodeCount / CHUNK_TARGET_NODES)
    // — an upper bound; actual leaf count tends to be a bit lower
    // because some sub-chunks land below the threshold and stop
    // recursing.
    let chunksDone = 0;
    let chunksTotal = 0;
    for (const c of multiComps) {
      chunksTotal += Math.max(
        1,
        Math.ceil(c.layoutNodes.length / CHUNK_TARGET_NODES),
      );
    }
    if (req.onProgress) req.onProgress(0, chunksTotal);
    const onLeaf = req.onProgress
      ? () => {
          chunksDone += 1;
          // Clamp `done` so a slight under-estimate doesn't yield
          // >100% progress mid-flight.
          req.onProgress!(Math.min(chunksDone, chunksTotal), chunksTotal);
        }
      : undefined;

    const tDispatchStart = performance.now();
    const compResponses = await Promise.all(
      multiComps.map((c) => {
        const unions = c.nodes
          .filter((n) => n.kind === "Union")
          .map((n) => ({ id: n.id, members: n.members ?? [] }));
        return this.chunkAndLayout(c.layoutNodes, c.edges, unions, onLeaf);
      }),
    );
    const tLayoutDone = performance.now();
    if (req.onProgress) req.onProgress(chunksTotal, chunksTotal);

    // 4. Compose boxes: multi-comp results + singleton grid (if any)
    const boxes: BoxedResult[] = compResponses.map((r) =>
      boundingBox(r.result),
    );
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
      (max, r) => Math.max(max, r.similarityMs),
      0,
    );
    const chunkCount = compResponses.reduce(
      (sum, r) => sum + r.chunkCount,
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
        fallbackNodeCount: Math.max(0, chunkCount - multiComps.length),
        parallelWorkers: this.workers.length,
        fromCache: false,
        cacheLookupMs: +(tCacheLookupEnd - tStart).toFixed(1),
      },
    };
  }

  /**
   * Recursively bisect a connected component (by sorted node id) until
   * every sub-piece fits within CHUNK_TARGET_NODES / CHUNK_TARGET_EDGES,
   * dispatch each sub-piece as its own dot call, then stitch the
   * results together via shelf-packing. Edges that span two chunks are
   * not laid out by dot — we add them back as a single straight-line
   * polyline segment from the source's right edge to the target's left
   * edge, matching the look of `splines: "polyline"` within a chunk.
   *
   * The recursion bottoms out when no further bisection helps (single
   * node or no progress), so a degenerate input still always returns.
   */
  private async chunkAndLayout(
    layoutNodes: LayoutNodeInput[],
    edges: GraphEdgeData[],
    unions: UnionInput[],
    onLeaf?: () => void,
  ): Promise<{
    result: LayoutResult;
    similarityMs: number;
    layoutMs: number;
    chunkCount: number;
  }> {
    if (layoutNodes.length === 0) {
      return {
        result: { nodes: [], edgePaths: [] },
        similarityMs: 0,
        layoutMs: 0,
        chunkCount: 0,
      };
    }

    if (
      layoutNodes.length <= CHUNK_TARGET_NODES &&
      edges.length <= CHUNK_TARGET_EDGES
    ) {
      const knownIds = layoutNodes.map((n) => n.id);
      const minEdges = edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        kind: e.kind,
      }));
      const resp = await this.dispatch({
        unions,
        knownIds,
        edges: minEdges,
        layoutNodes,
        rootId: null,
      });
      onLeaf?.();
      return {
        result: resp.result,
        similarityMs: resp.timings.similarityMs,
        layoutMs: resp.timings.layoutMs,
        chunkCount: 1,
      };
    }

    // Bisect alphabetically — stable, deterministic, and tends to
    // group related types (consistent prefixes are common in GraphQL
    // schemas) so most edges stay intra-chunk.
    const sorted = [...layoutNodes].sort((a, b) => a.id.localeCompare(b.id));
    const mid = Math.max(1, Math.floor(sorted.length / 2));
    const leftNodes = sorted.slice(0, mid);
    const rightNodes = sorted.slice(mid);
    const leftIds = new Set(leftNodes.map((n) => n.id));

    const leftEdges: GraphEdgeData[] = [];
    const rightEdges: GraphEdgeData[] = [];
    const crossEdges: GraphEdgeData[] = [];
    for (const e of edges) {
      const sL = leftIds.has(e.source);
      const tL = leftIds.has(e.target);
      if (sL && tL) leftEdges.push(e);
      else if (!sL && !tL) rightEdges.push(e);
      else crossEdges.push(e);
    }

    const [left, right] = await Promise.all([
      this.chunkAndLayout(leftNodes, leftEdges, unions, onLeaf),
      this.chunkAndLayout(rightNodes, rightEdges, unions, onLeaf),
    ]);

    const placements = shelfPack([
      boundingBox(left.result),
      boundingBox(right.result),
    ]);
    const merged = mergeResults(placements);

    // Synthesize a single-segment cubic bezier path for each
    // cross-chunk edge using the merged (post-pack) node positions.
    // Exit the source's right edge / enter the target's left edge
    // (matches dot's rankdir=LR exit/entry tangent). Control points
    // are pulled along the +x / -x tangent direction by a fraction
    // of the horizontal distance, so the curve gently arcs between
    // chunks instead of stretching a straight diagonal across the
    // schema — visually consistent with `splines: polyline` output
    // dot produces for intra-chunk edges.
    if (crossEdges.length > 0) {
      const posById = new Map<string, PositionedNode>();
      for (const n of merged.nodes) posById.set(n.id, n);
      for (const e of crossEdges) {
        const a = posById.get(e.source);
        const b = posById.get(e.target);
        if (!a || !b) continue;
        const sx = a.x + a.width / 2;
        const sy = a.y;
        const tx = b.x - b.width / 2;
        const ty = b.y;
        const dx = tx - sx;
        // Tangent strength: 1/3 of the horizontal span, with a floor
        // so tightly-spaced cross-edges still curve visibly and a
        // ceiling so distant pairs don't balloon into huge arcs.
        const tangent = Math.max(48, Math.min(Math.abs(dx) / 3, 280));
        merged.edgePaths.push({
          edgeId: e.id,
          source: e.source,
          target: e.target,
          start: { x: sx, y: sy },
          segments: [
            {
              c1: { x: sx + tangent, y: sy },
              c2: { x: tx - tangent, y: ty },
              end: { x: tx, y: ty },
            },
          ],
        });
      }
    }

    return {
      result: merged,
      similarityMs: Math.max(left.similarityMs, right.similarityMs),
      layoutMs: Math.max(left.layoutMs, right.layoutMs),
      chunkCount: left.chunkCount + right.chunkCount,
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
