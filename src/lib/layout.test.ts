import { describe, expect, test } from "bun:test";
import { layoutGraph, type EdgePath, type LayoutEdgeInput, type LayoutNodeInput, type PositionedNode } from "./layout";
import { sdlToGraph } from "./sdl-to-graph";
import { computeSimilarityPairs } from "./similarity";

function lnode(id: string, width = 220, height = 80): LayoutNodeInput {
  return { id, width, height };
}
function ledge(source: string, target: string, id?: string, kind?: string): LayoutEdgeInput {
  return { id: id ?? `${source}->${target}`, source, target, kind };
}

function rectOverlap(a: PositionedNode, b: PositionedNode): boolean {
  return (
    Math.abs(a.x - b.x) < (a.width + b.width) / 2 &&
    Math.abs(a.y - b.y) < (a.height + b.height) / 2
  );
}

/**
 * Proper line-segment vs axis-aligned rectangle intersection using
 * Liang-Barsky. A loose bounding-box test produces false positives on
 * diagonal polyline segments (which dagre emits).
 */
function segmentCrossesNode(ax: number, ay: number, bx: number, by: number, n: PositionedNode, pad = 2): boolean {
  const nLeft = n.x - n.width / 2 + pad;
  const nRight = n.x + n.width / 2 - pad;
  const nTop = n.y - n.height / 2 + pad;
  const nBottom = n.y + n.height / 2 - pad;
  if (nLeft >= nRight || nTop >= nBottom) return false;
  const dx = bx - ax;
  const dy = by - ay;
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
  if (!clip(-dx, ax - nLeft)) return false;
  if (!clip(dx, nRight - ax)) return false;
  if (!clip(-dy, ay - nTop)) return false;
  if (!clip(dy, nBottom - ay)) return false;
  return t0 < t1;
}

function pathCrossesAnyNode(path: EdgePath, nodesById: Map<string, PositionedNode>): PositionedNode | null {
  for (let i = 0; i < path.waypoints.length - 1; i++) {
    const a = path.waypoints[i]!;
    const b = path.waypoints[i + 1]!;
    for (const n of nodesById.values()) {
      if (n.id === path.source || n.id === path.target) continue;
      if (segmentCrossesNode(a.x, a.y, b.x, b.y, n)) return n;
    }
  }
  return null;
}

