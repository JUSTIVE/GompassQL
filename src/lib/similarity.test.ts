import { describe, expect, test } from "bun:test";
import { sdlToGraph } from "./sdl-to-graph";
import { computeSimilarityPairs, nameRoot, type SimilarityPair } from "./similarity";

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

describe("nameRoot", () => {
  test("strips Relay decorators", () => {
    expect(nameRoot("UserConnection")).toBe("User");
    expect(nameRoot("UserEdge")).toBe("User");
    expect(nameRoot("PostConnection")).toBe("Post");
  });

  test("strips Input/Payload suffixes", () => {
    expect(nameRoot("CreateUserInput")).toBe("User");
    expect(nameRoot("UpdateUserPayload")).toBe("User");
    expect(nameRoot("DeletePostResponse")).toBe("Post");
  });

  test("leaves plain names alone", () => {
    expect(nameRoot("User")).toBe("User");
    expect(nameRoot("Post")).toBe("Post");
  });
});

describe("computeSimilarityPairs — naming roots", () => {
  test("groups User family (User/UserEdge/UserConnection)", () => {
    const sdl = `
      type User { id: ID! name: String! }
      type UserEdge { node: User! cursor: String! }
      type UserConnection { edges: [UserEdge!]! pageInfo: PageInfo! }
      type PageInfo { hasNextPage: Boolean! endCursor: String }
      type Post { id: ID! title: String! }
      type PostEdge { node: Post! cursor: String! }
      type PostConnection { edges: [PostEdge!]! pageInfo: PageInfo! }
      type Query { users: UserConnection posts: PostConnection }
    `;
    const pairs = fromSdl(sdl);

    // User family clusters.
    expect(pair(pairs, "User", "UserEdge")?.score).toBeGreaterThan(0.4);
    expect(pair(pairs, "User", "UserConnection")?.score).toBeGreaterThan(0.4);
    expect(pair(pairs, "UserEdge", "UserConnection")?.score).toBeGreaterThan(0.4);

    // Post family clusters.
    expect(pair(pairs, "Post", "PostEdge")?.score).toBeGreaterThan(0.4);
    expect(pair(pairs, "Post", "PostConnection")?.score).toBeGreaterThan(0.4);

    // Cross-family Edges should NOT be strongly grouped.
    const cross = pair(pairs, "UserEdge", "PostEdge");
    if (cross) expect(cross.score).toBeLessThan(0.3);

    // Connections from different domains should NOT cluster strongly.
    const xConn = pair(pairs, "UserConnection", "PostConnection");
    if (xConn) expect(xConn.score).toBeLessThan(0.3);
  });

  test("groups CRUD inputs/payloads with their core type", () => {
    const sdl = `
      type User { id: ID! name: String! email: String! }
      input CreateUserInput { name: String! email: String! }
      input UpdateUserInput { id: ID! name: String email: String }
      type CreateUserPayload { user: User! }
      type Mutation { createUser(input: CreateUserInput!): CreateUserPayload }
    `;
    const pairs = fromSdl(sdl);
    expect(pair(pairs, "User", "CreateUserInput")?.score).toBeGreaterThan(0.4);
    expect(pair(pairs, "User", "UpdateUserInput")?.score).toBeGreaterThan(0.4);
    expect(pair(pairs, "CreateUserInput", "UpdateUserInput")?.score).toBeGreaterThan(0.4);
    expect(pair(pairs, "User", "CreateUserPayload")?.score).toBeGreaterThan(0.4);
  });
});

describe("computeSimilarityPairs — shared interfaces", () => {
  test("two implementers of a niche interface attract", () => {
    const sdl = `
      interface Timestamped { createdAt: String! }
      type Article implements Timestamped { id: ID! createdAt: String! body: String! }
      type Comment implements Timestamped { id: ID! createdAt: String! text: String! }
      type Other { id: ID! }
    `;
    const pairs = fromSdl(sdl);
    const p = pair(pairs, "Article", "Comment");
    expect(p).toBeDefined();
    expect(p!.score).toBeGreaterThan(0.2);
    expect(p!.reasons.some((r) => r.startsWith("interface:"))).toBe(true);
  });

  test("popular interface like Node is heavily damped", () => {
    const sdl = `
      interface Node { id: ID! }
      type A implements Node { id: ID! a: String }
      type B implements Node { id: ID! b: String }
      type C implements Node { id: ID! c: String }
      type D implements Node { id: ID! d: String }
      type E implements Node { id: ID! e: String }
      type F implements Node { id: ID! f: String }
    `;
    const pairs = fromSdl(sdl);
    // With 6 implementers, base = 0.5 * (2/6) ≈ 0.167 → below MIN_SCORE.
    const p = pair(pairs, "A", "B");
    expect(p).toBeUndefined();
  });
});

