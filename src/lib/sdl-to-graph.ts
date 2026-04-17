import { Kind, parse, type TypeNode } from "graphql";

export type NodeKind = "Object" | "Interface" | "Union" | "Enum" | "Scalar" | "Input";

export interface GraphField {
  name: string;
  type: string;
  typeName: string;
  nullable: boolean;
  isRelayConnection?: boolean;
  args?: { name: string; type: string }[];
  description?: string;
}

export interface EnumValue {
  name: string;
  description?: string;
}

export interface GraphNodeData {
  id: string;
  name: string;
  kind: NodeKind;
  description?: string;
  fields?: GraphField[];
  values?: EnumValue[];
  members?: string[];
  interfaces?: string[];
}

export interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  sourceField?: string;
  sourceFieldIndex?: number;
  label?: string;
  kind: "field" | "implements" | "union";
  nullable?: boolean;
}

export interface ParsedGraph {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  error: string | null;
}

const BUILTIN_SCALARS = new Set(["String", "Int", "Float", "Boolean", "ID"]);

/**
 * Matches the Relay Cursor Connections spec: the `Node` interface,
 * `PageInfo`, and any `*Edge` / `*Connection` types that carry the
 * canonical field shapes. Name-pattern + structural checks together
 * keep unrelated types (e.g. a custom `GraphEdge`) out of the filter.
 */
function isRelayBoilerplate(node: GraphNodeData): boolean {
  const fieldNames = new Set((node.fields ?? []).map((f) => f.name));

  if (node.kind === "Interface" && node.name === "Node") {
    const fields = node.fields ?? [];
    return (
      fields.length === 1 &&
      fields[0]!.name === "id" &&
      fields[0]!.type === "ID!"
    );
  }
  if (node.kind === "Object" && node.name === "PageInfo") {
    return fieldNames.has("hasNextPage") && fieldNames.has("hasPreviousPage");
  }
  if (node.kind === "Object" && node.name.endsWith("Edge")) {
    return fieldNames.has("node") && fieldNames.has("cursor");
  }
  if (node.kind === "Object" && node.name.endsWith("Connection")) {
    return fieldNames.has("edges") && fieldNames.has("pageInfo");
  }
  return false;
}

function renderType(t: TypeNode): { rendered: string; base: string } {
  if (t.kind === Kind.NON_NULL_TYPE) {
    const inner = renderType(t.type);
    return { rendered: inner.rendered + "!", base: inner.base };
  }
  if (t.kind === Kind.LIST_TYPE) {
    const inner = renderType(t.type);
    return { rendered: "[" + inner.rendered + "]", base: inner.base };
  }
  return { rendered: t.name.value, base: t.name.value };
}

