/**
 * Layered (Sugiyama-style) graph layout for GraphQL schema diagrams.
 *
 * Pipeline:
 *   1. Rank assignment via BFS from the root.
 *   2. Dummy-node insertion so every edge spans exactly one rank; dummies
 *      reserve Y slots in intermediate columns so edges never need to be
 *      rerouted around intervening nodes later on.
 *   3. Barycenter sweeps to minimise edge crossings within each rank,
 *      with similarity hints used as a stable tiebreaker so clustered
 *      nodes sit adjacent.
 *   4. Y assignment: stack-and-center followed by "pull toward neighbour
 *      average" relaxation with a hard minimum-gap constraint.
 *   5. Reconstruct orthogonal edge waypoints from the dummy chain.
 *
 * X coordinates are *strict* (`rank * RANK_SEP`) — columns never drift —
 * which is the structural fix that makes clean edge routing possible.
 */

export interface LayoutNodeInput {
  id: string;
  width: number;
  height: number;
}

export interface LayoutEdgeInput {
  id?: string;
  source: string;
  target: string;
  kind?: string;
}

/**
 * Layout-time hint: pull these two nodes closer together with the given
 * weight (0..1). Hints are *additional* attractions on top of real edges
 * and do not need to correspond to a GraphQL relationship.
 */
export interface SimilarityHint {
  source: string;
  target: string;
  weight: number;
}

export interface PositionedNode extends LayoutNodeInput {
  x: number;
  y: number;
}

export interface EdgePathPoint {
  x: number;
  y: number;
}

export interface EdgePath {
  edgeId: string;
  source: string;
  target: string;
  waypoints: EdgePathPoint[];
}

export interface LayoutResult {
  nodes: PositionedNode[];
  edgePaths: EdgePath[];
}

const RANK_SEP = 340;
const Y_GAP = 32;
const DUMMY_HEIGHT = 20;

