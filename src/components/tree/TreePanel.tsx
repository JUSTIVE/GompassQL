import { ChevronDown, ChevronRight, Search, Share2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { KIND_STYLES } from "@/components/graph/node-style";
import { Badge } from "@/components/ui/badge";
import { useSchema } from "@/lib/schema-context";
import type { GraphNodeData } from "@/lib/sdl-to-graph";
import { ColoredType } from "@/lib/type-colors";
import { cn } from "@/lib/utils";

const BUILTIN = new Set(["String", "Int", "Float", "Boolean", "ID"]);
const ROOT_CANDIDATES = ["Query", "Mutation", "Subscription"];

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

function HighlightedText({ text, indices }: { text: string; indices: number[] }) {
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
    <span>
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
  } = useSchema();
  const [allTypesOpen, setAllTypesOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedItemRef = useRef<HTMLButtonElement>(null);

  const byId = useMemo(
    () => new Map(visibleNodes.map((n) => [n.id, n])),
    [visibleNodes],
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
  }

  const searchResults = useMemo<SearchResult[]>(() => {
    const q = query.trim();
    if (!q) return [];
    const out: SearchResult[] = [];
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
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 80);
  }, [query, graph.nodes]);

  useEffect(() => { setSelectedIdx(0); }, [searchResults]);

  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  const jumpToAndClose = (id: string) => {
    jumpTo(id);
    setQuery("");
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") { setQuery(""); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, searchResults.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const r = searchResults[selectedIdx];
      if (r) { jumpToAndClose(r.typeId); inputRef.current?.blur(); }
    }
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
      {/* Search input */}
      <div className="border-b border-border px-3 py-2">
        <div className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2 h-3 w-3 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder="Search types & fields…"
            className="w-full rounded border border-border bg-background py-1.5 pl-7 pr-6 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(""); inputRef.current?.focus(); }}
              className="absolute right-2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

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
                          <span className="text-muted-foreground">{r.typeName}.</span>
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

      {/* Normal tree (hidden while searching) */}
      {!query.trim() && <>
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
            onNavigate={pushFocus}
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
}: {
  node: GraphNodeData;
  isNavigable: (t: string) => boolean;
  onNavigate: (id: string) => void;
}) {
  const style = KIND_STYLES[node.kind];

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
                typeLabel=""
                navigable={isNavigable(m)}
                onClick={() => isNavigable(m) && onNavigate(m)}
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
            const nav = isNavigable(f.typeName);
            return (
              <li key={f.name}>
                <FieldRow
                  label={f.name}
                  typeLabel={f.type}
                  description={f.description}
                  navigable={nav}
                  isRelayConnection={f.isRelayConnection}
                  onClick={() => nav && onNavigate(f.typeName)}
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

function FieldRow({
  label,
  typeLabel,
  description,
  navigable,
  isRelayConnection,
  onClick,
}: {
  label: string;
  typeLabel: string;
  description?: string;
  navigable: boolean;
  isRelayConnection?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!navigable}
      onClick={onClick}
      className={cn(
        "group flex w-full flex-col gap-0.5 rounded px-2 py-1 text-left",
        navigable
          ? "cursor-pointer hover:bg-secondary/60"
          : "cursor-default",
      )}
    >
      <span className="flex w-full items-center justify-between gap-2">
        <span className="min-w-0 truncate text-foreground">{label}</span>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1",
            navigable && "group-hover:opacity-80",
          )}
        >
          {isRelayConnection && typeLabel && (
            <Share2 className="h-2.5 w-2.5 shrink-0 text-violet-500 opacity-70" />
          )}
          {typeLabel ? <ColoredType type={typeLabel} /> : null}
          {navigable && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
        </span>
      </span>
      {description && (
        <span className="font-sans text-[11px] leading-snug text-muted-foreground">
          {description}
        </span>
      )}
    </button>
  );
}