export function sdlToGraph(sdl: string): ParsedGraph {
  const nodes: GraphNodeData[] = [];

  if (!sdl.trim()) return { nodes: [], edges: [], error: null };

  let doc;
  try {
    doc = parse(sdl);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { nodes: [], edges: [], error: msg };
  }

  for (const def of doc.definitions) {
    switch (def.kind) {
      case Kind.OBJECT_TYPE_DEFINITION:
      case Kind.INTERFACE_TYPE_DEFINITION:
      case Kind.INPUT_OBJECT_TYPE_DEFINITION: {
        const kind: NodeKind =
          def.kind === Kind.OBJECT_TYPE_DEFINITION
            ? "Object"
            : def.kind === Kind.INTERFACE_TYPE_DEFINITION
              ? "Interface"
              : "Input";

        const fields: GraphField[] = [];
        for (const f of def.fields ?? []) {
          const t = renderType(f.type);
          fields.push({
            name: f.name.value,
            type: t.rendered,
            typeName: t.base,
            nullable: f.type.kind !== Kind.NON_NULL_TYPE,
            description: f.description?.value,
            args:
              "arguments" in f && f.arguments
                ? f.arguments.map((a) => ({
                    name: a.name.value,
                    type: renderType(a.type).rendered,
                  }))
                : undefined,
          });
        }

        const interfaces =
          "interfaces" in def && def.interfaces
            ? def.interfaces.map((i) => i.name.value)
            : undefined;

        nodes.push({
          id: def.name.value,
          name: def.name.value,
          kind,
          description: def.description?.value,
          fields,
          interfaces,
        });
        break;
      }
      case Kind.ENUM_TYPE_DEFINITION:
        nodes.push({
          id: def.name.value,
          name: def.name.value,
          kind: "Enum",
          description: def.description?.value,
          values:
            def.values?.map((v) => ({
              name: v.name.value,
              description: v.description?.value,
            })) ?? [],
        });
        break;
      case Kind.UNION_TYPE_DEFINITION: {
        const members = def.types?.map((t) => t.name.value) ?? [];
        nodes.push({
          id: def.name.value,
          name: def.name.value,
          kind: "Union",
          description: def.description?.value,
          members,
        });
        break;
      }
      case Kind.SCALAR_TYPE_DEFINITION:
        nodes.push({
          id: def.name.value,
          name: def.name.value,
          kind: "Scalar",
          description: def.description?.value,
        });
        break;
      default:
        break;
    }
  }

  // Resolve Relay Connection/Edge types to their underlying node type.
  // Two passes — Edges first, then Connections (which resolve through
  // their `edges` field's Edge type) — so a single lookup unwraps a
  // Connection straight to the node it carries.
  const relayUnwrap = new Map<string, string>();
  for (const n of nodes) {
    if (n.kind !== "Object" || !n.name.endsWith("Edge")) continue;
    const fields = n.fields ?? [];
    const names = new Set(fields.map((f) => f.name));
    if (!(names.has("node") && names.has("cursor"))) continue;
    const nodeField = fields.find((f) => f.name === "node");
    if (nodeField) relayUnwrap.set(n.name, nodeField.typeName);
  }
  for (const n of nodes) {
    if (n.kind !== "Object" || !n.name.endsWith("Connection")) continue;
    const fields = n.fields ?? [];
    const names = new Set(fields.map((f) => f.name));
    if (!(names.has("edges") && names.has("pageInfo"))) continue;
    const edgesField = fields.find((f) => f.name === "edges");
    if (!edgesField) continue;
    const unwrapped = relayUnwrap.get(edgesField.typeName);
    if (unwrapped) relayUnwrap.set(n.name, unwrapped);
  }

  // Rewrite each field's target type to the unwrapped node so graph
  // edges and click-to-navigate skip the Connection/Edge wrappers.
  // The displayed `type` string is left intact so the schema's actual
  // shape is still readable in the panel and node sprites.
  for (const n of nodes) {
    if (!n.fields) continue;
    for (const f of n.fields) {
      const unwrapped = relayUnwrap.get(f.typeName);
      if (unwrapped) {
        f.isRelayConnection = true;
        f.typeName = unwrapped;
      }
    }
  }

  // Now build edges from the (post-unwrap) field/interface/union data.
  const rawEdges: GraphEdgeData[] = [];
  for (const n of nodes) {
    if (n.fields) {
      for (let fi = 0; fi < n.fields.length; fi++) {
        const field = n.fields[fi]!;
        if (BUILTIN_SCALARS.has(field.typeName)) continue;
        if (field.typeName === n.name) continue;
        rawEdges.push({
          id: `${n.name}.${field.name}->${field.typeName}`,
          source: n.name,
          target: field.typeName,
          sourceField: field.name,
          sourceFieldIndex: fi,
          label: field.name,
          kind: "field",
          nullable: field.nullable,
        });
      }
    }
    if (n.interfaces) {
      for (const i of n.interfaces) {
        rawEdges.push({
          id: `${n.name}-impl-${i}`,
          source: n.name,
          target: i,
          label: "implements",
          kind: "implements",
        });
      }
    }
    if (n.kind === "Union" && n.members) {
      for (const m of n.members) {
        rawEdges.push({
          id: `${n.name}-union-${m}`,
          source: n.name,
          target: m,
          label: "member",
          kind: "union",
        });
      }
    }
  }

  // Drop the Relay boilerplate nodes themselves (Node, PageInfo, and
  // every Connection/Edge we successfully unwrapped); any edges still
  // pointing at them are filtered out as dangling.
  const keptNodes = nodes.filter((n) => !isRelayBoilerplate(n));
  const keptIds = new Set(keptNodes.map((n) => n.id));
  const edges = rawEdges.filter((e) => keptIds.has(e.target) && keptIds.has(e.source));

  return { nodes: keptNodes, edges, error: null };
}
