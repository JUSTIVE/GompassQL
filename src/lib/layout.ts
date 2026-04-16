export interface LayoutNodeInput {
  id: string;
  width: number;
  height: number;
}

export interface LayoutEdgeInput {
  source: string;
  target: string;
}

export interface PositionedNode extends LayoutNodeInput {
  x: number;
  y: number;
}

const RANK_SEP = 320;
const NODE_SEP = 28;

/**
 * Topological-sort based layered layout.
 *
 * 1. BFS from `rootId` to assign a rank (depth) to each node.
 *    Cycles are handled naturally: already-visited nodes keep their
 *    earlier rank, so cycle edges become "back-edges" (right→left).
 * 2. Within each rank, nodes are reordered via the median heuristic
 *    (3 passes) to reduce edge crossings.
 * 3. Nodes in the same rank are stacked vertically, centered at y=0.
 */
export function layoutGraph(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
  rootId?: string,
): PositionedNode[] {
  if (nodes.length === 0) return [];

  const nodeSet = new Set(nodes.map((n) => n.id));
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.source === e.target) continue;
    if (!nodeSet.has(e.source) || !nodeSet.has(e.target)) continue;
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }

  // Detect root: prefer passed rootId, else node with 0 in-degree, else first.
  let root = rootId;
  if (!root || !nodeSet.has(root)) {
    const hasIncoming = new Set<string>();
    for (const e of edges) {
      if (nodeSet.has(e.target)) hasIncoming.add(e.target);
    }
    root = nodes.find((n) => !hasIncoming.has(n.id))?.id ?? nodes[0]?.id;
  }
  if (!root) return [];

  // BFS to assign ranks.
  const rank = new Map<string, number>();
  rank.set(root, 0);
  const queue: string[] = [root];
  let maxRank = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    const r = rank.get(id)!;
    for (const nb of adj.get(id) ?? []) {
      if (!rank.has(nb)) {
        rank.set(nb, r + 1);
        if (r + 1 > maxRank) maxRank = r + 1;
        queue.push(nb);
      }
    }
  }
  // Assign unreached nodes (shouldn't happen with reachability filter).
  for (const n of nodes) {
    if (!rank.has(n.id)) {
      rank.set(n.id, maxRank + 1);
      maxRank = maxRank + 1;
    }
  }

  // Group nodes by rank.
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const ranks = new Map<number, LayoutNodeInput[]>();
  for (const n of nodes) {
    const r = rank.get(n.id)!;
    if (!ranks.has(r)) ranks.set(r, []);
    ranks.get(r)!.push(n);
  }

  // Initial sort: alphabetical within each rank.
  for (const group of ranks.values()) {
    group.sort((a, b) => a.id.localeCompare(b.id));
  }

  // Edge crossing reduction: median heuristic, 4 forward+backward sweeps.
  for (let sweep = 0; sweep < 4; sweep++) {
    // Forward sweep (rank 1 → maxRank)
    for (let r = 1; r <= maxRank; r++) {
      reorderByMedian(ranks, edges, rank, r, r - 1);
    }
    // Backward sweep (maxRank-1 → 0)
    for (let r = maxRank - 1; r >= 0; r--) {
      reorderByMedian(ranks, edges, rank, r, r + 1);
    }
  }

  // Assign positions: x = rank * RANK_SEP, y = centered stack.
  const result: PositionedNode[] = [];
  for (const [r, group] of ranks) {
    const totalH =
      group.reduce((sum, n) => sum + n.height, 0) +
      (group.length - 1) * NODE_SEP;
    let y = -totalH / 2;
    for (const n of group) {
      result.push({
        id: n.id,
        width: n.width,
        height: n.height,
        x: r * RANK_SEP,
        y: y + n.height / 2,
      });
      y += n.height + NODE_SEP;
    }
  }

  return result;
}

/**
 * Reorder nodes in `targetRank` so that each node's median position among
 * its neighbours in `refRank` determines sort order. Reduces edge crossings.
 */
function reorderByMedian(
  ranks: Map<number, LayoutNodeInput[]>,
  edges: LayoutEdgeInput[],
  nodeRank: Map<string, number>,
  targetRank: number,
  refRank: number,
) {
  const group = ranks.get(targetRank);
  const refGroup = ranks.get(refRank);
  if (!group || !refGroup) return;

  const refPos = new Map<string, number>();
  refGroup.forEach((n, i) => refPos.set(n.id, i));

  const medians = new Map<string, number>();
  for (const n of group) {
    const positions: number[] = [];
    for (const e of edges) {
      if (e.target === n.id && refPos.has(e.source)) {
        positions.push(refPos.get(e.source)!);
      }
      if (e.source === n.id && refPos.has(e.target)) {
        positions.push(refPos.get(e.target)!);
      }
    }
    if (positions.length > 0) {
      positions.sort((a, b) => a - b);
      medians.set(
        n.id,
        positions[Math.floor(positions.length / 2)]!,
      );
    }
  }

  group.sort((a, b) => {
    const ma = medians.get(a.id);
    const mb = medians.get(b.id);
    if (ma !== undefined && mb !== undefined) return ma - mb;
    if (ma !== undefined) return -1;
    if (mb !== undefined) return 1;
    return 0;
  });
}
