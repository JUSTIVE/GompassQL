import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from "d3-force";

export interface LayoutNodeInput {
  id: string;
  width: number;
  height: number;
}

export interface LayoutEdgeInput {
  source: string;
  target: string;
  kind?: string;
}

export interface PositionedNode extends LayoutNodeInput {
  x: number;
  y: number;
}

const RANK_SEP = 450;

/**
 * Hybrid layout: BFS rank gives horizontal structure, d3-force handles
 * vertical positioning and edge-aware relaxation. Cycles are visible as
 * short back-edges rather than hidden by strict layering.
 */
export function layoutGraph(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
  rootId?: string,
): PositionedNode[] {
  if (nodes.length === 0) return [];

  const n = nodes.length;
  const nodeSet = new Set(nodes.map((nd) => nd.id));

  // BFS to assign ranks.
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.source === e.target) continue;
    if (!nodeSet.has(e.source) || !nodeSet.has(e.target)) continue;
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }

  let root = rootId;
  if (!root || !nodeSet.has(root)) {
    const hasIncoming = new Set<string>();
    for (const e of edges) {
      if (nodeSet.has(e.target)) hasIncoming.add(e.target);
    }
    root = nodes.find((nd) => !hasIncoming.has(nd.id))?.id ?? nodes[0]?.id;
  }
  if (!root) return [];

  const rank = new Map<string, number>();
  rank.set(root, 0);
  const queue: string[] = [root];
  let maxRank = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    const r = rank.get(id)!;
    for (const nb of adj.get(id) ?? []) {
      if (!rank.has(nb)) {
        const nr = r + 1;
        rank.set(nb, nr);
        if (nr > maxRank) maxRank = nr;
        queue.push(nb);
      }
    }
  }
  for (const nd of nodes) {
    if (!rank.has(nd.id)) {
      rank.set(nd.id, maxRank + 1);
    }
  }

  // Count nodes per rank for initial vertical spread.
  const rankCount = new Map<number, number>();
  const rankIndex = new Map<string, number>();
  for (const nd of nodes) {
    const r = rank.get(nd.id)!;
    const idx = rankCount.get(r) ?? 0;
    rankCount.set(r, idx + 1);
    rankIndex.set(nd.id, idx);
  }

  interface SimNode extends LayoutNodeInput {
    x: number;
    y: number;
    targetX: number;
  }
  interface SimLink {
    source: string | SimNode;
    target: string | SimNode;
  }

  const simNodes: SimNode[] = nodes.map((nd) => {
    const r = rank.get(nd.id)!;
    const count = rankCount.get(r)!;
    const idx = rankIndex.get(nd.id)!;
    const spreadY = (idx - (count - 1) / 2) * (nd.height + 40);
    const isRoot = nd.id === root;
    return {
      ...nd,
      x: r * RANK_SEP,
      y: isRoot ? 0 : spreadY,
      targetX: r * RANK_SEP,
      fx: isRoot ? 0 : undefined,
      fy: isRoot ? 0 : undefined,
    } as SimNode;
  });

  const simLinks: SimLink[] = edges
    .filter((e) => e.source !== e.target && nodeSet.has(e.source) && nodeSet.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }));

  // Extra tight links between members of the same union.
  const unionMembers = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind === "union" && nodeSet.has(e.source) && nodeSet.has(e.target)) {
      if (!unionMembers.has(e.source)) unionMembers.set(e.source, []);
      unionMembers.get(e.source)!.push(e.target);
    }
  }
  const unionPairLinks: SimLink[] = [];
  for (const members of unionMembers.values()) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        unionPairLinks.push({ source: members[i]!, target: members[j]! });
      }
    }
  }

  // Compute clusters for distance-based grouping.
  const clusters = buildClusters(nodes, edges, nodeSet);
  const clusterOf = new Map<string, string>();
  for (const [root, members] of clusters) {
    for (const id of members) clusterOf.set(id, root);
  }

  // Similarity links pull same-cluster nodes together tightly.
  const similarityLinks = buildSimilarityLinks(nodes, edges, nodeSet);
  const allLinks: SimLink[] = [...simLinks, ...similarityLinks, ...unionPairLinks];

  const unionPairSet = new Set(
    unionPairLinks.map((l) => `${(l.source as string)}-${(l.target as string)}`),
  );

  const sim = forceSimulation<SimNode>(simNodes)
    .force(
      "link",
      forceLink<SimNode, SimLink>(allLinks)
        .id((d) => d.id)
        .distance((l) => {
          const link = l as SimLink & { _similarity?: boolean };
          if (link._similarity) return 50;
          const s = (l.source as SimNode).id;
          const t = (l.target as SimNode).id;
          const key = `${s}-${t}`;
          if (unionPairSet.has(key)) return 40;
          const sameCluster = clusterOf.get(s) === clusterOf.get(t);
          return sameCluster ? 140 : 320;
        })
        .strength((l) => {
          const link = l as SimLink & { _similarity?: boolean; _weight?: number };
          if (link._similarity) return (link._weight ?? 0.1) * 0.5;
          const s = (l.source as SimNode).id;
          const t = (l.target as SimNode).id;
          const key = `${s}-${t}`;
          if (unionPairSet.has(key)) return 0.6;
          const sameCluster = clusterOf.get(s) === clusterOf.get(t);
          return sameCluster ? 0.25 : 0.08;
        }),
    )
    .force("charge", forceManyBody<SimNode>().strength(-700).distanceMax(1500))
    .force(
      "rankX",
      forceX<SimNode>().x((d) => d.targetX).strength(0.6),
    )
    .force("centerY", forceY<SimNode>(0).strength(0.03))
    .force(
      "collide",
      forceCollide<SimNode>()
        .radius((d) => Math.max(d.width, d.height) / 2 + 20)
        .strength(1)
        .iterations(4),
    )
    .stop();

  const ticks = Math.min(500, Math.max(200, Math.ceil(Math.sqrt(n) * 60)));
  for (let i = 0; i < ticks; i++) sim.tick();

  resolveOverlaps(simNodes);

  return simNodes.map((sn) => ({
    id: sn.id,
    width: sn.width,
    height: sn.height,
    x: sn.x,
    y: sn.y,
  }));
}

