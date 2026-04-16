import {
  layoutGraph,
  preloadLayoutEngine,
  type LayoutEdgeInput,
  type LayoutNodeInput,
  type LayoutResult,
  type SimilarityHint,
} from "./layout";
import type { GraphEdgeData, GraphNodeData } from "./sdl-to-graph";
import { computeSimilarityPairs } from "./similarity";

/**
 * Dedicated worker entrypoint. The pipeline (similarity hint
 * computation + GraphViz layout) runs here so the main thread never
 * blocks on large schemas. The main thread tags each request with an
 * id; stale responses (older `id`) are discarded on the receiving end.
 *
 * This file is bundled to a standalone module at `/layout-worker.js`:
 *   - dev: `src/index.ts` serves it via `Bun.build()` at request time
 *   - prod: `build.ts` emits `dist/layout-worker.js` alongside the HTML bundle
 */

export interface LayoutWorkerRequest {
  id: number;
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  layoutNodes: LayoutNodeInput[];
  rootId?: string | null;
}

export interface LayoutWorkerResponse {
  id: number;
  result: LayoutResult;
  timings: {
    similarityMs: number;
    layoutMs: number;
    totalMs: number;
  };
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// Cap hint pseudo-edges at a small multiple of node count. Even with
// the current narrow similarity signal, a single large union could
// emit quadratic hints — the slice is cheap defensive code.
const MAX_HINTS_PER_NODE = 2;

// Kick off WASM init immediately so the first message doesn't pay
// cold-start.
preloadLayoutEngine().catch(() => {
  // Silently ignore; the first message's getViz() call will surface
  // any error via onerror.
});

ctx.onmessage = async (e: MessageEvent<LayoutWorkerRequest>) => {
  const { id, nodes, edges, layoutNodes, rootId } = e.data;
  const t0 = performance.now();

  const allPairs = computeSimilarityPairs(nodes, edges);
  const hintBudget = Math.min(
    allPairs.length,
    MAX_HINTS_PER_NODE * layoutNodes.length,
  );
  const hints: SimilarityHint[] = allPairs
    .slice(0, hintBudget)
    .map((p) => ({ source: p.a, target: p.b, weight: p.score }));
  const t1 = performance.now();

  const layoutEdges: LayoutEdgeInput[] = edges
    .filter((edge) => edge.source !== edge.target)
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
    }));

  const result = await layoutGraph(
    layoutNodes,
    layoutEdges,
    rootId ?? undefined,
    hints,
  );
  const t2 = performance.now();

  const response: LayoutWorkerResponse = {
    id,
    result,
    timings: {
      similarityMs: +(t1 - t0).toFixed(1),
      layoutMs: +(t2 - t1).toFixed(1),
      totalMs: +(t2 - t0).toFixed(1),
    },
  };
  ctx.postMessage(response);
};
