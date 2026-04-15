import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from "d3-force";
import type { Edge, Node } from "@xyflow/react";

interface SimNode {
  id: string;
  width: number;
  height: number;
  x: number;
  y: number;
}

interface SimLink {
  source: string | SimNode;
  target: string | SimNode;
}

export function layoutGraph<T extends Node>(nodes: T[], edges: Edge[]): T[] {
  if (nodes.length === 0) return nodes;

  const n = nodes.length;
  const radius = Math.max(300, Math.sqrt(n) * 140);

  const simNodes: SimNode[] = nodes.map((node, i) => {
    const angle = (i / n) * Math.PI * 2;
    return {
      id: node.id,
      width: node.width ?? 220,
      height: node.height ?? 100,
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
        .distance(160)
        .strength(0.25),
    )
    .force("charge", forceManyBody<SimNode>().strength(-900).distanceMax(1200))
    .force("center", forceCenter<SimNode>(0, 0))
    .force("x", forceX<SimNode>(0).strength(0.03))
    .force("y", forceY<SimNode>(0).strength(0.03))
    .force(
      "collide",
      forceCollide<SimNode>()
        .radius((d) => Math.hypot(d.width, d.height) / 2 + 8)
        .strength(1)
        .iterations(2),
    )
    .stop();

  const ticks = Math.min(600, Math.max(180, Math.ceil(Math.sqrt(n) * 60)));
  for (let i = 0; i < ticks; i++) sim.tick();

  const byId = new Map<string, SimNode>();
  for (const sn of simNodes) byId.set(sn.id, sn);

  return nodes.map((node) => {
    const sn = byId.get(node.id);
    if (!sn) return node;
    const w = node.width ?? 220;
    const h = node.height ?? 100;
    return { ...node, position: { x: sn.x - w / 2, y: sn.y - h / 2 } };
  });
}
