import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { SchemaCanvas } from "@/components/graph/SchemaCanvas";
import { TreePanel } from "@/components/tree/TreePanel";
import { KIND_STYLES } from "@/components/graph/node-style";
import { Badge } from "@/components/ui/badge";
import { useSchema } from "@/lib/schema-context";
import type { GraphNodeData } from "@/lib/sdl-to-graph";
import { cn } from "@/lib/utils";

type Mode = "reachable" | "orphaned";

export function ViewRoute() {
  const {
    focusStack,
    rootType,
    hasSchema,
    visibleNodes,
    visibleEdges,
    orphanedNodes,
    orphanedEdges,
    pushFocus,
    popTo,
  } = useSchema();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("reachable");
  const [orphanFocus, setOrphanFocus] = useState<string | null>(null);

  useEffect(() => {
    if (!hasSchema) navigate({ to: "/" });
  }, [hasSchema, navigate]);

  if (!hasSchema) return null;

  const reachableFocusId =
    focusStack.length > 0 ? (focusStack[focusStack.length - 1] ?? null) : rootType;

  const canvasNodes = mode === "reachable" ? visibleNodes : orphanedNodes;
  const canvasEdges = mode === "reachable" ? visibleEdges : orphanedEdges;
  const canvasFocusId = mode === "reachable" ? reachableFocusId : orphanFocus;
  const canvasRootId = mode === "reachable" ? rootType : null;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(300px,380px)_1fr]">
      <aside className="flex min-h-0 flex-col border-b border-border bg-card/30 lg:border-b-0 lg:border-r">
        {/* Mode tab switcher */}
        <div className="flex shrink-0 border-b border-border">
          <ModeTab
            active={mode === "reachable"}
            onClick={() => setMode("reachable")}
            label="Reachable"
          />
          <ModeTab
            active={mode === "orphaned"}
            onClick={() => setMode("orphaned")}
            label="Orphaned"
            count={orphanedNodes.length}
            warn={orphanedNodes.length > 0}
            disabled={orphanedNodes.length === 0}
          />
        </div>

        {mode === "reachable" ? (
          <TreePanel />
        ) : (
          <OrphanPanel
            nodes={orphanedNodes}
            focusId={orphanFocus}
            onFocus={setOrphanFocus}
          />
        )}
      </aside>

      <section className="relative min-h-[500px] flex-1">
        <SchemaCanvas
          nodes={canvasNodes}
          edges={canvasEdges}
          focusId={canvasFocusId}
          rootId={canvasRootId}
          onNavigate={mode === "reachable" ? pushFocus : setOrphanFocus}
          onClearFocus={
            mode === "reachable" ? () => popTo(-1) : () => setOrphanFocus(null)
          }
        />
      </section>
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  label,
  count,
  warn,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  warn?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors",
        active
          ? "border-b-2 border-primary text-foreground"
          : "text-muted-foreground hover:text-foreground",
        disabled && "cursor-default opacity-40",
      )}
    >
      {warn && (
        <TriangleAlert className={cn("h-3 w-3 shrink-0", active ? "text-amber-500" : "text-amber-500/60")} />
      )}
      {label}
      {count != null && count > 0 && (
        <span
          className={cn(
            "rounded-full px-1.5 py-px text-[10px] leading-none",
            active ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "bg-secondary text-muted-foreground",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

const KIND_ORDER: GraphNodeData["kind"][] = [
  "Object", "Interface", "Union", "Enum", "Input", "Scalar",
];

function OrphanPanel({
  nodes,
  focusId,
  onFocus,
}: {
  nodes: GraphNodeData[];
  focusId: string | null;
  onFocus: (id: string) => void;
}) {
  const grouped = useMemo(() => {
    const map = new Map<GraphNodeData["kind"], GraphNodeData[]>();
    for (const n of nodes) {
      if (!map.has(n.kind)) map.set(n.kind, []);
      map.get(n.kind)!.push(n);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return KIND_ORDER.flatMap((k) => {
      const list = map.get(k);
      return list ? [{ kind: k, nodes: list }] : [];
    });
  }, [nodes]);

  if (nodes.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
        No orphaned types found.
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto [scrollbar-width:none] [&_::-webkit-scrollbar]:w-0">
      <div className="px-3 py-2 text-[10px] text-muted-foreground">
        {nodes.length} type{nodes.length !== 1 ? "s" : ""} unreachable from root
      </div>
      {grouped.map(({ kind, nodes: list }) => {
        const style = KIND_STYLES[kind];
        return (
          <div key={kind}>
            <div className="sticky top-0 bg-card/90 px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground backdrop-blur">
              {kind} <span className="opacity-60">({list.length})</span>
            </div>
            <ul>
              {list.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => onFocus(n.id)}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs transition-colors",
                      focusId === n.id
                        ? "bg-primary/10 text-primary"
                        : "hover:bg-secondary/60",
                    )}
                  >
                    <Badge className={cn("shrink-0 px-1.5 py-0 text-[9px] leading-4", style.badge)}>
                      {style.label}
                    </Badge>
                    <span className="truncate">{n.name}</span>
                    {n.fields && (
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/60">
                        {n.fields.length}f
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