export function layoutGraph(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
  rootId?: string,
  similarityHints?: SimilarityHint[],
): LayoutResult {
  if (nodes.length === 0) return { nodes: [], edgePaths: [] };

  const nodeSet = new Set(nodes.map((n) => n.id));
  const cleanEdges = edges.filter(
    (e) => e.source !== e.target && nodeSet.has(e.source) && nodeSet.has(e.target),
  );

  // ── 1) Rank assignment (BFS from root) ────────────────────────────────
  const root = pickRoot(nodes, cleanEdges, rootId);
  if (!root) return { nodes: [], edgePaths: [] };
  const ranks = bfsRanks(nodes, cleanEdges, root);

  // ── 2) Dummy-node insertion for multi-rank edges ──────────────────────
  const split = splitLongEdges(nodes, cleanEdges, ranks);
  const allNodes = split.allNodes;
  const allEdges = split.allEdges;
  const dummyChains = split.dummyChains;
  const nodeById = new Map<string, LayoutNodeInput>(allNodes.map((n) => [n.id, n]));

  // Group by rank in insertion order for initial layering.
  const layers = new Map<number, string[]>();
  for (const n of allNodes) {
    const r = ranks.get(n.id)!;
    if (!layers.has(r)) layers.set(r, []);
    layers.get(r)!.push(n.id);
  }
  const rankKeys = [...layers.keys()].sort((a, b) => a - b);

  // ── 3) Barycenter ordering ────────────────────────────────────────────
  const undirected = buildUndirected(allEdges);
  // Inject strong-enough similarity hints as pseudo-edges so they influence
  // ordering without being counted as crossings.
  const hintEdges: LayoutEdgeInput[] = [];
  if (similarityHints) {
    for (const h of similarityHints) {
      if (h.weight < 0.3) continue;
      if (!nodeSet.has(h.source) || !nodeSet.has(h.target)) continue;
      hintEdges.push({ source: h.source, target: h.target });
    }
  }
  const orderingNeighbours = buildUndirected([...allEdges, ...hintEdges]);
  orderByBarycenter(layers, rankKeys, orderingNeighbours, allEdges, undirected);

  // Same-rank similarity hints are invisible to barycenter (which only
  // looks at adjacent layers). Post-process: group nodes connected by
  // strong same-rank hints into contiguous blocks, preserving overall
  // ordering by each block's minimum position.
  if (similarityHints && similarityHints.length > 0) {
    regroupWithinRankBySimilarity(layers, ranks, similarityHints);
  }

  // ── 4) Y coordinate assignment ────────────────────────────────────────
  const yOf = assignY(layers, rankKeys, nodeById, undirected);

  // ── 5) Emit positioned real + dummy nodes (pre-normalisation) ────────
  const positioned: PositionedNode[] = [];
  for (const n of nodes) {
    const r = ranks.get(n.id);
    if (r == null) continue;
    positioned.push({
      id: n.id,
      width: n.width,
      height: n.height,
      x: r * RANK_SEP,
      y: yOf.get(n.id) ?? 0,
    });
  }
  const dummyPos = new Map<string, { x: number; y: number }>();
  for (const n of allNodes) {
    if (!n.id.startsWith("__dummy_")) continue;
    const r = ranks.get(n.id)!;
    dummyPos.set(n.id, { x: r * RANK_SEP, y: yOf.get(n.id) ?? 0 });
  }
  // Normalise real nodes and dummies together so waypoint math lines up.
  const shift = computeNormalisationShift(positioned);
  for (const p of positioned) {
    p.x += shift.dx;
    p.y += shift.dy;
  }
  for (const [id, p] of dummyPos) {
    dummyPos.set(id, { x: p.x + shift.dx, y: p.y + shift.dy });
  }

  // Column envelopes (post-normalisation top/bottom Y per rank). For
  // back-edges we need the union across every rank the horizontal leg
  // traverses so the loop-around Y clears the *entire* span, not just
  // the source and target columns.
  const columnEnvelope = new Map<number, { top: number; bottom: number }>();
  for (const p of positioned) {
    const r = ranks.get(p.id)!;
    const cur = columnEnvelope.get(r);
    const top = p.y - p.height / 2;
    const bottom = p.y + p.height / 2;
    if (!cur) columnEnvelope.set(r, { top, bottom });
    else {
      cur.top = Math.min(cur.top, top);
      cur.bottom = Math.max(cur.bottom, bottom);
    }
  }
  const envelopeForRange = (rs: number, rt: number): { top: number; bottom: number } => {
    const lo = Math.min(rs, rt);
    const hi = Math.max(rs, rt);
    let top = Infinity;
    let bottom = -Infinity;
    for (const [r, env] of columnEnvelope) {
      if (r < lo || r > hi) continue;
      top = Math.min(top, env.top);
      bottom = Math.max(bottom, env.bottom);
    }
    if (!isFinite(top)) return { top: 0, bottom: 0 };
    return { top, bottom };
  };

  // ── 6) Edge paths (through dummy positions) ───────────────────────────
  const paths: EdgePath[] = [];
  const realPos = new Map<string, PositionedNode>(positioned.map((p) => [p.id, p]));
  for (const e of cleanEdges) {
    const a = realPos.get(e.source);
    const b = realPos.get(e.target);
    if (!a || !b) continue;
    const key = edgeKey(e);
    const chain = dummyChains.get(key) ?? [];
    const rs = ranks.get(e.source)!;
    const rt = ranks.get(e.target)!;
    const isBack = b.x <= a.x + a.width / 2;
    const env = isBack ? envelopeForRange(rs, rt) : columnEnvelope.get(rs);
    const waypoints: EdgePathPoint[] = buildEdgeWaypoints(a, b, chain, dummyPos, env, env);
    paths.push({
      edgeId: e.id ?? key,
      source: e.source,
      target: e.target,
      waypoints,
    });
  }

  return { nodes: positioned, edgePaths: paths };
}

// ──────────────────────────────────────────────────────────────────────────
// Rank assignment
// ──────────────────────────────────────────────────────────────────────────

