import {
  forceCenter,
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
}

export interface PositionedNode extends LayoutNodeInput {
  /** Node center x */
  x: number;
  /** Node center y */
  y: number;
}

interface SimNode extends LayoutNodeInput {
  x: number;
  y: number;
}

interface SimLink {
  source: string | SimNode;
  target: string | SimNode;
}

export function layoutGraph(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
): PositionedNode[] {
  if (nodes.length === 0) return [];

  const n = nodes.length;
  const radius = Math.max(300, Math.sqrt(n) * 140);

  const simNodes: SimNode[] = nodes.map((node, i) => {
    const angle = (i / n) * Math.PI * 2;
    return {
      ...node,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    };
  });

  const simLinks: SimLink[] = edges
    .filter((e) => e.source !== e.target)
    .map((e) => ({ source: e.source, target: e.target }));

  const sim = forceSimulation<SimNode>(simNodes)
    .force(
      "link",
      forceLink<SimNode, SimLink>(simLinks)
        .id((d) => d.id)
        .distance((l) => {
          const s = l.source as SimNode;
          const t = l.target as SimNode;
          return (
            Math.hypot(s.width, s.height) / 2 +
            Math.hypot(t.width, t.height) / 2 +
            80
          );
        })
        .strength(0.3),
    )
    .force(
      "charge",
      forceManyBody<SimNode>().strength(-1100).distanceMax(1500),
    )
    .force("center", forceCenter<SimNode>(0, 0))
    .force("x", forceX<SimNode>(0).strength(0.03))
    .force("y", forceY<SimNode>(0).strength(0.03))
    .force(
      "collide",
      forceCollide<SimNode>()
        .radius((d) => Math.hypot(d.width, d.height) / 2 + 12)
        .strength(1)
        .iterations(3),
    )
    .stop();

  const ticks = Math.min(600, Math.max(200, Math.ceil(Math.sqrt(n) * 70)));
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
 * Iteratively separate any axis-aligned rectangles that still overlap
 * after the force simulation. Ensures the "no overlap" hard guarantee.
 */
function resolveOverlaps(nodes: SimNode[]) {
  const PAD = 14;
  const MAX_ITER = 80;
  for (let iter = 0; iter < MAX_ITER; iter++) {
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
          if (overlapX < overlapY) {
            const push = overlapX / 2;
            if (dx >= 0) {
              a.x -= push;
              b.x += push;
            } else {
              a.x += push;
              b.x -= push;
            }
          } else {
            const push = overlapY / 2;
            if (dy >= 0) {
              a.y -= push;
              b.y += push;
            } else {
              a.y += push;
              b.y -= push;
            }
          }
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
}
