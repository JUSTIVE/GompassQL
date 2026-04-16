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
 * Web Worker entry for the expensive layout pipeline. Runs
 * similarity-hint computation and dagre layout off the main thread so
 * large schemas don't freeze the UI. The main thread posts a request
 * tagged with an id, and the worker posts back exactly one response
 * carrying the same id — stale requests can be discarded by comparing.
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

// `self` in a module worker is the DedicatedWorkerGlobalScope.
const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<LayoutWorkerRequest>) => {
  const { id, nodes, edges, layoutNodes, rootId } = e.data;

  const hints: SimilarityHint[] = computeSimilarityPairs(nodes, edges).map(
    (p) => ({ source: p.a, target: p.b, weight: p.score }),
  );

  const layoutEdges: LayoutEdgeInput[] = edges
    .filter((e) => e.source !== e.target)
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      kind: e.kind,
    }));

  const result = layoutGraph(layoutNodes, layoutEdges, rootId ?? undefined, hints);
  const response: LayoutWorkerResponse = { id, result };
  ctx.postMessage(response);
};