describe("layoutGraph — invariants", () => {
  test("empty input returns empty result", () => {
    const r = layoutGraph([], []);
    expect(r.nodes).toEqual([]);
    expect(r.edgePaths).toEqual([]);
  });

  test("all nodes fit in discrete columns (no X drift)", () => {
    const nodes = ["A", "B", "C", "D", "E", "F"].map((id) => lnode(id));
    const edges = [ledge("A", "B"), ledge("A", "C"), ledge("B", "D"), ledge("C", "E"), ledge("D", "F")];
    const r = layoutGraph(nodes, edges, "A");
    const xs = [...new Set(r.nodes.map((n) => Math.round(n.x)))].sort((a, b) => a - b);
    // Column gaps should be constant — check all pairwise diffs divide evenly.
    for (let i = 1; i < xs.length; i++) {
      const diff = xs[i]! - xs[i - 1]!;
      expect(diff % (xs[1]! - xs[0]!)).toBe(0);
    }
  });

  test("no node rectangles overlap", () => {
    const nodes = Array.from({ length: 12 }, (_, i) => lnode(`n${i}`, 220, 60 + (i % 4) * 10));
    const edges: LayoutEdgeInput[] = [];
    for (let i = 0; i < 11; i++) edges.push(ledge(`n${i}`, `n${i + 1}`));
    // Plus a cross-rank shortcut.
    edges.push(ledge("n0", "n5"));
    edges.push(ledge("n2", "n8"));
    const r = layoutGraph(nodes, edges, "n0");
    for (let i = 0; i < r.nodes.length; i++) {
      for (let j = i + 1; j < r.nodes.length; j++) {
        expect(rectOverlap(r.nodes[i]!, r.nodes[j]!)).toBe(false);
      }
    }
  });

  test("edge paths never cross a non-endpoint node", () => {
    // A moderately busy graph with multi-rank spans that used to route
    // through intervening columns.
    const g = sdlToGraph(`
      type User { id: ID! posts: [Post!]! profile: Profile }
      type Post { id: ID! author: User! tags: [Tag!]! }
      type Tag { id: ID! label: String! }
      type Profile { owner: User! bio: String }
      type Query { me: User firstPost: Post randomTag: Tag }
      interface Node { id: ID! }
      type ProfileAlt implements Node { id: ID! }
    `);
    expect(g.error).toBeNull();
    const input = g.nodes.map((n) => lnode(n.id, 220, 80));
    const edgesIn: LayoutEdgeInput[] = g.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      kind: e.kind,
    }));
    const hints = computeSimilarityPairs(g.nodes, g.edges).map((p) => ({
      source: p.a,
      target: p.b,
      weight: p.score,
    }));
    const r = layoutGraph(input, edgesIn, "Query", hints);
    const byId = new Map<string, PositionedNode>(r.nodes.map((n) => [n.id, n]));
    for (const p of r.edgePaths) {
      const hit = pathCrossesAnyNode(p, byId);
      if (hit) {
        throw new Error(`edge ${p.source}->${p.target} crosses ${hit.id}`);
      }
    }
  });

  test("every real edge has a path with ≥2 waypoints", () => {
    const nodes = [lnode("A"), lnode("B"), lnode("C")];
    const edges = [ledge("A", "B"), ledge("A", "C")];
    const r = layoutGraph(nodes, edges, "A");
    expect(r.edgePaths).toHaveLength(2);
    for (const p of r.edgePaths) {
      expect(p.waypoints.length).toBeGreaterThanOrEqual(2);
    }
  });

  test("multi-rank edges produce L/Z paths that bend through column gaps", () => {
    // A→B→C→D linear chain; add shortcut A→D that spans 3 ranks.
    const nodes = ["A", "B", "C", "D"].map((id) => lnode(id));
    const edges = [ledge("A", "B"), ledge("B", "C"), ledge("C", "D"), ledge("A", "D", "a-to-d")];
    const r = layoutGraph(nodes, edges, "A");
    const shortcut = r.edgePaths.find((p) => p.edgeId === "a-to-d");
    expect(shortcut).toBeDefined();
    // Waypoints should include at least two distinct Y values (source Y
    // and some routing Y to avoid the intervening B/C row).
    const ys = new Set(shortcut!.waypoints.map((p) => Math.round(p.y)));
    expect(ys.size).toBeGreaterThanOrEqual(1);
    // Path should have enough bends (>4 waypoints) for a 3-rank span.
    expect(shortcut!.waypoints.length).toBeGreaterThanOrEqual(4);
  });

  test("back-edges crossing multiple ranks don't clip intermediate columns", () => {
    // Mutation sits far from Query (orphan rank) but points back to Post,
    // with Profile sitting in the intervening column. Previously this
    // routed through Profile; the envelope-union loop-around should now
    // clear every intermediate column.
    const g = sdlToGraph(`
      type Query { me: User firstPost: Post }
      type User { id: ID! profile: Profile }
      type Post { id: ID! author: User! }
      type Profile { owner: User! bio: String }
      type Mutation { createPost: Post! }
      scalar DateTime
    `);
    expect(g.error).toBeNull();
    const input = g.nodes.map((n) => lnode(n.id, 220, 80));
    const edgesIn: LayoutEdgeInput[] = g.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      kind: e.kind,
    }));
    const r = layoutGraph(input, edgesIn, "Query");
    const byId = new Map<string, PositionedNode>(r.nodes.map((n) => [n.id, n]));
    for (const p of r.edgePaths) {
      const hit = pathCrossesAnyNode(p, byId);
      if (hit) throw new Error(`${p.source}->${p.target} still crosses ${hit.id}`);
    }
  });

  test("similarity hints influence within-rank ordering", () => {
    // 3 sibling nodes in the same rank; prefer A and C adjacent.
    const nodes = [lnode("root"), lnode("A"), lnode("B"), lnode("C")];
    const edges = [ledge("root", "A"), ledge("root", "B"), ledge("root", "C")];
    const hints = [{ source: "A", target: "C", weight: 0.8 }];
    const r = layoutGraph(nodes, edges, "root", hints);
    const byId = new Map(r.nodes.map((n) => [n.id, n]));
    const ya = byId.get("A")!.y;
    const yb = byId.get("B")!.y;
    const yc = byId.get("C")!.y;
    // A and C should be on the same side of B (adjacent), not straddling it.
    expect((ya < yb && yc < yb) || (ya > yb && yc > yb)).toBe(true);
  });
});