function pickRoot(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
  rootId?: string,
): string | undefined {
  const nodeSet = new Set(nodes.map((n) => n.id));
  if (rootId && nodeSet.has(rootId)) return rootId;
  const hasIncoming = new Set<string>();
  for (const e of edges) hasIncoming.add(e.target);
  const firstZeroIn = nodes.find((n) => !hasIncoming.has(n.id));
  return firstZeroIn?.id ?? nodes[0]?.id;
}

function bfsRanks(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
  root: string,
): Map<string, number> {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) adj.get(e.source)?.push(e.target);

  const ranks = new Map<string, number>();
  ranks.set(root, 0);
  let maxRank = 0;
  const queue: string[] = [root];
  while (queue.length > 0) {
    const u = queue.shift()!;
    const r = ranks.get(u)!;
    for (const v of adj.get(u) ?? []) {
      if (!ranks.has(v)) {
        ranks.set(v, r + 1);
        if (r + 1 > maxRank) maxRank = r + 1;
        queue.push(v);
      }
    }
  }
  // Unreached nodes: place them one rank beyond the longest reached path.
  for (const n of nodes) if (!ranks.has(n.id)) ranks.set(n.id, maxRank + 1);
  return ranks;
}

// ──────────────────────────────────────────────────────────────────────────
// Dummy-node insertion
// ──────────────────────────────────────────────────────────────────────────

function splitLongEdges(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
  ranks: Map<string, number>,
): {
  allNodes: LayoutNodeInput[];
  allEdges: LayoutEdgeInput[];
  dummyChains: Map<string, string[]>;
} {
  const allNodes = [...nodes];
  const allEdges: LayoutEdgeInput[] = [];
  const dummyChains = new Map<string, string[]>();
  let counter = 0;
  for (const e of edges) {
    const rs = ranks.get(e.source);
    const rt = ranks.get(e.target);
    if (rs == null || rt == null) continue;
    const span = rt - rs;
    if (span <= 1) {
      // Forward span-1 or back-edge: keep as-is (barycenter only uses
      // forward spans, but we still emit the edge for waypoint building).
      allEdges.push(e);
      continue;
    }
    const chain: string[] = [];
    let prev = e.source;
    for (let r = rs + 1; r < rt; r++) {
      const id = `__dummy_${counter++}`;
      chain.push(id);
      allNodes.push({ id, width: 0, height: DUMMY_HEIGHT });
      ranks.set(id, r);
      allEdges.push({ source: prev, target: id });
      prev = id;
    }
    allEdges.push({ source: prev, target: e.target });
    dummyChains.set(edgeKey(e), chain);
  }
  return { allNodes, allEdges, dummyChains };
}

