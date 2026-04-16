import dagre from "@dagrejs/dagre";

/**
 * Thin wrapper around dagre that accepts our layout inputs, injects
 * similarity hints as weak pseudo-edges (so dagre's crossing-reduction
 * pulls clustered nodes adjacent), runs the layered layout, and returns
 * positions plus dagre's own edge waypoints.
 *
 * Keeping the surrounding interfaces stable means `SchemaCanvas`
 * consumes this result without changes.
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

const HINT_EDGE_PREFIX = "__hint__";
// Real edges carry weight 4 so the hint pseudo-edges (weight up to 1)
// never outrank real structure in dagre's ordering and ranking phases.
const REAL_EDGE_WEIGHT = 4;

export function layoutGraph(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
  rootId?: string,
  similarityHints?: SimilarityHint[],
): LayoutResult {
  if (nodes.length === 0) return { nodes: [], edgePaths: [] };

  const g = new dagre.graphlib.Graph({ multigraph: true, directed: true });
  g.setGraph({
    // Left-to-right layered layout. Generous nodesep/edgesep gives
    // dagre room to place its virtual-edge control points well clear
    // of real node rectangles, so the straight segments between
    // consecutive control points don't need to re-route to avoid
    // neighbours in the same column.
    rankdir: "LR",
    ranksep: 160,
    nodesep: 80,
    edgesep: 40,
    marginx: 60,
    marginy: 60,
    acyclicer: "greedy",
    ranker: "network-simplex",
  });
  g.setDefaultEdgeLabel(() => ({}));

  const nodeSet = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    g.setNode(n.id, { width: n.width, height: n.height });
  }

  const edgeIdByKey = new Map<string, string>();
  const realEdges = edges.filter(
    (e) => e.source !== e.target && nodeSet.has(e.source) && nodeSet.has(e.target),
  );
  realEdges.forEach((e, i) => {
    const name = e.id ?? `e${i}:${e.source}->${e.target}`;
    edgeIdByKey.set(name, e.id ?? name);
    g.setEdge(e.source, e.target, { weight: REAL_EDGE_WEIGHT, minlen: 1 }, name);
  });

  // Inject similarity hints as weak pseudo-edges. Low weight (< real)
  // means they only influence crossing reduction and barycenter
  // ordering — they don't override real structural ranks. minlen: 1
  // matches real edges (dagre rejects minlen 0 with some failure
  // modes on same-rank endpoints). When source/target happen to be
  // siblings at the same rank, dagre's acyclicer reverses and the
  // hint simply biases ordering in its layer.
  if (similarityHints) {
    const realPairs = new Set<string>();
    for (const e of realEdges) {
      realPairs.add(`${e.source}|${e.target}`);
      realPairs.add(`${e.target}|${e.source}`);
    }
    let hintCounter = 0;
    for (const h of similarityHints) {
      if (h.weight <= 0) continue;
      if (!nodeSet.has(h.source) || !nodeSet.has(h.target)) continue;
      if (h.source === h.target) continue;
      const key = `${h.source}|${h.target}`;
      if (realPairs.has(key)) continue;
      const name = `${HINT_EDGE_PREFIX}${hintCounter++}`;
      g.setEdge(
        h.source,
        h.target,
        { weight: Math.max(0.05, Math.min(1, h.weight)), minlen: 1 },
        name,
      );
      realPairs.add(key);
      realPairs.add(`${h.target}|${h.source}`);
    }
  }

  // `rootId` is informational in a dagre-driven layout — the network
  // simplex ranker picks ranks from the edge structure. We don't need
  // to override anything; BFS from rootId is not how dagre works.
  void rootId;

  dagre.layout(g);

  // Extract node positions.
  const positioned: PositionedNode[] = [];
  for (const n of nodes) {
    const laid = g.node(n.id);
    if (!laid) continue;
    positioned.push({
      id: n.id,
      width: n.width,
      height: n.height,
      x: laid.x,
      y: laid.y,
    });
  }

  // Extract edge waypoints (skip hint pseudo-edges). dagre's polyline
  // mostly threads through reserved column Y-slots, but a few diagonals
  // still graze neighbour nodes in densely-packed layouts. Post-process
  // each segment: if it clips a non-endpoint node, insert an L-detour
  // around that node and re-check. Segments that are already clear pass
  // through unchanged — we keep dagre's diagonals wherever they work.
  const paths: EdgePath[] = [];
  for (const edgeObj of g.edges()) {
    if (edgeObj.name && edgeObj.name.startsWith(HINT_EDGE_PREFIX)) continue;
    const e = g.edge(edgeObj) as { points?: Array<{ x: number; y: number }> };
    if (!e || !e.points || e.points.length < 2) continue;
    const edgeId = (edgeObj.name && edgeIdByKey.get(edgeObj.name)) || edgeObj.name || `${edgeObj.v}->${edgeObj.w}`;
    const raw = e.points.map((p) => ({ x: p.x, y: p.y }));
    const detoured = detourAroundNodes(raw, edgeObj.v, edgeObj.w, positioned);
    paths.push({
      edgeId,
      source: edgeObj.v,
      target: edgeObj.w,
      waypoints: detoured,
    });
  }

  return { nodes: positioned, edgePaths: paths };
}

const DETOUR_PAD = 12;
const DETOUR_MAX_ITERS = 16;

/**
 * Liang-Barsky line-segment vs axis-aligned rect intersection. Returns
 * the node whose rectangle the segment clips (excluding the src/tgt of
 * the current edge), or null when clear.
 */
