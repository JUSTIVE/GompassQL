import { instance, type Graph, type Viz } from "@viz-js/viz";

/**
 * Thin wrapper around GraphViz (via WebAssembly). Accepts our layout
 * inputs, injects similarity hints as non-constraining invisible edges
 * so GraphViz's crossing-reduction still considers them during within-
 * rank ordering, runs `dot`, and returns node positions plus edge paths
 * as cubic-bezier segments (same shape `dot` emits them in) — the canvas
 * renderer draws them via `bezierCurveTo` so dashed strokes look clean.
 *
 * We previously used @dagrejs/dagre. Same ranking algorithm (network
 * simplex), but dagre's JS port stalls on ~400-type schemas, while
 * GraphViz's native C compiled to WASM finishes in under a second.
 */

export interface LayoutNodeInput {
  id: string;
  width: number;
  height: number;
}

export interface LayoutEdgeInput {
  id?: string;
  source: string;
  target: string;
  kind?: string;
}

/**
 * Layout-time hint: pull these two nodes closer together with the given
 * weight (0..1). Hints are *additional* attractions on top of real edges
 * and do not need to correspond to a GraphQL relationship.
 */
export interface SimilarityHint {
  source: string;
  target: string;
  weight: number;
}

export interface PositionedNode extends LayoutNodeInput {
  x: number;
  y: number;
}

export interface EdgePathPoint {
  x: number;
  y: number;
}

/** One cubic bezier segment. The path's implicit start is the previous
 *  segment's `end` (or `EdgePath.start` for the first segment). */
export interface BezierSegment {
  c1: EdgePathPoint;
  c2: EdgePathPoint;
  end: EdgePathPoint;
}

export interface EdgePath {
  edgeId: string;
  source: string;
  target: string;
  /** First point of the bezier path — anchor for the first segment. */
  start: EdgePathPoint;
  segments: BezierSegment[];
  /** Arrow tip (if GraphViz emitted one, usually past the target node). */
  arrowTip?: EdgePathPoint;
}

export interface LayoutResult {
  nodes: PositionedNode[];
  edgePaths: EdgePath[];
}

// GraphViz thinks in inches; we feed pixels in. 72 points = 1 inch,
// and 1 point ≈ 1 CSS pixel, so output coordinates (emitted in points)
// come back in the same pixel-space we started from.
const PX_PER_INCH = 72;

// Real-edge weight. GraphViz defaults to 1 for edges; we bump real
// edges so that hint pseudo-edges (weight ≤ 1) can't outrank real
// structural edges during crossing reduction.
const REAL_EDGE_WEIGHT = 4;

const HINT_EDGE_ID_PREFIX = "__hint__";

let vizPromise: Promise<Viz> | null = null;
function getViz(): Promise<Viz> {
  if (!vizPromise) vizPromise = instance();
  return vizPromise;
}

/**
 * Preload the WASM module. Safe to call multiple times — the promise
 * is cached. Callers that know they'll need layout soon can invoke
 * this eagerly so the first render doesn't pay the cold-start cost.
 */
export function preloadLayoutEngine(): Promise<void> {
  return getViz().then(() => undefined);
}

export async function layoutGraph(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
  rootId?: string,
  similarityHints?: SimilarityHint[],
): Promise<LayoutResult> {
  if (nodes.length === 0) return { nodes: [], edgePaths: [] };
  // `rootId` is informational — in `dot`, ranks are derived from the
  // edge structure.
  void rootId;

  const viz = await getViz();

  const nodeSet = new Set(nodes.map((n) => n.id));

  const vizNodes = nodes.map((n) => ({
    name: n.id,
    attributes: {
      width: n.width / PX_PER_INCH,
      height: n.height / PX_PER_INCH,
    },
  }));

  const realEdges = edges.filter(
    (e) => e.source !== e.target && nodeSet.has(e.source) && nodeSet.has(e.target),
  );

  const vizEdges: NonNullable<Graph["edges"]> = realEdges.map((e, i) => ({
    tail: e.source,
    head: e.target,
    attributes: {
      id: e.id ?? `e${i}:${e.source}->${e.target}`,
      weight: REAL_EDGE_WEIGHT,
    },
  }));

  if (similarityHints) {
    const realPairs = new Set<string>();
    for (const e of realEdges) {
      realPairs.add(`${e.source}|${e.target}`);
      realPairs.add(`${e.target}|${e.source}`);
    }
    let hintCounter = 0;
    for (const h of similarityHints) {
      if (h.weight <= 0) continue;
      if (!nodeSet.has(h.source) || !nodeSet.has(h.target)) continue;
      if (h.source === h.target) continue;
      const key = `${h.source}|${h.target}`;
      if (realPairs.has(key)) continue;
      vizEdges.push({
        tail: h.source,
        head: h.target,
        attributes: {
          id: `${HINT_EDGE_ID_PREFIX}${hintCounter++}`,
          weight: Math.max(0.05, Math.min(1, h.weight)),
          constraint: false,
          style: "invis",
        },
      });
      realPairs.add(key);
      realPairs.add(`${h.target}|${h.source}`);
    }
  }

  const graph: Graph = {
    directed: true,
    graphAttributes: {
      rankdir: "LR",
      ranksep: 2.0,
      nodesep: 0.5,
    },
    nodeAttributes: {
      shape: "box",
      fixedsize: true,
    },
    nodes: vizNodes,
    edges: vizEdges,
  };

  // `yInvert: true` flips GraphViz's bottom-origin Y to screen-style
  // top-origin Y, matching our canvas.
  const rendered = viz.renderJSON(graph, {
    engine: "dot",
    yInvert: true,
  }) as VizGraphJson;

  return parseRendered(rendered, nodes);
}

