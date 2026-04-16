import { ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { KIND_STYLES } from "@/components/graph/node-style";
import { Badge } from "@/components/ui/badge";
import { useSchema } from "@/lib/schema-context";
import type { GraphNodeData } from "@/lib/sdl-to-graph";
import { ColoredType } from "@/lib/type-colors";
import { cn } from "@/lib/utils";

const BUILTIN = new Set(["String", "Int", "Float", "Boolean", "ID"]);
const ROOT_CANDIDATES = ["Query", "Mutation", "Subscription"];

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

  return (
    <div className="flex h-full min-h-0 flex-col [&_::-webkit-scrollbar]:w-0 [&_::-webkit-scrollbar]:h-0 [scrollbar-width:none]">
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
            <li key={v} className="rounded px-2 py-1">
              {v}
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
            const label =
              f.name + (f.args && f.args.length > 0 ? `(${f.args.length})` : "");
            return (
              <li key={f.name}>
                <FieldRow
                  label={label}
                  typeLabel={f.type}
                  description={f.description}
                  navigable={nav}
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
  onClick,
}: {
  label: string;
  typeLabel: string;
  description?: string;
  navigable: boolean;
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
          {typeLabel ? <ColoredType type={typeLabel} /> : null}
          {navigable && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
        </span>
      </span>
      {description && (
        <span className="text-[10px] leading-tight text-muted-foreground/70">
          {description}
        </span>
      )}
    </button>
  );
}
