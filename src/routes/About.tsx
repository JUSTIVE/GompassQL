import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export function AboutRoute() {
  return (
    <div className="mx-auto w-full max-w-2xl flex-1 overflow-auto px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">GompassQL</h1>
      <p className="mt-3 text-muted-foreground">
        Paste a GraphQL SDL and get an interactive map of your schema. A type tree
        lets you navigate from root operations outward; the canvas shows the
        whole graph with viewport culling so large schemas stay fast.
      </p>

      <div className="mt-8 grid gap-4 text-sm">
        <section>
          <h2 className="font-semibold">Stack</h2>
          <ul className="mt-2 list-inside list-disc text-muted-foreground">
            <li>Bun + React 19</li>
            <li>TanStack Router (code-based)</li>
            <li>Tailwind v4 + shadcn/ui</li>
            <li>React Flow (@xyflow/react) + Dagre layout</li>
            <li>graphql for SDL parsing</li>
          </ul>
        </section>
        <section>
          <h2 className="font-semibold">Tips</h2>
          <ul className="mt-2 list-inside list-disc text-muted-foreground">
            <li>Left panel: pick a root, click a field type to drill in.</li>
            <li>Breadcrumbs let you jump back up the stack.</li>
            <li>Scroll to zoom, drag the background to pan.</li>
            <li>Saved schemas live in your browser’s localStorage.</li>
          </ul>
        </section>
      </div>

      <div className="mt-8 flex gap-2">
        <Button asChild>
          <Link to="/">Start visualizing</Link>
        </Button>
      </div>
    </div>
  );
}
