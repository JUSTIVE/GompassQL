import type { GraphEdgeData, GraphNodeData } from "./sdl-to-graph";

/**
 * Weakly-connected components of a directed graph — nodes that can
 * reach each other when edges are treated as undirected. The layout
 * orchestrator uses this to split a schema into independent subgraphs
 * and lay them out in parallel Workers; because no edges cross
 * component boundaries, per-component layouts merge trivially by
 * translating coordinates.
 */

export interface Component {
  nodeIds: Set<string>;
}

export function weaklyConnectedComponents(
  nodes: readonly GraphNodeData[],
  edges: readonly GraphEdgeData[],
): Component[] {
  const parent = new Map<string, string>();
  const rank = new Map<string, number>();
  for (const n of nodes) {
    parent.set(n.id, n.id);
    rank.set(n.id, 0);
  }

  const find = (x: string): string => {
    // iterative path compression
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const nxt = parent.get(cur)!;
      parent.set(cur, root);
      cur = nxt;
    }
    return root;
  };

  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const raRank = rank.get(ra) ?? 0;
    const rbRank = rank.get(rb) ?? 0;
    if (raRank < rbRank) parent.set(ra, rb);
    else if (raRank > rbRank) parent.set(rb, ra);
    else {
      parent.set(rb, ra);
      rank.set(ra, raRank + 1);
    }
  };

  const nodeIdSet = new Set(nodes.map((n) => n.id));
  for (const e of edges) {
    if (!nodeIdSet.has(e.source) || !nodeIdSet.has(e.target)) continue;
    union(e.source, e.target);
  }

  const byRoot = new Map<string, Set<string>>();
  for (const n of nodes) {
    const r = find(n.id);
    let bucket = byRoot.get(r);
    if (!bucket) {
      bucket = new Set();
      byRoot.set(r, bucket);
    }
    bucket.add(n.id);
  }

  return [...byRoot.values()].map((nodeIds) => ({ nodeIds }));
}
