import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

interface TechItem {
  title: string;
  description: string;
}

const RENDER_TECHNIQUES: TechItem[] = [
  {
    title: "PixiJS WebGL renderer",
    description:
      "The graph is drawn with pixi.js v8, backed by a WebGL2 context with hardware anti-aliasing. All compositing, transforms, and blitting happen on the GPU — the main thread only submits draw calls.",
  },
  {
    title: "Sprite texture cache",
    description:
      "Each node card (header, name, field rows) is pre-rendered once to a Canvas 2D offscreen surface, uploaded as a WebGL texture, and displayed as a GPU Sprite. Cache is keyed by node ID + LOD tier.",
  },
  {
    title: "Progressive sprite building",
    description:
      "Sprite builds are budget-limited to 4 ms per frame. On LOD transitions, nodes start as instant solid-color placeholders; the ticker progressively builds real textures across subsequent frames so no single frame blocks.",
  },
  {
    title: "Level of Detail (LOD)",
    description:
      "Three rendering tiers based on zoom: full (text + icons), bar (colored placeholder bars), chrome (solid-color box only). Tier changes are detected in the ticker and trigger progressive rebuilds.",
  },
  {
    title: "Edge batching by style",
    description:
      "Edges are pre-grouped into 4 style buckets (solid field, nullable field, implements, union). Each bucket draws with one beginPath + stroke + fill call regardless of edge count — state changes scale with styles, not edges.",
  },
  {
    title: "Dashed bezier walker",
    description:
      "PixiJS has no native setLineDash. Dashed edges (implements, nullable fields) are drawn by parametrically walking the cubic bezier, toggling moveTo/lineTo as accumulated arc length crosses dash boundaries.",
  },
  {
    title: "Single-pass edge + arrowhead",
    description:
      "Each edge batch iterates visible edges once, building both the stroke path and collecting arrowhead geometry. The filtered set is reused for arrowhead fill — no redundant bbox tests.",
  },
  {
    title: "TilingSprite dot grid",
    description:
      "The background dot grid is a GPU TilingSprite with a tiny 24x24 dot texture. One draw call covers the entire viewport; tilePosition and tileScale sync with pan/zoom in the ticker.",
  },
  {
    title: "Viewport culling",
    description:
      "Pixi's built-in cullable flag is set on node sprites and containers. Edges use bbox-based culling at draw time. The dot grid auto-hides when spacing drops below 6 px.",
  },
  {
    title: "Memory-capped DPR",
    description:
      "Sprite resolution scales with device pixel ratio up to a ceiling derived from node count (budget: sqrt(5000 / N)). On retina displays with 400+ nodes, DPR stays at 2-3 for crisp text without exceeding GPU memory.",
  },
  {
    title: "measureText cache",
    description:
      "Field type widths and fitText results are cached in module-level Maps keyed by string content. Cold sprite builds avoid redundant measureText calls — 8,000+ calls reduced to unique-type count.",
  },
];

const GRAPH_TECHNIQUES: TechItem[] = [
  {
    title: "GraphViz WASM layout",
    description:
      "Layout runs the dot engine (network-simplex ranker) compiled to WebAssembly via @viz-js/viz. The native C implementation handles 400+ nodes in under a second — the JS port (dagre) stalled at that scale.",
  },
  {
    title: "Layout in a Web Worker",
    description:
      "The WASM layout runs off the main thread in a dedicated Web Worker. The UI stays fully interactive during layout; the worker posts node positions and bezier edge paths when done.",
  },
  {
    title: "Native cubic bezier edges",
    description:
      "Edge paths use GraphViz's cubic bezier control points directly via bezierCurveTo — no polyline sampling. Canvas dashing works cleanly on bezier segments without the arcTo artifacts that sampled polylines produced.",
  },
  {
    title: "BFS reachability with implements back-traversal",
    description:
      "Reachable types are found via BFS over field/union/arg edges. implements edges are also traversed in reverse: reaching an interface automatically surfaces all its concrete implementors.",
  },
  {
    title: "Relay Connection unwrapping",
    description:
      "Connection, Edge, PageInfo, and Node boilerplate types are detected structurally and collapsed. Field edges skip straight to the underlying payload type so the graph stays readable.",
  },
  {
    title: "Union member adjacency hints",
    description:
      "For each Union type, member pairs are emitted as invisible non-constraining GraphViz edges (constraint=false, style=invis). This biases crossing reduction to place union members adjacent without affecting ranks.",
  },
  {
    title: "Field-row edge snapping",
    description:
      "Forward field edges are snapped to leave the source node at the field row's Y coordinate with a horizontal tangent. The first bezier segment's anchor and c1 are rewritten so the curve departs cleanly.",
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
        The renderer is a PixiJS WebGL engine — no DOM nodes per type,
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
          <span className="font-medium">Rendering — </span>
          <span className="text-muted-foreground">
            PixiJS v8 (WebGL2) · Canvas 2D sprite textures · GraphViz WASM layout
          </span>
        </div>
      </div>

      <Section title="Rendering optimizations" items={RENDER_TECHNIQUES} />
      <Section title="Graph & layout techniques" items={GRAPH_TECHNIQUES} />

      <section className="mt-8">
        <h2 className="text-base font-semibold">Tips</h2>
        <ul className="mt-3 list-inside list-disc space-y-1.5 text-sm text-muted-foreground">
          <li>Pick a root operation in the left panel, then click field types to drill in.</li>
          <li>Breadcrumbs let you jump back up the navigation stack.</li>
          <li>Scroll to zoom, drag to pan. Pinch-zoom works on touch devices.</li>
          <li><kbd className="font-mono text-xs">Cmd+K</kbd> focuses the search bar. Use <code className="font-mono text-xs">Type.field</code> syntax for two-phase matching.</li>
          <li>Toggle "Hide primitives" to collapse scalar fields and reduce visual noise.</li>
          <li>The Orphaned tab shows types unreachable from any root operation.</li>
          <li>The real-time FPS chart in the bottom-right corner shows rendering performance.</li>
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
