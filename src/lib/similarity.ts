import type { GraphEdgeData, GraphNodeData } from "./sdl-to-graph";

/**
 * A directed-agnostic suggestion that two nodes belong near each other in
 * the layout. `score` is in (0, 1]; higher means the layout engine should
 * pull them closer. `reasons` is informational (debug / inspector UIs).
 *
 * Scope is intentionally narrow: the only signal we emit is "these types
 * are members of the same Union, so place them adjacent". Broader
 * heuristics (naming roots, interface co-membership, field-set Jaccard,
 * Relay triplets) were removed because they produced too many
 * pseudo-edges on large schemas and ballooned dagre's layout time.
 */
export interface SimilarityPair {
  a: string;
  b: string;
  score: number;
  reasons: string[];
}

/** Weight given to each union-member ↔ union-member hint. */
const UNION_ADJACENCY_WEIGHT = 0.6;

export function computeSimilarityPairs(
  nodes: GraphNodeData[],
  edges: GraphEdgeData[],
): SimilarityPair[] {
  void edges;

  const byName = new Map<string, GraphNodeData>();
  for (const n of nodes) byName.set(n.name, n);

  type Acc = { score: number; reasons: string[] };
  const pairMap = new Map<string, Acc>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const add = (a: string, b: string, weight: number, reason: string) => {
    if (a === b) return;
    const key = pairKey(a, b);
    const cur = pairMap.get(key) ?? { score: 0, reasons: [] };
    // Probabilistic-OR aggregation so repeated signals reinforce without
    // ever exceeding 1.
    cur.score = 1 - (1 - cur.score) * (1 - weight);
    cur.reasons.push(reason);
    pairMap.set(key, cur);
  };

  for (const u of nodes) {
    if (u.kind !== "Union" || !u.members) continue;
    const memberIds: string[] = [];
    for (const m of u.members) {
      const n = byName.get(m);
      if (n) memberIds.push(n.id);
    }
    for (let i = 0; i < memberIds.length; i++) {
      for (let j = i + 1; j < memberIds.length; j++) {
        add(memberIds[i]!, memberIds[j]!, UNION_ADJACENCY_WEIGHT, `union:${u.name}`);
      }
    }
  }

  const out: SimilarityPair[] = [];
  for (const [k, v] of pairMap) {
    const sep = k.indexOf("|");
    out.push({
      a: k.slice(0, sep),
      b: k.slice(sep + 1),
      score: Math.min(1, Number(v.score.toFixed(4))),
      reasons: v.reasons,
    });
  }
  out.sort((x, y) => y.score - x.score || (x.a + x.b).localeCompare(y.a + y.b));
  return out;
}