describe("computeSimilarityPairs — field similarity", () => {
  test("structurally identical inputs attract", () => {
    const sdl = `
      input CreateThingInput { name: String! description: String tags: [String!] }
      input UpdateThingInput { name: String description: String tags: [String!] }
      type Other { foo: String! }
    `;
    const pairs = fromSdl(sdl);
    const p = pair(pairs, "CreateThingInput", "UpdateThingInput");
    expect(p).toBeDefined();
    expect(p!.score).toBeGreaterThan(0.4);
  });

  test("Relay siblings (UserEdge / PostEdge) are NOT joined by loose field-name match", () => {
    const sdl = `
      type User { id: ID! }
      type Post { id: ID! }
      type UserEdge { node: User! cursor: String! }
      type PostEdge { node: Post! cursor: String! }
    `;
    const pairs = fromSdl(sdl);
    const p = pair(pairs, "UserEdge", "PostEdge");
    // Either no pair, or score below 0.3 — must not cluster.
    if (p) expect(p.score).toBeLessThan(0.3);
  });
});

describe("computeSimilarityPairs — Relay handling", () => {
  test("Connection ↔ Edge ↔ Core triplet receives bonus weight", () => {
    const sdl = `
      type User { id: ID! name: String! }
      type UserEdge { node: User! cursor: String! }
      type UserConnection { edges: [UserEdge!]! pageInfo: PageInfo! }
      type PageInfo { hasNextPage: Boolean! endCursor: String }
    `;
    const pairs = fromSdl(sdl);
    const ce = pair(pairs, "UserConnection", "UserEdge");
    const ec = pair(pairs, "UserEdge", "User");
    expect(ce).toBeDefined();
    expect(ec).toBeDefined();
    expect(ce!.reasons.some((r) => r.startsWith("relay:"))).toBe(true);
    expect(ec!.reasons.some((r) => r.startsWith("relay:") || r.startsWith("naming-root:"))).toBe(true);
  });
});

describe("computeSimilarityPairs — root operations and trivial cases", () => {
  test("Query/Mutation/Subscription do not appear in pairs", () => {
    const sdl = `
      type Query { user: User }
      type Mutation { createUser: User }
      type Subscription { userAdded: User }
      type User { id: ID! name: String! }
      type UserAccount { id: ID! name: String! email: String! }
    `;
    const pairs = fromSdl(sdl);
    for (const p of pairs) {
      expect(["Query", "Mutation", "Subscription"]).not.toContain(p.a);
      expect(["Query", "Mutation", "Subscription"]).not.toContain(p.b);
    }
  });

  test("output is sparse: no pairs for trivially-related types", () => {
    const sdl = `
      type Query { a: A b: B c: C }
      type A { x: String }
      type B { y: Int }
      type C { z: Boolean }
    `;
    const pairs = fromSdl(sdl);
    // No naming overlap, no shared interfaces, no field overlap.
    expect(pairs).toEqual([]);
  });

  test("scores stay within 0..1", () => {
    const sdl = `
      interface Node { id: ID! }
      type A implements Node { id: ID! shared: String! also: Int! }
      type B implements Node { id: ID! shared: String! also: Int! }
    `;
    const pairs = fromSdl(sdl);
    for (const p of pairs) {
      expect(p.score).toBeGreaterThan(0);
      expect(p.score).toBeLessThanOrEqual(1);
    }
  });

  test("output is sorted by descending score", () => {
    const sdl = `
      interface Timestamped { createdAt: String! }
      type Article implements Timestamped { id: ID! createdAt: String! body: String! }
      type Comment implements Timestamped { id: ID! createdAt: String! text: String! }
      type User { id: ID! name: String! }
      input CreateUserInput { name: String! }
      input UpdateUserInput { id: ID! name: String }
    `;
    const pairs = fromSdl(sdl);
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i - 1]!.score).toBeGreaterThanOrEqual(pairs[i]!.score);
    }
  });
});