function edgeKey(e: LayoutEdgeInput): string {
  return e.id ?? `${e.source}|${e.target}|${e.kind ?? ""}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Barycenter ordering
// ──────────────────────────────────────────────────────────────────────────

function buildUndirected(edges: LayoutEdgeInput[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const ensure = (k: string) => {
    if (!adj.has(k)) adj.set(k, []);
    return adj.get(k)!;
  };
  for (const e of edges) {
    ensure(e.source).push(e.target);
    ensure(e.target).push(e.source);
  }
  return adj;
}

function orderByBarycenter(
  layers: Map<number, string[]>,
  rankKeys: number[],
  orderingNeighbours: Map<string, string[]>,
  crossingEdges: LayoutEdgeInput[],
  crossingNeighbours: Map<string, string[]>,
) {
  const pos = new Map<string, number>();
  const updatePos = () => {
    pos.clear();
    for (const r of rankKeys) {
      const ids = layers.get(r)!;
      for (let i = 0; i < ids.length; i++) pos.set(ids[i]!, i);
    }
  };
  updatePos();

  const computeCrossings = () => countCrossings(layers, rankKeys, crossingEdges, crossingNeighbours, pos);

  let bestCrossings = computeCrossings();
  let best = snapshot(layers);

  const SWEEPS = 24;
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const downward = sweep % 2 === 0;
    const order = downward ? rankKeys : [...rankKeys].slice().reverse();
    for (const r of order) {
      const refR = downward ? r - 1 : r + 1;
      const refIds = layers.get(refR);
      if (!refIds || refIds.length === 0) continue;
      const refPos = new Map<string, number>();
      refIds.forEach((id, i) => refPos.set(id, i));
      const ids = layers.get(r)!;
      const bary = new Map<string, number>();
      ids.forEach((id, i) => {
        const nbrs = orderingNeighbours.get(id) ?? [];
        const ps: number[] = [];
        for (const nb of nbrs) {
          const p = refPos.get(nb);
          if (p != null) ps.push(p);
        }
        bary.set(id, ps.length > 0 ? ps.reduce((a, b) => a + b, 0) / ps.length : i);
      });
      ids.sort((a, b) => {
        const da = bary.get(a)!;
        const db = bary.get(b)!;
        if (da !== db) return da - db;
        return a.localeCompare(b);
      });
    }
    updatePos();
    const c = computeCrossings();
    if (c < bestCrossings) {
      bestCrossings = c;
      best = snapshot(layers);
      if (c === 0) break;
    }
  }
  // Restore best.
  for (const [r, ids] of best) layers.set(r, ids);
}

/**
 * Within each rank, union-find nodes connected by strong same-rank
 * similarity hints, then reorder the rank so each cluster is contiguous.
 * Cluster order is preserved by minimum member position (so the
 * cross-rank ordering produced by barycenter is disturbed as little as
 * possible).
 */
function regroupWithinRankBySimilarity(
  layers: Map<number, string[]>,
  ranks: Map<string, number>,
  hints: SimilarityHint[],
) {
  // Bucket hints per rank.
  const byRank = new Map<number, Array<[string, string]>>();
  for (const h of hints) {
    if (h.weight < 0.35) continue;
    const ra = ranks.get(h.source);
    const rb = ranks.get(h.target);
    if (ra == null || rb == null || ra !== rb) continue;
    if (!byRank.has(ra)) byRank.set(ra, []);
    byRank.get(ra)!.push([h.source, h.target]);
  }
  for (const [r, pairs] of byRank) {
    const ids = layers.get(r);
    if (!ids || ids.length < 3) continue;
    const idSet = new Set(ids);
    const parent = new Map<string, string>();
    for (const id of ids) parent.set(id, id);
    const find = (x: string): string => {
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x)!)!);
        x = parent.get(x)!;
      }
      return x;
    };
    const union = (a: string, b: string) => parent.set(find(a), find(b));
    for (const [a, b] of pairs) {
      if (idSet.has(a) && idSet.has(b)) union(a, b);
    }
    // Build cluster → members (preserve original order within cluster).
    const clusters = new Map<string, string[]>();
    const minPos = new Map<string, number>();
    ids.forEach((id, i) => {
      const c = find(id);
      if (!clusters.has(c)) {
        clusters.set(c, []);
        minPos.set(c, i);
      }
      clusters.get(c)!.push(id);
    });
    // Sort clusters by their earliest member's position, then flatten.
    const sorted = [...clusters.entries()].sort((a, b) => minPos.get(a[0])! - minPos.get(b[0])!);
    const out: string[] = [];
    for (const [, members] of sorted) out.push(...members);
    layers.set(r, out);
  }
}

function snapshot(layers: Map<number, string[]>): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const [r, ids] of layers) out.set(r, ids.slice());
  return out;
}

function countCrossings(
  layers: Map<number, string[]>,
  rankKeys: number[],
  edges: LayoutEdgeInput[],
  _neighbours: Map<string, string[]>,
  pos: Map<string, number>,
): number {
  // Build per-rank-pair edge list.
  let total = 0;
  for (let i = 0; i < rankKeys.length - 1; i++) {
    const rLo = rankKeys[i]!;
    const rHi = rankKeys[i + 1]!;
    const pairEdges: Array<[number, number]> = [];
    for (const e of edges) {
      const ps = pos.get(e.source);
      const pt = pos.get(e.target);
      if (ps == null || pt == null) continue;
      const inLoHi = (layers.get(rLo)?.includes(e.source) ?? false) && (layers.get(rHi)?.includes(e.target) ?? false);
      const inHiLo = (layers.get(rHi)?.includes(e.source) ?? false) && (layers.get(rLo)?.includes(e.target) ?? false);
      if (!inLoHi && !inHiLo) continue;
      if (inLoHi) pairEdges.push([ps, pt]);
      else pairEdges.push([pt, ps]);
    }
    for (let a = 0; a < pairEdges.length; a++) {
      for (let b = a + 1; b < pairEdges.length; b++) {
        const [a1, a2] = pairEdges[a]!;
        const [b1, b2] = pairEdges[b]!;
        if ((a1 - b1) * (a2 - b2) < 0) total++;
      }
    }
  }
  return total;
}

// ──────────────────────────────────────────────────────────────────────────
// Y coordinate assignment
// ──────────────────────────────────────────────────────────────────────────

function assignY(
  layers: Map<number, string[]>,
  rankKeys: number[],
  nodeById: Map<string, LayoutNodeInput>,
  undirected: Map<string, string[]>,
): Map<string, number> {
  const yOf = new Map<string, number>();

  // Initial: centered stack per layer.
  for (const r of rankKeys) {
    const ids = layers.get(r)!;
    let cursor = 0;
    const centers: number[] = [];
    for (const id of ids) {
      const h = nodeById.get(id)?.height ?? DUMMY_HEIGHT;
      centers.push(cursor + h / 2);
      cursor += h + Y_GAP;
    }
    const total = cursor - Y_GAP;
    const offset = -total / 2;
    ids.forEach((id, i) => yOf.set(id, centers[i]! + offset));
  }

  // Relaxation: pull toward average of neighbours across ranks, then
  // compact with a hard minimum-gap constraint (forward + backward sweep).
  const ITERS = 24;
  for (let iter = 0; iter < ITERS; iter++) {
    const mix = 1 - iter / (ITERS + 4); // diminishing step size
    for (const r of rankKeys) {
      const ids = layers.get(r)!;
      if (ids.length === 0) continue;
      // Compute ideal Y per node.
      const ideal: number[] = new Array(ids.length);
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]!;
        const nbrs = undirected.get(id) ?? [];
        let sum = 0;
        let cnt = 0;
        for (const nb of nbrs) {
          const y = yOf.get(nb);
          if (y != null) {
            sum += y;
            cnt += 1;
          }
        }
        ideal[i] = cnt > 0 ? (yOf.get(id)! * (1 - mix) + (sum / cnt) * mix) : yOf.get(id)!;
      }
      for (let i = 0; i < ids.length; i++) yOf.set(ids[i]!, ideal[i]!);
      // Hard compact: enforce min spacing respecting the layer order.
      compactLayer(ids, yOf, nodeById);
    }
  }

  return yOf;
}

function compactLayer(
  ids: string[],
  yOf: Map<string, number>,
  nodeById: Map<string, LayoutNodeInput>,
) {
  const height = (id: string) => nodeById.get(id)?.height ?? DUMMY_HEIGHT;
  // Forward pass: push overlapping nodes down.
  for (let i = 1; i < ids.length; i++) {
    const prev = ids[i - 1]!;
    const cur = ids[i]!;
    const minY = yOf.get(prev)! + height(prev) / 2 + height(cur) / 2 + Y_GAP;
    if (yOf.get(cur)! < minY) yOf.set(cur, minY);
  }
  // Backward pass: pull the column center toward the average so it
  // stays centred and symmetric top/bottom.
  for (let i = ids.length - 2; i >= 0; i--) {
    const next = ids[i + 1]!;
    const cur = ids[i]!;
    const maxY = yOf.get(next)! - height(next) / 2 - height(cur) / 2 - Y_GAP;
    if (yOf.get(cur)! > maxY) yOf.set(cur, maxY);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Edge waypoints
// ──────────────────────────────────────────────────────────────────────────

function buildEdgeWaypoints(
  a: PositionedNode,
  b: PositionedNode,
  chain: string[],
  dummyPos: Map<string, { x: number; y: number }>,
  sourceEnv?: { top: number; bottom: number },
  targetEnv?: { top: number; bottom: number },
): EdgePathPoint[] {
  const points: EdgePathPoint[] = [];
  const GAP_FRAC = 0.5;
  const exitX = a.x + a.width / 2;
  const entryX = b.x - b.width / 2;
  const sy = a.y;
  const ty = b.y;

  if (chain.length === 0) {
    if (b.x > a.x + a.width / 2) {
      // Forward span-1: L-shape through the column gap.
      const midX = exitX + (entryX - exitX) * GAP_FRAC;
      points.push({ x: exitX, y: sy });
      points.push({ x: midX, y: sy });
      points.push({ x: midX, y: ty });
      points.push({ x: entryX, y: ty });
    } else {
      // Back-edge or same-column loop. Route fully above or below the
      // *column envelope* so the horizontal leg can never clip any
      // intermediate node in the same column.
      const envTop = Math.min(
        sourceEnv?.top ?? a.y - a.height / 2,
        targetEnv?.top ?? b.y - b.height / 2,
      );
      const envBottom = Math.max(
        sourceEnv?.bottom ?? a.y + a.height / 2,
        targetEnv?.bottom ?? b.y + b.height / 2,
      );
      const avgY = (sy + ty) / 2;
      const goBelow = Math.abs(avgY - envBottom) <= Math.abs(avgY - envTop);
      const outY = goBelow ? envBottom + Y_GAP * 1.2 : envTop - Y_GAP * 1.2;
      const outX = exitX + 60;
      const inX = entryX - 60;
      points.push({ x: exitX, y: sy });
      points.push({ x: outX, y: sy });
      points.push({ x: outX, y: outY });
      points.push({ x: inX, y: outY });
      points.push({ x: inX, y: ty });
      points.push({ x: entryX, y: ty });
    }
    return points;
  }

  // Multi-rank: snake through dummy positions, with mid-gap bends so the
  // edge doesn't run horizontally through any column.
  points.push({ x: exitX, y: sy });
  const first = dummyPos.get(chain[0]!)!;
  const firstMid = exitX + (first.x - exitX) * GAP_FRAC;
  points.push({ x: firstMid, y: sy });
  points.push({ x: firstMid, y: first.y });
  points.push({ x: first.x, y: first.y });
  for (let i = 1; i < chain.length; i++) {
    const prev = dummyPos.get(chain[i - 1]!)!;
    const cur = dummyPos.get(chain[i]!)!;
    const mid = prev.x + (cur.x - prev.x) * GAP_FRAC;
    points.push({ x: mid, y: prev.y });
    points.push({ x: mid, y: cur.y });
    points.push({ x: cur.x, y: cur.y });
  }
  const last = dummyPos.get(chain[chain.length - 1]!)!;
  const lastMid = last.x + (entryX - last.x) * GAP_FRAC;
  points.push({ x: lastMid, y: last.y });
  points.push({ x: lastMid, y: ty });
  points.push({ x: entryX, y: ty });
  return points;
}

// ──────────────────────────────────────────────────────────────────────────
// Normalisation
// ──────────────────────────────────────────────────────────────────────────

function computeNormalisationShift(positioned: PositionedNode[]): { dx: number; dy: number } {
  if (positioned.length === 0) return { dx: 0, dy: 0 };
  let minX = Infinity;
  let minY = Infinity;
  for (const p of positioned) {
    minX = Math.min(minX, p.x - p.width / 2);
    minY = Math.min(minY, p.y - p.height / 2);
  }
  const PAD = 60;
  return { dx: PAD - minX, dy: PAD - minY };
}