function firstBlocker(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  srcId: string,
  tgtId: string,
  nodes: PositionedNode[],
): PositionedNode | null {
  const dx = bx - ax;
  const dy = by - ay;
  let best: PositionedNode | null = null;
  let bestT = Infinity;
  for (const n of nodes) {
    if (n.id === srcId || n.id === tgtId) continue;
    const nL = n.x - n.width / 2;
    const nR = n.x + n.width / 2;
    const nT = n.y - n.height / 2;
    const nB = n.y + n.height / 2;
    let t0 = 0;
    let t1 = 1;
    const clip = (p: number, q: number): boolean => {
      if (p === 0) return q >= 0;
      const t = q / p;
      if (p < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
      return true;
    };
    if (!clip(-dx, ax - nL)) continue;
    if (!clip(dx, nR - ax)) continue;
    if (!clip(-dy, ay - nT)) continue;
    if (!clip(dy, nB - ay)) continue;
    if (t0 >= t1) continue;
    // Closest blocker wins — use entry parameter t0.
    if (t0 < bestT) {
      bestT = t0;
      best = n;
    }
  }
  return best;
}

/**
 * Walk the polyline. For each segment that clips a node, try a Z-detour
 * above AND below the blocker, pick whichever resulting three-segment
 * path is fully clear (no sub-segment clips the blocker). Repeat until
 * stable or DETOUR_MAX_ITERS.
 */
function detourAroundNodes(
  raw: EdgePathPoint[],
  srcId: string,
  tgtId: string,
  nodes: PositionedNode[],
): EdgePathPoint[] {
  let pts: EdgePathPoint[] = raw.slice();
  for (let iter = 0; iter < DETOUR_MAX_ITERS; iter++) {
    let changed = false;
    const out: EdgePathPoint[] = [pts[0]!];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const blocker = firstBlocker(a.x, a.y, b.x, b.y, srcId, tgtId, nodes);
      if (!blocker) {
        out.push(b);
        continue;
      }
      const top = blocker.y - blocker.height / 2 - DETOUR_PAD;
      const bottom = blocker.y + blocker.height / 2 + DETOUR_PAD;
      const tryRoute = (routeY: number): [EdgePathPoint, EdgePathPoint] | null => {
        const p1: EdgePathPoint = { x: a.x, y: routeY };
        const p2: EdgePathPoint = { x: b.x, y: routeY };
        if (firstBlocker(a.x, a.y, p1.x, p1.y, srcId, tgtId, nodes)) return null;
        if (firstBlocker(p1.x, p1.y, p2.x, p2.y, srcId, tgtId, nodes)) return null;
        if (firstBlocker(p2.x, p2.y, b.x, b.y, srcId, tgtId, nodes)) return null;
        return [p1, p2];
      };
      const midY = (a.y + b.y) / 2;
      const firstSide = Math.abs(midY - top) <= Math.abs(midY - bottom) ? top : bottom;
      const secondSide = firstSide === top ? bottom : top;
      const detour = tryRoute(firstSide) ?? tryRoute(secondSide);
      if (!detour) {
        // Neither side cleared — leave the segment as-is. A future
        // iteration or a different blocker may fix it, but avoid an
        // infinite loop.
        out.push(b);
        continue;
      }
      out.push(detour[0]);
      out.push(detour[1]);
      out.push(b);
      changed = true;
    }
    pts = out;
    if (!changed) break;
  }
  return pts;
}
