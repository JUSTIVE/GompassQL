import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { reachableFrom } from "./reachable";
import { sdlToGraph, type GraphEdgeData, type GraphNodeData, type ParsedGraph } from "./sdl-to-graph";

interface SchemaContextValue {
  sdl: string;
  name: string;
  graph: ParsedGraph;
  hasSchema: boolean;
  /** Nodes reachable from the current root type. */
  visibleNodes: GraphNodeData[];
  /** Edges reachable from the current root type. */
  visibleEdges: GraphEdgeData[];
  setSchema: (input: { sdl: string; name?: string }) => void;
  clearSchema: () => void;

  rootType: string | null;
  setRootType: (id: string) => void;
  focusStack: string[];
  pushFocus: (id: string) => void;
  popTo: (index: number) => void;
}

const EMPTY: ParsedGraph = { nodes: [], edges: [], error: null };
const STORAGE_KEY = "gompassql:current";

const SchemaContext = createContext<SchemaContextValue | null>(null);

interface Persisted {
  sdl: string;
  name: string;
}

function loadInitial(): Persisted {
  if (typeof window === "undefined") return { sdl: "", name: "" };
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Persisted;
      return { sdl: parsed.sdl ?? "", name: parsed.name ?? "" };
    }
  } catch {
    // ignore
  }
  return { sdl: "", name: "" };
}

export function SchemaProvider({ children }: { children: React.ReactNode }) {
  const initial = useMemo(loadInitial, []);
  const [sdl, setSdl] = useState(initial.sdl);
  const [name, setName] = useState(initial.name);
  const [rootType, setRootTypeState] = useState<string | null>(null);
  const [focusStack, setFocusStack] = useState<string[]>([]);

  const graph = useMemo(() => (sdl ? sdlToGraph(sdl) : EMPTY), [sdl]);

  const effectiveRoot = useMemo(() => {
    if (rootType && graph.nodes.some((n) => n.id === rootType)) return rootType;
    const candidates = ["Query", "Mutation", "Subscription"];
    const found = candidates.find((c) => graph.nodes.some((n) => n.id === c));
    if (found) return found;
    return graph.nodes[0]?.id ?? null;
  }, [graph, rootType]);

  const visible = useMemo(() => {
    if (!effectiveRoot) return { nodes: graph.nodes, edges: graph.edges };
    return reachableFrom(graph.nodes, graph.edges, effectiveRoot);
  }, [graph, effectiveRoot]);

  const setSchema = useCallback(
    ({ sdl: nextSdl, name: nextName }: { sdl: string; name?: string }) => {
      const n = nextName?.trim() || "Untitled schema";
      setSdl(nextSdl);
      setName(n);
      setFocusStack([]);
      setRootTypeState(null);
      try {
        sessionStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ sdl: nextSdl, name: n }),
        );
      } catch {
        // ignore
      }
    },
    [],
  );

  const clearSchema = useCallback(() => {
    setSdl("");
    setName("");
    setFocusStack([]);
    setRootTypeState(null);
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  const setRootType = useCallback((id: string) => {
    setRootTypeState(id);
    setFocusStack([]);
  }, []);

  const pushFocus = useCallback((id: string) => {
    setFocusStack((s) => (s[s.length - 1] === id ? s : [...s, id]));
  }, []);

  const popTo = useCallback((index: number) => {
    setFocusStack((s) => (index < 0 ? [] : s.slice(0, index + 1)));
  }, []);

  const value: SchemaContextValue = {
    sdl,
    name,
    graph,
    hasSchema: graph.nodes.length > 0,
    visibleNodes: visible.nodes,
    visibleEdges: visible.edges,
    setSchema,
    clearSchema,
    rootType: effectiveRoot,
    setRootType,
    focusStack,
    pushFocus,
    popTo,
  };

  return <SchemaContext.Provider value={value}>{children}</SchemaContext.Provider>;
}

export function useSchema() {
  const ctx = useContext(SchemaContext);
  if (!ctx) throw new Error("useSchema must be used within SchemaProvider");
  return ctx;
}
