import { describe, expect, test } from "bun:test";
import {
  layoutGraph,
  type LayoutEdgeInput,
  type LayoutNodeInput,
} from "./layout";

function lnode(id: string, width = 220, height = 80): LayoutNodeInput {
  return { id, width, height };
}

function ledge(source: string, target: string, id?: string): LayoutEdgeInput {
  return { id: id ?? `${source}->${target}`, source, target };
}

describe("layoutGraph (GraphViz)", () => {
  test("returns empty result for empty input without invoking the engine", async () => {
    const r = await layoutGraph([], []);
    expect(r.nodes).toEqual([]);
    expect(r.edgePaths).toEqual([]);
  });

  test("positions every node and emits bezier segments per real edge", async () => {
    const nodes = [lnode("root"), lnode("A"), lnode("B"), lnode("C")];
    const edges = [ledge("root", "A"), ledge("root", "B"), ledge("root", "C")];
    const r = await layoutGraph(nodes, edges, "root");

    expect(r.nodes).toHaveLength(4);
    const byId = new Map(r.nodes.map((n) => [n.id, n]));
    for (const n of nodes) {
      const laid = byId.get(n.id);
      expect(laid).toBeDefined();
      expect(Number.isFinite(laid!.x)).toBe(true);
      expect(Number.isFinite(laid!.y)).toBe(true);
    }

    expect(r.edgePaths).toHaveLength(3);
    for (const p of r.edgePaths) {
      expect(p.segments.length).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(p.start.x)).toBe(true);
      expect(Number.isFinite(p.start.y)).toBe(true);
      for (const seg of p.segments) {
        expect(Number.isFinite(seg.c1.x)).toBe(true);
        expect(Number.isFinite(seg.c2.x)).toBe(true);
        expect(Number.isFinite(seg.end.x)).toBe(true);
      }
    }
  });

  test("places LR-layered targets to the right of their source", async () => {
    const nodes = [lnode("a"), lnode("b"), lnode("c")];
    const edges = [ledge("a", "b"), ledge("b", "c")];
    const r = await layoutGraph(nodes, edges);
    const byId = new Map(r.nodes.map((n) => [n.id, n]));
    expect(byId.get("a")!.x).toBeLessThan(byId.get("b")!.x);
    expect(byId.get("b")!.x).toBeLessThan(byId.get("c")!.x);
  });

  test("hint pseudo-edges are not returned as visible paths", async () => {
    const nodes = [lnode("root"), lnode("A"), lnode("B"), lnode("C")];
    const edges = [ledge("root", "A"), ledge("root", "B"), ledge("root", "C")];
    const hints = [{ source: "A", target: "C", weight: 0.8 }];
    const r = await layoutGraph(nodes, edges, "root", hints);
    expect(r.edgePaths).toHaveLength(3);
    for (const p of r.edgePaths) {
      expect(p.source === "root").toBe(true);
    }
  });
});
