import { ChevronDown, ChevronRight, Clock, Filter, Search, Share2, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { KIND_STYLES } from "@/components/graph/node-style";
import { Badge } from "@/components/ui/badge";
import { useSchema } from "@/lib/schema-context";
import type { GraphNodeData } from "@/lib/sdl-to-graph";
import { ColoredType } from "@/lib/type-colors";
import { cn } from "@/lib/utils";

const BUILTIN = new Set(["String", "Int", "Float", "Boolean", "ID"]);
const ROOT_CANDIDATES = ["Query", "Mutation", "Subscription"];

// ─── Search history ────────────────────────────────────────────────────

const SEARCH_HISTORY_KEY = "graviz:search-history";
const MAX_SEARCH_HISTORY = 10;

function loadSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    if (!raw) return [];
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p.filter((s): s is string => typeof s === "string") : [];
  } catch { return []; }
}

function saveSearchHistory(qs: string[]): void {
  try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(qs)); } catch {}
}

function pushSearchHistory(q: string, current: string[]): string[] {
  const trimmed = q.trim();
  if (!trimmed) return current;
  const next = [trimmed, ...current.filter((s) => s !== trimmed)].slice(0, MAX_SEARCH_HISTORY);
  saveSearchHistory(next);
  return next;
}

// ─── Fuzzy search ──────────────────────────────────────────────────────

function fuzzyScore(
  query: string,
  target: string,
): { score: number; indices: number[] } | null {
  if (!query) return { score: 0, indices: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  const indices: number[] = [];
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) { indices.push(i); qi++; }
  }
  if (qi < q.length) return null;

  let score = 0;
  let streak = 0;
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]!;
    const prevIdx = i > 0 ? indices[i - 1]! : -2;
    if (idx === prevIdx + 1) {
      streak++;
      score += 4 + streak * 2;
    } else {
      streak = 0;
      score += 1;
    }
    if (idx === 0) {
      score += 8;
    } else {
      const prev = target[idx - 1]!;
      const curr = target[idx]!;
      if (prev === "_" || prev === "-" || prev === ".") score += 7;
      else if (curr >= "A" && curr <= "Z") score += 5;
    }
  }
  score += Math.round((query.length / target.length) * 8);
  return { score, indices };
}

function HighlightedText({ text, indices, className }: { text: string; indices: number[]; className?: string }) {
  const set = new Set(indices);
  const segs: { text: string; hi: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    const hi = set.has(i);
    let j = i;
    while (j < text.length && set.has(j) === hi) j++;
    segs.push({ text: text.slice(i, j), hi });
    i = j;
  }
  return (
    <span className={className}>
      {segs.map((s, k) =>
        s.hi ? (
          <span key={k} className="font-semibold text-primary">
            {s.text}
          </span>
        ) : (
          <span key={k}>{s.text}</span>
        ),
      )}
    </span>
  );
}

