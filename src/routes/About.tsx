import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

interface TechItem {
  title: string;
  description: string;
}

const RENDER_TECHNIQUES: TechItem[] = [
  {
    title: "Canvas 2D sprite cache",
    description:
      "Each node is rendered once onto an offscreen canvas (sprite) and reused every frame with drawImage. Cache is keyed by node ID + LOD tier, so sprites are only rebuilt when content or zoom level changes.",
  },
  {
    title: "Level of Detail (LOD)",
    description:
      "Three rendering tiers based on zoom: full (text + icons), bar (colored placeholder bars), chrome (solid-color box only). Switching tiers drops per-frame work by orders of magnitude at low zoom.",
  },
  {
    title: "Frame budget for sprite building",
    description:
      "Sprite builds are capped at 4 ms per frame. Nodes that exceed the budget receive an instant solid-color fallback and are built progressively across subsequent frames, keeping the render loop unblocked.",
  },
  {
    title: "Memory-capped DPR scaling",
    description:
      "Sprite resolution scales with zoom (sharper text when zoomed in) up to a ceiling that grows with available memory. On large schemas the ceiling lowers automatically to avoid GPU memory pressure.",
  },
  {
    title: "Continuous RAF loop at 120 fps",
    description:
      "A single requestAnimationFrame loop runs unconditionally. All state (pan, zoom, hover, focus) lives in refs so the loop reads it without React re-renders or dependency tracking.",
  },
  {
    title: "Viewport culling",
    description:
      "Nodes and edges outside the visible canvas rect are skipped in the draw pass. The dot-grid background clips to the viewport and exits early when spacing would be under 6 px.",
  },
  {
    title: "DPR via refs, not state",
    description:
      "Device pixel ratio and sprite DPR are stored in refs and compared synchronously each frame. Storing them in React state would introduce a one-frame lag where sprites are drawn at the wrong resolution.",
  },
  {
    title: "Edge skip at chrome LOD",
    description:
      "At the lowest LOD tier (zoom < 0.07) edges are omitted entirely. At that scale nodes are a few pixels wide; drawing edges adds cost with zero visual benefit.",
  },
];

const GRAPH_TECHNIQUES: TechItem[] = [
  {
    title: "D3-force layout in a Web Worker",
    description:
      "Force simulation runs off the main thread in a dedicated Web Worker. The UI stays fully interactive during layout; the worker posts the final node positions when simulation settles.",
  },
  {
    title: "BFS reachability with implements back-traversal",
    description:
      "Reachable types are found via BFS over field/union/arg edges. implements edges are also traversed in reverse: reaching an interface automatically surfaces all its concrete implementors.",
  },
  {
    title: "Multi-root orphan detection",
    description:
      "A type is considered orphaned only if it is unreachable from every root operation (Query, Mutation, Subscription). Types exclusive to Mutation are not shown as orphaned when browsing from Query.",
  },
  {
    title: "Relay Connection unwrapping",
    description:
      "Connection, Edge, PageInfo, and Node boilerplate types are detected structurally and collapsed. Field edges skip straight to the underlying payload type so the graph stays readable.",
  },
  {
    title: "sourceFieldIndex remapping",
    description:
      "When primitive fields are filtered out, each edge's sourceFieldIndex (used to anchor the edge to the correct field row) is remapped to the post-filter position so edges stay aligned.",
  },
];

function Section({ title, items }: { title: string; items: TechItem[] }) {
  return (
    <section className="mt-8">
      <h2 className="text-base font-semibold">{title}</h2>
      <ul className="mt-3 space-y-4">
        {items.map((item) => (
          <li key={item.title} className="grid grid-cols-[1fr] gap-0.5 sm:grid-cols-[200px_1fr] sm:gap-4">
            <span className="font-mono text-xs font-medium text-foreground pt-0.5">{item.title}</span>
            <span className="text-sm text-muted-foreground leading-relaxed">{item.description}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AboutRoute() {
  return (
    <div className="mx-auto w-full max-w-2xl flex-1 overflow-auto px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Graviz</h1>
      <p className="mt-3 text-muted-foreground">
        Paste a GraphQL SDL and get an interactive map of your schema.
        The renderer is a custom Canvas 2D engine — no DOM nodes per type,
        no React re-renders per frame.
      </p>

      <div className="mt-6 grid gap-2 text-sm">
        <div>
          <span className="font-medium">Stack — </span>
          <span className="text-muted-foreground">
            Bun · React 19 · TanStack Router · Tailwind v4 · graphql (SDL parser)
          </span>
        </div>
        <div>
          <span className="font-medium">Layout — </span>
          <span className="text-muted-foreground">
            D3-force in a Web Worker · Canvas 2D renderer
          </span>
        </div>
      </div>

      <Section title="Rendering optimizations" items={RENDER_TECHNIQUES} />
      <Section title="Graph & data techniques" items={GRAPH_TECHNIQUES} />

      <section className="mt-8">
        <h2 className="text-base font-semibold">Tips</h2>
        <ul className="mt-3 list-inside list-disc space-y-1.5 text-sm text-muted-foreground">
          <li>Pick a root operation in the left panel, then click field types to drill in.</li>
          <li>Breadcrumbs let you jump back up the navigation stack.</li>
          <li>Scroll to zoom, drag to pan. Pinch-zoom works on touch devices.</li>
          <li><kbd className="font-mono text-xs">⌘K</kbd> focuses the search bar. Use <code className="font-mono text-xs">Type.field</code> syntax for two-phase matching.</li>
          <li>Toggle "Hide primitives" to collapse scalar fields and reduce visual noise.</li>
          <li>The Orphaned tab shows types unreachable from any root operation.</li>
        </ul>
      </section>

      <div className="mt-10 flex gap-2">
        <Button asChild>
          <Link to="/">Start visualizing</Link>
        </Button>
      </div>
    </div>
  );
}
