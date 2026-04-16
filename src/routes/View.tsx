import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { SchemaSvg } from "@/components/graph/SchemaSvg";
import { TreePanel } from "@/components/tree/TreePanel";
import { useSchema } from "@/lib/schema-context";

export function ViewRoute() {
  const { focusStack, rootType, hasSchema, visibleNodes, visibleEdges } =
    useSchema();
  const navigate = useNavigate();

  useEffect(() => {
    if (!hasSchema) navigate({ to: "/" });
  }, [hasSchema, navigate]);

  if (!hasSchema) return null;

  const focusId =
    focusStack.length > 0 ? (focusStack[focusStack.length - 1] ?? null) : rootType;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(300px,380px)_1fr]">
      <aside className="min-h-0 border-b border-border bg-card/30 lg:border-b-0 lg:border-r">
        <TreePanel />
      </aside>
      <section className="relative min-h-[500px] flex-1">
        <SchemaSvg nodes={visibleNodes} edges={visibleEdges} focusId={focusId} />
      </section>
    </div>
  );
}