/**
 * Build invisible "similarity" links between nodes that share neighbours.
 * The more neighbours two nodes share (Jaccard), the stronger the attraction.
 * Only emits links above a threshold to avoid quadratic blowup.
 */
/**
 * Build clusters via union-find on Jaccard-similar node pairs.
 * Returns Map<clusterRoot, Set<nodeId>>.
 */
function buildClusters(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
  nodeSet: Set<string>,
): Map<string, Set<string>> {
  const neighbours = new Map<string, Set<string>>();
  for (const nd of nodes) neighbours.set(nd.id, new Set());
  for (const e of edges) {
    if (e.source === e.target) continue;
    if (!nodeSet.has(e.source) || !nodeSet.has(e.target)) continue;
    neighbours.get(e.source)?.add(e.target);
    neighbours.get(e.target)?.add(e.source);
  }

  const parent = new Map<string, string>();
  for (const nd of nodes) parent.set(nd.id, nd.id);
  const find = (a: string): string => {
    while (parent.get(a) !== a) {
      parent.set(a, parent.get(parent.get(a)!)!);
      a = parent.get(a)!;
    }
    return a;
  };
  const union = (a: string, b: string) => {
    parent.set(find(a), find(b));
  };

  const ids = nodes.map((nd) => nd.id);
  for (let i = 0; i < ids.length; i++) {
    const nA = neighbours.get(ids[i]!)!;
    if (nA.size === 0) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const nB = neighbours.get(ids[j]!)!;
      if (nB.size === 0) continue;
      let inter = 0;
      for (const x of nA) if (nB.has(x)) inter++;
      if (inter === 0) continue;
      const jaccard = inter / (nA.size + nB.size - inter);
      if (jaccard >= 0.15) union(ids[i]!, ids[j]!);
    }
  }

  const groups = new Map<string, Set<string>>();
  for (const nd of nodes) {
    const root = find(nd.id);
    if (!groups.has(root)) groups.set(root, new Set());
    groups.get(root)!.add(nd.id);
  }
  return groups;
}

function buildSimilarityLinks(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
  nodeSet: Set<string>,
): Array<{ source: string; target: string; _similarity: true; _weight: number }> {
  const neighbours = new Map<string, Set<string>>();
  for (const nd of nodes) neighbours.set(nd.id, new Set());

  for (const e of edges) {
    if (e.source === e.target) continue;
    if (!nodeSet.has(e.source) || !nodeSet.has(e.target)) continue;
    neighbours.get(e.source)?.add(e.target);
    neighbours.get(e.target)?.add(e.source);
  }

  const result: Array<{ source: string; target: string; _similarity: true; _weight: number }> = [];
  const ids = nodes.map((nd) => nd.id);

  for (let i = 0; i < ids.length; i++) {
    const a = ids[i]!;
    const nA = neighbours.get(a)!;
    if (nA.size === 0) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const b = ids[j]!;
      const nB = neighbours.get(b)!;
      if (nB.size === 0) continue;

      let intersection = 0;
      for (const x of nA) {
        if (nB.has(x)) intersection++;
      }
      if (intersection === 0) continue;

      const union = nA.size + nB.size - intersection;
      const jaccard = intersection / union;
      if (jaccard < 0.15) continue;

      result.push({
        source: a,
        target: b,
        _similarity: true,
        _weight: jaccard * 0.25,
      });
    }
  }

  return result;
}

function resolveOverlaps(nodes: Array<{ id: string; width: number; height: number; x: number; y: number }>) {
  const PAD = 20;
  for (let iter = 0; iter < 120; iter++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]!;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]!;
        const minDx = (a.width + b.width) / 2 + PAD;
        const minDy = (a.height + b.height) / 2 + PAD;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const overlapX = minDx - Math.abs(dx);
        const overlapY = minDy - Math.abs(dy);
        if (overlapX > 0 && overlapY > 0) {
          const push = overlapY / 2 + 1;
          if (dy >= 0) {
            a.y -= push;
            b.y += push;
          } else {
            a.y += push;
            b.y -= push;
          }
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
}
