import {
  layoutGraph,
  type LayoutEdgeInput,
  type LayoutNodeInput,
  type LayoutResult,
  type SimilarityHint,
} from "./layout";
import type { GraphEdgeData, GraphNodeData } from "./sdl-to-graph";
import { computeSimilarityPairs } from "./similarity";

/**
 * Dedicated worker entrypoint. The expensive pipeline (similarity hint
 * computation + dagre layout + post-processing detour) runs here so
 * the main thread never blocks on large schemas. The main thread
 * tags each request with an id; stale responses (older `id`) are
 * discarded on the receiving end.
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
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<LayoutWorkerRequest>) => {
  const { id, nodes, edges, layoutNodes, rootId } = e.data;

  const hints: SimilarityHint[] = computeSimilarityPairs(nodes, edges).map(
    (p) => ({ source: p.a, target: p.b, weight: p.score }),
  );

  const layoutEdges: LayoutEdgeInput[] = edges
    .filter((edge) => edge.source !== edge.target)
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
    }));

  const result = layoutGraph(layoutNodes, layoutEdges, rootId ?? undefined, hints);
  const response: LayoutWorkerResponse = { id, result };
  ctx.postMessage(response);
};
