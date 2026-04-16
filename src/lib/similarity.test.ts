import { describe, expect, test } from "bun:test";
import { sdlToGraph } from "./sdl-to-graph";
import { computeSimilarityPairs, type SimilarityPair } from "./similarity";

function pair(pairs: SimilarityPair[], a: string, b: string): SimilarityPair | undefined {
  return pairs.find(
    (p) => (p.a === a && p.b === b) || (p.a === b && p.b === a),
  );
}

function fromSdl(sdl: string) {
  const g = sdlToGraph(sdl);
  expect(g.error).toBeNull();
  return computeSimilarityPairs(g.nodes, g.edges);
}

describe("computeSimilarityPairs — union member adjacency", () => {
  test("pairs every member of a union with every other member", () => {
    const sdl = `
      type A { x: Int }
      type B { y: Int }
      type C { z: Int }
      union ABC = A | B | C
      type Query { it: ABC }
    `;
    const pairs = fromSdl(sdl);
    expect(pair(pairs, "A", "B")).toBeDefined();
    expect(pair(pairs, "B", "C")).toBeDefined();
    expect(pair(pairs, "A", "C")).toBeDefined();
    expect(pairs.length).toBe(3);
  });

  test("no pairs when there are no unions", () => {
    const sdl = `
      interface Node { id: ID! }
      type User implements Node { id: ID! name: String! }
      type Post implements Node { id: ID! title: String! }
      input CreateUserInput { name: String! }
      input UpdateUserInput { id: ID! name: String }
      type Query { me: User }
    `;
    const pairs = fromSdl(sdl);
    expect(pairs).toEqual([]);
  });

  test("shared members across two unions reinforce", () => {
    const sdl = `
      type A { x: Int }
      type B { y: Int }
      type C { z: Int }
      union U1 = A | B
      union U2 = A | B | C
      type Query { a: U1 b: U2 }
    `;
    const pairs = fromSdl(sdl);
    const ab = pair(pairs, "A", "B")!;
    const bc = pair(pairs, "B", "C")!;
    expect(ab).toBeDefined();
    expect(bc).toBeDefined();
    expect(ab.score).toBeGreaterThan(bc.score);
    expect(ab.reasons.length).toBe(2);
  });

  test("scores stay within 0..1 and output is sorted by descending score", () => {
    const sdl = `
      type A { x: Int }
      type B { y: Int }
      type C { z: Int }
      union U1 = A | B
      union U2 = A | B | C
    `;
    const pairs = fromSdl(sdl);
    for (const p of pairs) {
      expect(p.score).toBeGreaterThan(0);
      expect(p.score).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i - 1]!.score).toBeGreaterThanOrEqual(pairs[i]!.score);
    }
  });

  test("unions referencing undeclared types are safely ignored", () => {
    const sdl = `
      type A { x: Int }
      union U = A | B
    `;
    const pairs = fromSdl(sdl);
    expect(pairs).toEqual([]);
  });
});
