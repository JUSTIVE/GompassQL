import type { GraphEdgeData, GraphNodeData } from "./sdl-to-graph";

/**
 * A directed-agnostic suggestion that two nodes belong near each other in
 * the layout. `score` is in (0, 1]; higher means the layout engine should
 * pull them closer. `reasons` is informational (debug / inspector UIs).
 *
 * The output is intentionally sparse: only pairs whose combined evidence
 * exceeds the cohesion threshold appear. Trivial signals (everything
 * touches Query, every Node implements `Node`, every `*Edge` shares a
 * `node` field) are damped or filtered so the layout engine receives a
 * small set of *meaningful* attractions rather than noise.
 */
export interface SimilarityPair {
  a: string;
  b: string;
  score: number;
  reasons: string[];
}

/** Root operation types that should not attract other nodes. */
const ROOT_OPERATIONS = new Set(["Query", "Mutation", "Subscription"]);

/**
 * Suffixes that decorate a "core" type name. Order matters: longer suffixes
 * first so `Connection` wins over a shorter accidental match.
 */
const NAMING_SUFFIXES = [
  "Connection",
  "Notification",
  "Subscription",
  "Response",
  "Request",
  "Payload",
  "Result",
  "Filter",
  "Where",
  "Order",
  "Input",
  "Edge",
  "Args",
  "Type",
];

/** Verb prefixes that decorate a mutation noun (CreateUser → User). */
const VERB_PREFIXES = [
  "Create",
  "Update",
  "Delete",
  "Remove",
  "Upsert",
  "Replace",
  "Add",
  "Set",
  "Get",
  "List",
  "Fetch",
];

/** Field names that carry no semantic weight for similarity. */
const TRIVIAL_FIELDS = new Set(["id", "__typename", "cursor", "createdAt", "updatedAt"]);

const MIN_SCORE = 0.2;

function stripNamingSuffix(name: string): string | null {
  for (const suf of NAMING_SUFFIXES) {
    if (name.length > suf.length + 1 && name.endsWith(suf)) {
      const root = name.slice(0, -suf.length);
      if (root.length >= 2 && /[A-Z]/.test(root[0]!)) return root;
    }
  }
  return null;
}

function stripVerbPrefix(name: string): string | null {
  for (const verb of VERB_PREFIXES) {
    if (name.length > verb.length + 1 && name.startsWith(verb)) {
      const rest = name.slice(verb.length);
      if (/^[A-Z]/.test(rest)) return rest;
    }
  }
  return null;
}

/**
 * Reduce a name to its core noun by repeatedly stripping decorating
 * suffixes and a single verb prefix. For example:
 *   `CreateUserPayload` → `CreateUser` → `User`
 *   `UserConnection`    → `User`
 *   `UserEdge`          → `User`
 *   `UpdateUserInput`   → `UpdateUser` → `User`
 */
export function nameRoot(name: string): string {
  let cur = name;
  // Strip suffixes greedily.
  while (true) {
    const s = stripNamingSuffix(cur);
    if (!s) break;
    cur = s;
  }
  // Strip a single verb prefix.
  const v = stripVerbPrefix(cur);
  if (v) cur = v;
  return cur;
}

function fieldSignatureSet(node: GraphNodeData): Set<string> {
  const s = new Set<string>();
  if (!node.fields) return s;
  for (const f of node.fields) {
    if (TRIVIAL_FIELDS.has(f.name)) continue;
    s.add(`${f.name}:${f.typeName}`);
  }
  return s;
}

function fieldNameSet(node: GraphNodeData): Set<string> {
  const s = new Set<string>();
  if (!node.fields) return s;
  for (const f of node.fields) {
    if (TRIVIAL_FIELDS.has(f.name)) continue;
    s.add(f.name);
  }
  return s;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  if (inter === 0) return 0;
  return inter / (a.size + b.size - inter);
}

