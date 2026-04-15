import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import type { GraphNodeData } from "@/lib/sdl-to-graph";
import { cn } from "@/lib/utils";
import { KIND_STYLES } from "./node-style";

type SchemaNodeProps = NodeProps & {
  data: GraphNodeData;
};

function SchemaNodeBase({ data, selected }: SchemaNodeProps) {
  const style = KIND_STYLES[data.kind];

  return (
    <div
      className={cn(
        "rounded-md border bg-card text-card-foreground shadow-sm transition-shadow",
        style.ring,
        selected && "shadow-lg ring-2 ring-ring ring-offset-2 ring-offset-background",
      )}
      style={{ width: 220 }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !border !border-background !bg-muted-foreground"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border !border-background !bg-muted-foreground"
      />

      <div
        className={cn(
          "flex items-center justify-between gap-1.5 rounded-t-[5px] px-2 py-1",
          style.header,
        )}
      >
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="font-mono text-[9px] uppercase tracking-wider opacity-70">
            {style.label}
          </span>
          <span className="truncate text-[12px] font-semibold leading-tight">
            {data.name}
          </span>
        </div>
      </div>

      <div className="px-2 py-1 text-[10px] leading-[14px]">
        {data.kind === "Enum" ? (
          <ul className="font-mono">
            {data.values?.map((v) => (
              <li key={v} className="text-muted-foreground">
                {v}
              </li>
            ))}
            {(!data.values || data.values.length === 0) && (
              <li className="italic text-muted-foreground/70">no values</li>
            )}
          </ul>
        ) : data.kind === "Union" ? (
          <ul className="font-mono">
            {data.members?.map((m) => (
              <li key={m} className="text-muted-foreground">
                | {m}
              </li>
            ))}
          </ul>
        ) : data.kind === "Scalar" ? (
          <p className="italic text-muted-foreground/80">
            {data.description ?? "custom scalar"}
          </p>
        ) : (
          <ul className="font-mono">
            {data.fields?.map((f) => (
              <li key={f.name} className="flex items-start justify-between gap-2">
                <span className="truncate text-foreground">{f.name}</span>
                <span className="shrink-0 text-muted-foreground">{f.type}</span>
              </li>
            ))}
            {(!data.fields || data.fields.length === 0) && (
              <li className="italic text-muted-foreground/70">no fields</li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

export const SchemaNode = memo(SchemaNodeBase, (prev, next) => {
  return prev.data === next.data && prev.selected === next.selected;
});