// ─── GraphViz JSON parsing ───────────────────────────────────────────

interface VizGraphJson {
  bb?: string;
  objects?: Array<{
    _gvid?: number;
    name?: string;
    pos?: string;
  }>;
  edges?: Array<{
    _gvid?: number;
    tail: number;
    head: number;
    pos?: string;
    id?: string;
  }>;
}

function parseRendered(
  json: VizGraphJson,
  inputs: LayoutNodeInput[],
): LayoutResult {
  const objects = json.objects ?? [];
  const posById = new Map<string, { x: number; y: number }>();
  for (const obj of objects) {
    if (!obj.name || !obj.pos) continue;
    const p = parsePoint(obj.pos);
    if (p) posById.set(obj.name, p);
  }

  const positioned: PositionedNode[] = [];
  for (const n of inputs) {
    const p = posById.get(n.id);
    if (!p) continue;
    positioned.push({ id: n.id, width: n.width, height: n.height, x: p.x, y: p.y });
  }

  const paths: EdgePath[] = [];
  for (const e of json.edges ?? []) {
    if (!e.pos) continue;
    const id = (e.id ?? "") as string;
    if (id.startsWith(HINT_EDGE_ID_PREFIX)) continue;
    const tailName = objects[e.tail]?.name;
    const headName = objects[e.head]?.name;
    if (!tailName || !headName) continue;
    const parsed = parseSpline(e.pos);
    if (!parsed || parsed.segments.length === 0) continue;
    paths.push({
      edgeId: id || `${tailName}->${headName}`,
      source: tailName,
      target: headName,
      start: parsed.start,
      segments: parsed.segments,
      arrowTip: parsed.arrowTip,
    });
  }

  return { nodes: positioned, edgePaths: paths };
}

function parsePoint(s: string): EdgePathPoint | null {
  const [xs, ys] = s.split(",");
  const x = parseFloat(xs ?? "");
  const y = parseFloat(ys ?? "");
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

interface ParsedSpline {
  start: EdgePathPoint;
  segments: BezierSegment[];
  arrowTip?: EdgePathPoint;
}

/**
 * Parse GraphViz's spline `pos` format into cubic bezier segments.
 *
 * Format is whitespace-separated tokens:
 *   `[e,ex,ey]? [s,sx,sy]? p0,p0 p1,p1 p2,p2 …`
 * The optional `e,…` / `s,…` give the arrow end / start points. The
 * remaining tokens form a cubic B-spline: one start anchor followed
 * by groups of three control points per segment — `(c1, c2, end)`
 * triplets. We pass these straight through so the canvas can draw
 * them with `bezierCurveTo`, which produces clean dashed strokes
 * without the arcTo-chained-arcs artifacts that a sampled polyline
 * renderer suffers from.
 */
function parseSpline(pos: string): ParsedSpline | null {
  const tokens = pos.split(/\s+/).filter(Boolean);
  let arrowEnd: EdgePathPoint | null = null;
  const ctrl: EdgePathPoint[] = [];
  for (const tok of tokens) {
    const parts = tok.split(",");
    if (parts[0] === "e" && parts.length >= 3) {
      const x = parseFloat(parts[1]!);
      const y = parseFloat(parts[2]!);
      if (Number.isFinite(x) && Number.isFinite(y)) arrowEnd = { x, y };
    } else if (parts[0] === "s" && parts.length >= 3) {
      // Arrow-start is rare in our edges and redundant with ctrl[0] in
      // practice. Ignore it so downstream consumers have a simple API.
    } else if (parts.length === 2) {
      const x = parseFloat(parts[0]!);
      const y = parseFloat(parts[1]!);
      if (Number.isFinite(x) && Number.isFinite(y)) ctrl.push({ x, y });
    }
  }
  if (ctrl.length < 4) return null;

  const segments: BezierSegment[] = [];
  for (let i = 0; i + 3 < ctrl.length; i += 3) {
    segments.push({
      c1: ctrl[i + 1]!,
      c2: ctrl[i + 2]!,
      end: ctrl[i + 3]!,
    });
  }

  return {
    start: ctrl[0]!,
    segments,
    arrowTip: arrowEnd ?? undefined,
  };
}