/** Skip nodes that should not participate in cohesion at all. */
function isCohesive(node: GraphNodeData): boolean {
  if (ROOT_OPERATIONS.has(node.name)) return false;
  if (node.kind === "Scalar") return false;
  return true;
}

/** Same trailing suffix means siblings in different domains (UserEdge / PostEdge). */
function sameDecoratingSuffix(a: string, b: string): string | null {
  for (const suf of NAMING_SUFFIXES) {
    if (a.endsWith(suf) && b.endsWith(suf)) return suf;
  }
  return null;
}

/**
 * Compute pairwise similarity hints for layout clustering.
 *
 * The returned pairs are unordered (a, b with a < b lexicographically),
 * deduplicated, and sorted by descending score. Consumers should treat
 * each pair as an undirected attraction with weight `score`.
 */
export function computeSimilarityPairs(
  nodes: GraphNodeData[],
  edges: GraphEdgeData[],
): SimilarityPair[] {
  const cohesive = nodes.filter(isCohesive);
  if (cohesive.length < 2) return [];

  const byName = new Map<string, GraphNodeData>();
  for (const n of nodes) byName.set(n.name, n);

  // Aggregate evidence per pair using probabilistic-OR.
  type Acc = { score: number; reasons: string[] };
  const pairMap = new Map<string, Acc>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const add = (a: string, b: string, weight: number, reason: string) => {
    if (a === b || weight <= 0) return;
    const w = Math.min(0.95, weight);
    const key = pairKey(a, b);
    const cur = pairMap.get(key) ?? { score: 0, reasons: [] };
    cur.score = 1 - (1 - cur.score) * (1 - w);
    cur.reasons.push(reason);
    pairMap.set(key, cur);
  };

  // ── 1) Naming-root grouping ───────────────────────────────────────────
  // Types that share a noun root after stripping suffixes/prefixes belong
  // to the same domain concept. Strong, high-precision signal.
  const rootGroups = new Map<string, GraphNodeData[]>();
  for (const n of cohesive) {
    const root = nameRoot(n.name);
    if (root.length < 3) continue;
    if (root === n.name && !byName.has(root)) {
      // Name has no decoration and no sibling owns the root: skip
      // singleton groups below anyway.
    }
    if (!rootGroups.has(root)) rootGroups.set(root, []);
    rootGroups.get(root)!.push(n);
  }
  for (const [root, members] of rootGroups) {
    if (members.length < 2) continue;
    // Larger root families are still meaningful but slightly damped to
    // avoid one giant cluster eating the layout.
    const fam = Math.max(0.45, 1 / Math.log2(members.length + 1));
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i]!;
        const b = members[j]!;
        // If both are *the same* decorator (UserEdge / PostEdge would not
        // share a root, but UserEdge / OrderEdge under a hypothetical
        // shared root wouldn't either) skip — kept here for safety.
        const sib = sameDecoratingSuffix(a.name, b.name);
        // Pairs where one side is the bare root noun (e.g. `User` paired
        // with `UserConnection`) are the strongest: link them tighter.
        const aIsCore = a.name === root;
        const bIsCore = b.name === root;
        const coreBoost = aIsCore || bIsCore ? 0.2 : 0;
        const sibPenalty = sib ? -0.1 : 0;
        const w = Math.max(0.1, 0.55 * fam + coreBoost + sibPenalty);
        add(a.id, b.id, w, `naming-root:${root}`);
      }
    }
  }

  // ── 2) Shared interface implementation ────────────────────────────────
  // Two object types implementing the same interface are conceptually
  // related. Damp by interface popularity: a marker interface like `Node`
  // implemented by every type produces weak signal; a niche interface
  // implemented by 2-3 types produces strong signal.
  const ifaceMembers = new Map<string, GraphNodeData[]>();
  for (const n of cohesive) {
    if (!n.interfaces) continue;
    for (const i of n.interfaces) {
      if (!ifaceMembers.has(i)) ifaceMembers.set(i, []);
      ifaceMembers.get(i)!.push(n);
    }
  }
  for (const [iface, members] of ifaceMembers) {
    if (members.length < 2) continue;
    // Popularity damping: 2 members → ×1, 4 → ~0.5, 8 → ~0.33.
    const popularity = 2 / (members.length);
    const base = 0.5 * popularity;
    if (base < 0.05) continue;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        add(members[i]!.id, members[j]!.id, base, `interface:${iface}`);
      }
    }
  }

  // ── 3) Field-set similarity ───────────────────────────────────────────
  // Strict (name+type) Jaccard captures structural twins like
  // `CreateUserInput` vs `UpdateUserInput`. Loose (name only) Jaccard
  // captures concept twins, but is suppressed when both nodes carry the
  // same decorator (avoids `UserEdge` ↔ `PostEdge` from {node, cursor}).
  const sigOf = new Map<string, Set<string>>();
  const namesOf = new Map<string, Set<string>>();
  for (const n of cohesive) {
    sigOf.set(n.id, fieldSignatureSet(n));
    namesOf.set(n.id, fieldNameSet(n));
  }
  for (let i = 0; i < cohesive.length; i++) {
    const a = cohesive[i]!;
    const sa = sigOf.get(a.id)!;
    const na = namesOf.get(a.id)!;
    if (sa.size < 2 && na.size < 2) continue;
    for (let j = i + 1; j < cohesive.length; j++) {
      const b = cohesive[j]!;
      const sb = sigOf.get(b.id)!;
      const nb = namesOf.get(b.id)!;
      if (sb.size < 2 && nb.size < 2) continue;
      const jStrict = jaccard(sa, sb);
      if (jStrict >= 0.4) {
        add(a.id, b.id, Math.min(0.7, jStrict * 0.75), `fields:${jStrict.toFixed(2)}`);
        continue;
      }
      const jLoose = jaccard(na, nb);
      const sib = sameDecoratingSuffix(a.name, b.name);
      const minSize = Math.min(na.size, nb.size);
      if (!sib && jLoose >= 0.5 && minSize >= 3) {
        add(a.id, b.id, Math.min(0.4, jLoose * 0.4), `field-names:${jLoose.toFixed(2)}`);
      }
    }
  }

  // ── 4) Relay triplet (X, XEdge, XConnection) ──────────────────────────
  // Naming-root grouping already pairs these; here we add a small
  // additional bias so the trio sits as a tight unit. Connection ↔ Edge
  // gets a meaningful but not overwhelming weight (the user warned
  // against over-clumping Connection/Edge).
  for (const n of cohesive) {
    if (!n.name.endsWith("Connection")) continue;
    const root = n.name.slice(0, -"Connection".length);
    if (root.length < 2) continue;
    const edge = byName.get(root + "Edge");
    const core = byName.get(root);
    if (edge) add(n.id, edge.id, 0.45, "relay:Connection-Edge");
    if (core) add(n.id, core.id, 0.35, "relay:Connection-Core");
    if (edge && core) add(edge.id, core.id, 0.5, "relay:Edge-Core");
  }

  // Mention edges parameter to satisfy strict noUnusedParameters style
  // even though current signals are derived purely from node metadata.
  void edges;

  // ── Finalize: prune below threshold, normalize, sort ──────────────────
  const out: SimilarityPair[] = [];
  for (const [k, v] of pairMap) {
    if (v.score < MIN_SCORE) continue;
    const sep = k.indexOf("|");
    const a = k.slice(0, sep);
    const b = k.slice(sep + 1);
    out.push({
      a,
      b,
      score: Math.min(1, Number(v.score.toFixed(4))),
      reasons: v.reasons,
    });
  }
  out.sort((x, y) => y.score - x.score || (x.a + x.b).localeCompare(y.a + y.b));
  return out;
}
