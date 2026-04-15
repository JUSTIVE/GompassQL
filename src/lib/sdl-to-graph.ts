import { Kind, parse, type TypeNode } from "graphql";

export type NodeKind = "Object" | "Interface" | "Union" | "Enum" | "Scalar" | "Input";

export interface GraphField {
  name: string;
  type: string;
  typeName: string;
  args?: { name: string; type: string }[];
  description?: string;
}

export interface GraphNodeData {
  id: string;
  name: string;
  kind: NodeKind;
  description?: string;
  fields?: GraphField[];
  values?: string[];
  members?: string[];
  interfaces?: string[];
}

export interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  sourceField?: string;
  label?: string;
  kind: "field" | "implements" | "union";
}

export interface ParsedGraph {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  error: string | null;
}

const BUILTIN_SCALARS = new Set(["String", "Int", "Float", "Boolean", "ID"]);

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
  const rawEdges: GraphEdgeData[] = [];

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

        for (const field of fields) {
          if (BUILTIN_SCALARS.has(field.typeName)) continue;
          if (field.typeName === def.name.value) continue;
          rawEdges.push({
            id: `${def.name.value}.${field.name}->${field.typeName}`,
            source: def.name.value,
            target: field.typeName,
            sourceField: field.name,
            label: field.name,
            kind: "field",
          });
        }

        if (interfaces) {
          for (const i of interfaces) {
            rawEdges.push({
              id: `${def.name.value}-impl-${i}`,
              source: def.name.value,
              target: i,
              label: "implements",
              kind: "implements",
            });
          }
        }
        break;
      }
      case Kind.ENUM_TYPE_DEFINITION:
        nodes.push({
          id: def.name.value,
          name: def.name.value,
          kind: "Enum",
          description: def.description?.value,
          values: def.values?.map((v) => v.name.value) ?? [],
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
        for (const m of members) {
          rawEdges.push({
            id: `${def.name.value}-union-${m}`,
            source: def.name.value,
            target: m,
            label: "member",
            kind: "union",
          });
        }
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

  const declaredIds = new Set(nodes.map((n) => n.id));
  const edges = rawEdges.filter((e) => declaredIds.has(e.target) && declaredIds.has(e.source));

  return { nodes, edges, error: null };
}
