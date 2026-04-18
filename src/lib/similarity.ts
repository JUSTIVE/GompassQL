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

/**
 * Minimal Union fingerprint: just the union's own id and the type names
 * it lists as members. Accepting this shape (instead of full
 * `GraphNodeData`) keeps the worker postMessage payload tiny on huge
 * schemas — descriptions, fields, and arg metadata aren't needed here.
 */
export interface UnionInput {
  id: string;
  members: readonly string[];
}

/** Weight given to each union-member ↔ union-member hint. */
const UNION_ADJACENCY_WEIGHT = 0.6;

export function computeSimilarityPairs(
  unions: readonly UnionInput[],
  knownIds: ReadonlySet<string>,
): SimilarityPair[] {
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

  for (const u of unions) {
    const memberIds: string[] = [];
    for (const m of u.members) {
      // Type name === node id in the current sdl-to-graph pipeline, so
      // we can skip the byName indirection. `knownIds` filters out
      // members whose type was dropped (e.g. Relay Edge/Connection
      // unwrapping) — including them would pull out nonexistent nodes.
      if (knownIds.has(m)) memberIds.push(m);
    }
    for (let i = 0; i < memberIds.length; i++) {
      for (let j = i + 1; j < memberIds.length; j++) {
        add(memberIds[i]!, memberIds[j]!, UNION_ADJACENCY_WEIGHT, `union:${u.id}`);
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