export function TreePanel() {
  const {
    graph,
    visibleNodes,
    rootType,
    setRootType,
    focusStack,
    pushFocus,
    popTo,
    name,
    hidePrimitiveFields,
    setHidePrimitiveFields,
  } = useSchema();
  const [allTypesOpen, setAllTypesOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [inputFocused, setInputFocused] = useState(false);
  const [searchHistory, setSearchHistory] = useState<string[]>(() => loadSearchHistory());
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedItemRef = useRef<HTMLButtonElement>(null);

  // Cmd+K / Ctrl+K → focus search input
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const byId = useMemo(
    () => new Map(visibleNodes.map((n) => [n.id, n])),
    [visibleNodes],
  );
  const nodesById = useMemo(
    () => new Map(graph.nodes.map((n) => [n.id, n])),
    [graph.nodes],
  );
  const roots = useMemo(
    () => ROOT_CANDIDATES.filter((r) => graph.nodes.some((n) => n.id === r)),
    [graph.nodes],
  );
  const otherRoots = useMemo(
    () =>
      graph.nodes
        .filter((n) => !ROOT_CANDIDATES.includes(n.id))
        .map((n) => n.id)
        .sort(),
    [graph.nodes],
  );

  const path: string[] = useMemo(() => {
    if (!rootType) return [];
    return [rootType, ...focusStack];
  }, [rootType, focusStack]);

  const currentId = path[path.length - 1];
  const current = currentId ? (byId.get(currentId) ?? null) : null;

  const isNavigable = (typeName: string) =>
    !BUILTIN.has(typeName) && byId.has(typeName);

  const allTypesSorted = useMemo(
    () => [...graph.nodes].sort((a, b) => a.name.localeCompare(b.name)),
    [graph.nodes],
  );

  interface SearchResult {
    typeId: string;
    typeName: string;
    typeKind: GraphNodeData["kind"];
    fieldName?: string;
    fieldType?: string;
    score: number;
    matchIndices: number[];
    typeMatchIndices?: number[]; // set when query is "Type.field" form
  }

  const searchResults = useMemo<SearchResult[]>(() => {
    const q = query.trim();
    if (!q) return [];
    const out: SearchResult[] = [];

    const dotIdx = q.indexOf(".");
    if (dotIdx > 0) {
      // "Type.field" mode: left side matches type name, right side matches field/value name.
      const typePart = q.slice(0, dotIdx);
      const fieldPart = q.slice(dotIdx + 1);
      for (const node of graph.nodes) {
        const tm = fuzzyScore(typePart, node.name);
        if (!tm) continue;
        const rowsF = node.fields ?? [];
        const rowsV = node.values ?? [];
        const rows: { name: string; type?: string }[] = [
          ...rowsF.map((f) => ({ name: f.name, type: f.type })),
          ...rowsV.map((v) => ({ name: v.name })),
        ];
        for (const row of rows) {
          const fm = fieldPart ? fuzzyScore(fieldPart, row.name) : { score: 0, indices: [] as number[] };
          if (!fm) continue;
          out.push({
            typeId: node.id,
            typeName: node.name,
            typeKind: node.kind,
            fieldName: row.name,
            fieldType: row.type,
            score: tm.score + fm.score,
            matchIndices: fm.indices,
            typeMatchIndices: tm.indices,
          });
        }
      }
    } else {
      // Plain mode: fuzzy-match query against type names, field names, and enum values.
      for (const node of graph.nodes) {
        const tm = fuzzyScore(q, node.name);
        if (tm) {
          out.push({
            typeId: node.id,
            typeName: node.name,
            typeKind: node.kind,
            score: tm.score + 3,
            matchIndices: tm.indices,
          });
        }
        for (const f of node.fields ?? []) {
          const fm = fuzzyScore(q, f.name);
          if (fm) {
            out.push({
              typeId: node.id,
              typeName: node.name,
              typeKind: node.kind,
              fieldName: f.name,
              fieldType: f.type,
              score: fm.score,
              matchIndices: fm.indices,
            });
          }
        }
        for (const v of node.values ?? []) {
          const vm = fuzzyScore(q, v.name);
          if (vm) {
            out.push({
              typeId: node.id,
              typeName: node.name,
              typeKind: node.kind,
              fieldName: v.name,
              score: vm.score,
              matchIndices: vm.indices,
            });
          }
        }
      }
    }

    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 80);
  }, [query, graph.nodes]);

  useEffect(() => { setSelectedIdx(0); }, [searchResults]);

  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  const saveQueryToHistory = (q: string) => {
    setSearchHistory((h) => pushSearchHistory(q, h));
  };

  const jumpToAndClose = (id: string) => {
    if (query.trim()) saveQueryToHistory(query);
    jumpTo(id);
    setQuery("");
    inputRef.current?.blur();
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { setQuery(""); inputRef.current?.blur(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, searchResults.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const r = searchResults[selectedIdx];
      if (r) jumpToAndClose(r.typeId);
    }
  };

  const removeHistoryItem = (q: string) => {
    setSearchHistory((h) => {
      const next = h.filter((s) => s !== q);
      saveSearchHistory(next);
      return next;
    });
  };

  const clearAllHistory = () => {
    setSearchHistory([]);
    saveSearchHistory([]);
  };

  const jumpTo = (id: string) => {
    if (id === rootType) {
      popTo(-1);
      return;
    }
    const idx = focusStack.indexOf(id);
    if (idx >= 0) {
      popTo(idx);
      return;
    }
    // If the type is not visible in the current graph, make it the new root
    // so it appears in the canvas and can be highlighted.
    if (!byId.has(id)) {
      setRootType(id);
      return;
    }
    pushFocus(id);
  };

  return (
    <div className="flex h-full min-h-0 flex-col [&_::-webkit-scrollbar]:w-0 [&_::-webkit-scrollbar]:h-0 [scrollbar-width:none]">
      {/* Search input + filters */}
      <div className="border-b border-border px-3 py-2">
        <div className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2 h-3 w-3 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setTimeout(() => setInputFocused(false), 150)}
            placeholder="Search types & fields…"
            className="w-full rounded border border-border bg-background py-1.5 pl-7 pr-6 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {query ? (
            <button
              type="button"
              onClick={() => { setQuery(""); inputRef.current?.focus(); }}
              className="absolute right-2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          ) : (
            <span className="pointer-events-none absolute right-2 font-mono text-[10px] text-muted-foreground/50">
              ⌘K
            </span>
          )}
        </div>
        {/* Filter toggles */}
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setHidePrimitiveFields(!hidePrimitiveFields)}
            className={cn(
              "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors",
              hidePrimitiveFields
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:border-border/80 hover:text-foreground",
            )}
          >
            <Filter className="h-2.5 w-2.5" />
            Hide primitives
          </button>
        </div>
      </div>

      {/* Recent search history (shown when focused + query empty) */}
      {inputFocused && !query.trim() && searchHistory.length > 0 && (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Recent</span>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={clearAllHistory}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              Clear all
            </button>
          </div>
          <ul>
            {searchHistory.map((q) => (
              <li key={q} className="flex items-center">
                <button
                  type="button"
                  className="flex flex-1 items-center gap-2 px-3 py-1.5 text-left font-mono text-xs hover:bg-secondary/60"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setQuery(q)}
                >
                  <Clock className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{q}</span>
                </button>
                <button
                  type="button"
                  className="mr-3 shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => removeHistoryItem(q)}
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Search results */}
      {query.trim() && (
        <div className="min-h-0 flex-1 overflow-auto">
          {searchResults.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">No results</div>
          ) : (
            <ul>
              {searchResults.map((r, i) => {
                const style = KIND_STYLES[r.typeKind];
                const isSelected = i === selectedIdx;
                return (
                  <li key={`${r.typeId}:${r.fieldName ?? ""}:${i}`}>
                    <button
                      ref={isSelected ? selectedItemRef : undefined}
                      type="button"
                      onClick={() => jumpToAndClose(r.typeId)}
                      onMouseEnter={() => setSelectedIdx(i)}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs transition-colors",
                        isSelected ? "bg-secondary" : "hover:bg-secondary/60",
                      )}
                    >
                      <Badge className={cn("shrink-0 px-1.5 py-0 text-[9px] leading-4", style.badge)}>
                        {style.label}
                      </Badge>
                      {r.fieldName ? (
                        <span className="min-w-0 flex-1 truncate">
                          {r.typeMatchIndices ? (
                            <HighlightedText text={r.typeName} indices={r.typeMatchIndices} className="text-muted-foreground" />
                          ) : (
                            <span className="text-muted-foreground">{r.typeName}</span>
                          )}
                          <span className="text-muted-foreground">.</span>
                          <HighlightedText text={r.fieldName} indices={r.matchIndices} />
                        </span>
                      ) : (
                        <span className="min-w-0 flex-1 truncate">
                          <HighlightedText text={r.typeName} indices={r.matchIndices} />
                        </span>
                      )}
                      {r.fieldType && (
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {r.fieldType}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Normal tree (hidden while searching or showing history) */}
      {!query.trim() && !(inputFocused && searchHistory.length > 0) && <>
      <div className="border-b border-border p-3">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
          {name || "Schema"}
        </div>
        <div className="flex flex-wrap gap-1">
          {roots.map((r) => (
            <button
              key={r}
              onClick={() => setRootType(r)}
              className={cn(
                "rounded px-2 py-1 font-mono text-xs transition-colors",
                rootType === r
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-secondary-foreground hover:bg-secondary/70",
              )}
            >
              {r}
            </button>
          ))}
          {roots.length === 0 && (
            <span className="text-xs text-muted-foreground">
              No root operations; pick any type:
            </span>
          )}
        </div>
        {roots.length === 0 && otherRoots.length > 0 && (
          <select
            className="mt-2 w-full rounded border border-border bg-background px-2 py-1 text-xs"
            value={rootType ?? ""}
            onChange={(e) => setRootType(e.target.value)}
          >
            {otherRoots.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        )}
      </div>

      {graph.nodes.length > 0 && (
        <div className="border-b border-border">
          <button
            type="button"
            onClick={() => setAllTypesOpen((v) => !v)}
            className="flex w-full items-center gap-1 px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-secondary/40"
          >
            {allTypesOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <span>All types ({graph.nodes.length})</span>
          </button>
          {allTypesOpen && (
            <ul className="max-h-48 overflow-auto border-t border-border">
              {allTypesSorted.map((n) => {
                const selected = n.id === currentId;
                const style = KIND_STYLES[n.kind];
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => jumpTo(n.id)}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1 text-left font-mono text-xs transition-colors",
                        selected
                          ? "bg-primary text-primary-foreground"
                          : "text-foreground hover:bg-secondary/60",
                      )}
                    >
                      <Badge
                        className={cn(
                          "shrink-0 px-1.5 py-0 text-[9px] leading-4",
                          selected
                            ? "bg-primary-foreground/20 text-primary-foreground"
                            : style.badge,
                        )}
                      >
                        {style.label}
                      </Badge>
                      <span className="truncate">{n.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {path.length > 0 && (
        <div className="border-b border-border px-3 py-2">
          <Breadcrumbs path={path} onJump={(i) => popTo(i - 1)} />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {!current ? (
          <div className="p-6 text-center text-xs text-muted-foreground">
            Select a type to start exploring.
          </div>
        ) : (
          <TypeDetail
            node={current}
            isNavigable={isNavigable}
            onNavigate={jumpTo}
            nodesById={nodesById}
          />
        )}
      </div>
      </>}
    </div>
  );
}

function Breadcrumbs({
  path,
  onJump,
}: {
  path: string[];
  onJump: (index: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      {path.map((name, i) => (
        <span key={`${i}-${name}`} className="flex items-center gap-1">
          {i > 0 && (
            <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
          )}
          <button
            className={cn(
              "truncate rounded px-1.5 py-0.5 font-mono",
              i === path.length - 1
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
            )}
            onClick={() => onJump(i)}
          >
            {name}
          </button>
        </span>
      ))}
    </div>
  );
}

function TypeDetail({
  node,
  isNavigable,
  onNavigate,
  nodesById,
}: {
  node: GraphNodeData;
  isNavigable: (t: string) => boolean;
  onNavigate: (id: string) => void;
  nodesById: Map<string, GraphNodeData>;
}) {
  const style = KIND_STYLES[node.kind];

  const chainNavigable = (typeName: string) =>
    !BUILTIN.has(typeName) && nodesById.has(typeName);

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center gap-2">
        <Badge className={style.badge}>{style.label}</Badge>
        <div className="truncate font-mono text-sm font-semibold">{node.name}</div>
      </div>

      {node.description && (
        <p className="mb-3 text-xs text-muted-foreground">{node.description}</p>
      )}

      {node.interfaces && node.interfaces.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
          <span>implements</span>
          {node.interfaces.map((i) => (
            <button
              key={i}
              className={cn(
                "rounded px-1.5 py-0.5 font-mono",
                isNavigable(i)
                  ? "bg-secondary/60 hover:bg-secondary"
                  : "opacity-60",
              )}
              disabled={!isNavigable(i)}
              onClick={() => isNavigable(i) && onNavigate(i)}
            >
              {i}
            </button>
          ))}
        </div>
      )}

      {node.kind === "Enum" ? (
        <ul className="space-y-0.5 font-mono text-xs text-muted-foreground">
          {node.values?.map((v) => (
            <li key={v.name} className="rounded px-2 py-1">
              <div className="flex flex-col gap-0.5">
                <span className="text-foreground">{v.name}</span>
                {v.description && (
                  <span className="text-[11px] font-sans leading-snug text-muted-foreground">
                    {v.description}
                  </span>
                )}
              </div>
            </li>
          ))}
          {(!node.values || node.values.length === 0) && (
            <li className="italic">no values</li>
          )}
        </ul>
      ) : node.kind === "Union" ? (
        <ul className="space-y-0.5 font-mono text-xs">
          {node.members?.map((m) => (
            <li key={m}>
              <FieldRow
                label={`| ${m}`}
                chain={[{ label: "", typeName: m, navigable: chainNavigable(m) }]}
                onNavigate={onNavigate}
              />
            </li>
          ))}
        </ul>
      ) : node.kind === "Scalar" ? (
        <p className="text-xs italic text-muted-foreground">
          {node.description ? "" : "custom scalar"}
        </p>
      ) : (
        <ul className="space-y-0.5 font-mono text-xs">
          {node.fields?.map((f) => {
            // Only show the return type in the chain — Input args are
            // visible on hover via the argsDetail list, not inline.
            const chain: ChainItem[] = [
              {
                label: f.type,
                typeName: f.typeName,
                navigable: chainNavigable(f.typeName),
                isRelayConnection: f.isRelayConnection,
              },
            ];
            return (
              <li key={f.name}>
                <FieldRow
                  label={f.name}
                  chain={chain}
                  description={f.description}
                  args={f.args?.map((a) => ({ ...a, navigable: isNavigable(a.typeName) }))}
                  onNavigate={onNavigate}
                />
              </li>
            );
          })}
          {(!node.fields || node.fields.length === 0) && (
            <li className="px-2 py-1 italic text-muted-foreground">no fields</li>
          )}
        </ul>
      )}
    </div>
  );
}

interface ChainItem {
  label: string;
  typeName: string;
  navigable: boolean;
  isRelayConnection?: boolean;
}

function FieldRow({
  label,
  chain,
  description,
  args,
  onNavigate,
}: {
  label: string;
  chain: ChainItem[];
  description?: string;
  args?: { name: string; type: string; typeName: string; navigable: boolean }[];
  onNavigate: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const requiredArgCount = args?.filter((a) => a.type.endsWith("!")).length ?? 0;
  const hasArgs = (args?.length ?? 0) > 0;
  // Args are rendered as inner buttons, so we must use div mode (not
  // button mode) whenever args are present to avoid button-in-button.
  const single = chain.length === 1 && !hasArgs ? chain[0]! : null;

  const arityBadge = hasArgs ? (
    <span className="font-mono text-[10px] text-muted-foreground/60">
      ({requiredArgCount}/{args!.length})
    </span>
  ) : null;

  const argsDetail = hovered && hasArgs ? (
    <ul className="mt-0.5 space-y-px border-l border-border pl-2">
      {args!.map((a) => (
        <li key={a.name} className="flex items-center gap-1.5 font-mono text-[10px]">
          <span className="text-muted-foreground">{a.name}:</span>
          {a.navigable ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onNavigate(a.typeName); }}
              className="flex items-center gap-0.5 rounded px-0.5 hover:bg-secondary/80"
            >
              <ColoredType type={a.type} />
              <ChevronRight className="h-2.5 w-2.5 text-muted-foreground" />
            </button>
          ) : (
            <ColoredType type={a.type} />
          )}
        </li>
      ))}
    </ul>
  ) : null;

  const typeChip = (item: ChainItem) =>
    item.navigable ? (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onNavigate(item.typeName); }}
        className="flex items-center gap-0.5 rounded px-1 hover:bg-secondary/80"
      >
        {item.isRelayConnection && item.label && (
          <Share2 className="h-2.5 w-2.5 shrink-0 text-violet-500 opacity-70" />
        )}
        {item.label ? <ColoredType type={item.label} /> : null}
        <ChevronRight className="h-3 w-3 text-muted-foreground" />
      </button>
    ) : (
      <span className="flex items-center gap-0.5">
        {item.isRelayConnection && item.label && (
          <Share2 className="h-2.5 w-2.5 shrink-0 text-violet-500 opacity-70" />
        )}
        {item.label ? <ColoredType type={item.label} /> : null}
      </span>
    );

  if (single) {
    return (
      <button
        type="button"
        disabled={!single.navigable}
        onClick={() => single.navigable && onNavigate(single.typeName)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={cn(
          "group flex w-full flex-col gap-0.5 rounded px-2 py-1 text-left",
          single.navigable ? "cursor-pointer hover:bg-secondary/60" : "cursor-default",
        )}
      >
        <span className="flex w-full items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1 truncate text-foreground">
            {label}
            {arityBadge}
          </span>
          <span className={cn("flex shrink-0 items-center gap-1", single.navigable && "group-hover:opacity-80")}>
            {single.isRelayConnection && single.label && (
              <Share2 className="h-2.5 w-2.5 shrink-0 text-violet-500 opacity-70" />
            )}
            {single.label ? <ColoredType type={single.label} /> : null}
            {single.navigable && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
          </span>
        </span>
        {description && (
          <span className="font-sans text-[11px] leading-snug text-muted-foreground">
            {description}
          </span>
        )}
        {argsDetail}
      </button>
    );
  }

  return (
    <div
      className="flex w-full flex-col gap-0.5 rounded px-2 py-1 hover:bg-secondary/60"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="flex w-full items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1 truncate text-foreground">
          {label}
          {arityBadge}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {chain.map((item, i) => (
            <Fragment key={i}>
              {i > 0 && (
                <span className="text-[10px] text-muted-foreground/50">→</span>
              )}
              {typeChip(item)}
            </Fragment>
          ))}
        </span>
      </span>
      {description && (
        <span className="font-sans text-[11px] leading-snug text-muted-foreground">
          {description}
        </span>
      )}
      {argsDetail}
    </div>
  );
}

