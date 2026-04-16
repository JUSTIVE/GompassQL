import type { GraphEdgeData, GraphNodeData } from "./sdl-to-graph";

const ROOT_OPS = new Set(["Query", "Mutation", "Subscription"]);

export function reachableFrom(
  nodes: GraphNodeData[],
  edges: GraphEdgeData[],
  rootId: string,
): { nodes: GraphNodeData[]; edges: GraphEdgeData[] } {
  if (!nodes.some((n) => n.id === rootId)) {
    return { nodes: [], edges: [] };
  }

  const excluded = new Set<string>();
  for (const r of ROOT_OPS) {
    if (r !== rootId && nodes.some((n) => n.id === r)) excluded.add(r);
  }

  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (excluded.has(e.target)) continue;
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }

  const visited = new Set<string>([rootId]);
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const next = adj.get(id) ?? [];
    for (const nb of next) {
      if (excluded.has(nb) || visited.has(nb)) continue;
      visited.add(nb);
      queue.push(nb);
    }
  }

  const visibleNodes = nodes.filter((n) => visited.has(n.id));
  const visibleEdges = edges.filter(
    (e) => visited.has(e.source) && visited.has(e.target),
  );
  return { nodes: visibleNodes, edges: visibleEdges };
}
