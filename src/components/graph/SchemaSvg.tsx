import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { layoutGraph } from "@/lib/layout";
import type { GraphEdgeData, GraphNodeData } from "@/lib/sdl-to-graph";
import {
  HEADER_H,
  KIND_COLORS,
  NODE_WIDTH,
  ROW_H,
  TOP_BODY_PAD,
  estimateNodeHeight,
} from "./node-style";

interface LaidNode {
  id: string;
  data: GraphNodeData;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

interface LaidEdge {
  id: string;
  kind: GraphEdgeData["kind"];
  nullable: boolean;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

interface Props {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  focusId?: string | null;
  rootId?: string | null;
}

/**
 * Intersect a ray from `(cx,cy)` in direction `(dx,dy)` with the surrounding
 * axis-aligned rectangle of half-size `(halfW, halfH)`. Returns the hit point
 * on the rect boundary — used so an edge enters/leaves the node in the same
 * direction as the line to the other node's center.
 */
function rectExit(
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  dx: number,
  dy: number,
): [number, number] {
  if (dx === 0 && dy === 0) return [cx, cy];
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  const tx = absDx === 0 ? Infinity : halfW / absDx;
  const ty = absDy === 0 ? Infinity : halfH / absDy;
  const t = Math.min(tx, ty);
  return [cx + dx * t, cy + dy * t];
}

export function SchemaSvg({ nodes, edges, focusId, rootId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1, h: 1 });
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef({ active: false, lastX: 0, lastY: 0 });

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: Math.max(1, r.width), h: Math.max(1, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const laidNodes = useMemo<LaidNode[]>(() => {
    if (nodes.length === 0) return [];
    const input = nodes.map((n) => ({
      id: n.id,
      width: NODE_WIDTH,
      height: estimateNodeHeight(
        n.kind,
        n.fields?.length ?? 0,
        n.values?.length ?? 0,
        n.members?.length ?? 0,
      ),
    }));
    const linkInput = edges
      .filter((e) => e.source !== e.target)
      .map((e) => ({ source: e.source, target: e.target }));
    const positioned = layoutGraph(input, linkInput, rootId ?? undefined);
    const byId = new Map<string, GraphNodeData>();
    for (const n of nodes) byId.set(n.id, n);
    return positioned.map((p) => ({
      id: p.id,
      data: byId.get(p.id)!,
      cx: p.x,
      cy: p.y,
      w: p.width,
      h: p.height,
    }));
  }, [nodes, edges, rootId]);

  const nodeById = useMemo(() => {
    const m = new Map<string, LaidNode>();
    for (const n of laidNodes) m.set(n.id, n);
    return m;
  }, [laidNodes]);

  const laidEdges = useMemo<LaidEdge[]>(() => {
    const out: LaidEdge[] = [];
    for (const e of edges) {
      if (e.source === e.target) continue;
      const a = nodeById.get(e.source);
      const b = nodeById.get(e.target);
      if (!a || !b) continue;
      const dx = b.cx - a.cx;
      const dy = b.cy - a.cy;
      const [sx, sy] = rectExit(a.cx, a.cy, a.w / 2, a.h / 2, dx, dy);
      const [tx, ty] = rectExit(b.cx, b.cy, b.w / 2, b.h / 2, -dx, -dy);
      out.push({
        id: e.id,
        kind: e.kind,
        nullable: e.nullable ?? false,
        sx,
        sy,
        tx,
        ty,
      });
    }
    return out;
  }, [edges, nodeById]);

  const bounds = useMemo(() => {
    if (laidNodes.length === 0) {
      return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of laidNodes) {
      const x1 = n.cx - n.w / 2;
      const y1 = n.cy - n.h / 2;
      const x2 = n.cx + n.w / 2;
      const y2 = n.cy + n.h / 2;
      if (x1 < minX) minX = x1;
      if (y1 < minY) minY = y1;
      if (x2 > maxX) maxX = x2;
      if (y2 > maxY) maxY = y2;
    }
    return { minX, minY, maxX, maxY };
  }, [laidNodes]);

  // Fit whenever layout or container dimensions change (once per combo).
  const fittedKey = useRef("");
  useEffect(() => {
    if (laidNodes.length === 0 || size.w <= 1) return;
    const key = `${laidNodes.length}:${Math.round(size.w)}:${Math.round(size.h)}`;
    if (fittedKey.current === key) return;
    fittedKey.current = key;
    const pad = 80;
    const gW = bounds.maxX - bounds.minX + pad * 2;
    const gH = bounds.maxY - bounds.minY + pad * 2;
    const k = Math.min(size.w / gW, size.h / gH, 1.4);
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    setView({
      x: size.w / 2 - centerX * k,
      y: size.h / 2 - centerY * k,
      k,
    });
  }, [laidNodes, size, bounds]);

  // Focus pan: keep current zoom, translate so focused node is centered.
  useEffect(() => {
    if (!focusId || size.w <= 1) return;
    const n = nodeById.get(focusId);
    if (!n) return;
    setView((v) => ({
      ...v,
      x: size.w / 2 - n.cx * v.k,
      y: size.h / 2 - n.cy * v.k,
    }));
  }, [focusId, nodeById, size.w, size.h]);

  // No zoom — only pan is allowed (rule 1: non-interactive graph).

  const onMouseDown = (e: React.MouseEvent) => {
    drag.current = { active: true, lastX: e.clientX, lastY: e.clientY };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!drag.current.active) return;
    const dx = e.clientX - drag.current.lastX;
    const dy = e.clientY - drag.current.lastY;
    drag.current.lastX = e.clientX;
    drag.current.lastY = e.clientY;
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  const endDrag = () => {
    drag.current.active = false;
  };

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-background"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
      style={{ cursor: "grab" }}
    >
      <svg width={size.w} height={size.h}>
        <defs>
          <marker
            id="arrow-field"
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={6}
            markerHeight={6}
            orient="auto"
          >
            <path d="M0 0 L10 5 L0 10 Z" fill="var(--color-chart-1, #6366f1)" />
          </marker>
          <marker
            id="arrow-implements"
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={6}
            markerHeight={6}
            orient="auto"
          >
            <path d="M0 0 L10 5 L0 10 Z" fill="var(--muted-foreground, #888)" />
          </marker>
          <marker
            id="arrow-union"
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={6}
            markerHeight={6}
            orient="auto"
          >
            <path d="M0 0 L10 5 L0 10 Z" fill="var(--color-chart-4, #eab308)" />
          </marker>
        </defs>

        <g transform={`translate(${view.x}, ${view.y}) scale(${view.k})`}>
          <g>
            {laidEdges.map((e) => {
              const stroke =
                e.kind === "implements"
                  ? "var(--muted-foreground, #888)"
                  : e.kind === "union"
                    ? "var(--color-chart-4, #eab308)"
                    : "var(--color-chart-1, #6366f1)";
              const dash =
                e.kind === "implements"
                  ? "6 4"
                  : e.kind === "field" && e.nullable
                    ? "4 3"
                    : undefined;
              return (
                <path
                  key={e.id}
                  d={`M ${e.sx} ${e.sy} L ${e.tx} ${e.ty}`}
                  stroke={stroke}
                  strokeWidth={1.4}
                  strokeDasharray={dash}
                  fill="none"
                  markerEnd={`url(#arrow-${e.kind})`}
                />
              );
            })}
          </g>

          <g>
            {laidNodes.map((n) => (
              <SvgNode key={n.id} node={n} focused={n.id === focusId} />
            ))}
          </g>
        </g>
      </svg>
    </div>
  );
}

function SvgNode({ node, focused }: { node: LaidNode; focused: boolean }) {
  const { data, w, h, cx, cy } = node;
  const color = KIND_COLORS[data.kind];
  const x = -w / 2;
  const y = -h / 2;

  return (
    <g transform={`translate(${cx}, ${cy})`}>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={6}
        fill="var(--card, #ffffff)"
        stroke={color}
        strokeWidth={focused ? 2.5 : 1.25}
        strokeOpacity={focused ? 1 : 0.75}
      />
      <rect x={x} y={y} width={4} height={h} fill={color} />

      <text
        x={x + 10}
        y={y + 14}
        fontSize={9}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fill={color}
        fontWeight={600}
        letterSpacing={0.6}
      >
        {data.kind.toUpperCase()}
      </text>
      <text
        x={x + 10}
        y={y + 30}
        fontSize={13}
        fontWeight={600}
        fill="var(--foreground, #0f172a)"
      >
        {truncate(data.name, 22)}
      </text>
      <line
        x1={x + 10}
        y1={y + HEADER_H - 4}
        x2={x + w - 10}
        y2={y + HEADER_H - 4}
        stroke="var(--border, #e2e8f0)"
        strokeWidth={1}
      />

      <NodeBody data={data} x={x} y={y + HEADER_H + TOP_BODY_PAD - 2} w={w} />
    </g>
  );
}

function NodeBody({
  data,
  x,
  y,
  w,
}: {
  data: GraphNodeData;
  x: number;
  y: number;
  w: number;
}) {
  if (data.kind === "Enum") {
    const values = data.values ?? [];
    if (values.length === 0) return <EmptyLabel x={x} y={y} />;
    return (
      <>
        {values.map((v, i) => (
          <text
            key={v}
            x={x + 10}
            y={y + i * ROW_H + 10}
            fontSize={10}
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            fill="var(--muted-foreground, #64748b)"
          >
            {truncate(v, 26)}
          </text>
        ))}
      </>
    );
  }

  if (data.kind === "Union") {
    const members = data.members ?? [];
    if (members.length === 0) return <EmptyLabel x={x} y={y} />;
    return (
      <>
        {members.map((m, i) => (
          <text
            key={m}
            x={x + 10}
            y={y + i * ROW_H + 10}
            fontSize={10}
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            fill="var(--muted-foreground, #64748b)"
          >
            | {truncate(m, 22)}
          </text>
        ))}
      </>
    );
  }

  if (data.kind === "Scalar") {
    return (
      <text
        x={x + 10}
        y={y + 10}
        fontSize={10}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontStyle="italic"
        fill="var(--muted-foreground, #64748b)"
      >
        custom scalar
      </text>
    );
  }

  const fields = data.fields ?? [];
  if (fields.length === 0) return <EmptyLabel x={x} y={y} />;
  return (
    <>
      {fields.map((f, i) => (
        <g key={f.name}>
          <text
            x={x + 10}
            y={y + i * ROW_H + 10}
            fontSize={10}
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            fill="var(--foreground, #0f172a)"
          >
            {truncate(f.name, 14)}
          </text>
          <text
            x={x + w - 10}
            y={y + i * ROW_H + 10}
            textAnchor="end"
            fontSize={10}
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            fill="var(--muted-foreground, #64748b)"
          >
            {truncate(f.type, 14)}
          </text>
        </g>
      ))}
    </>
  );
}

function EmptyLabel({ x, y }: { x: number; y: number }) {
  return (
    <text
      x={x + 10}
      y={y + 10}
      fontSize={10}
      fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
      fontStyle="italic"
      fill="var(--muted-foreground, #64748b)"
    >
      (empty)
    </text>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
