import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef } from "react";
import type { ParsedGraph } from "@/lib/sdl-to-graph";
import { layoutGraph } from "@/lib/layout";
import { useTheme } from "@/lib/theme";
import { SchemaNode } from "./SchemaNode";
import { estimateNodeHeight, NODE_DIMENSIONS } from "./node-style";

const nodeTypes = { schema: SchemaNode };

function buildFlowData(graph: ParsedGraph) {
  const baseNodes: Node[] = graph.nodes.map((n) => ({
    id: n.id,
    type: "schema",
    position: { x: 0, y: 0 },
    data: n as unknown as Record<string, unknown>,
    width: NODE_DIMENSIONS.width,
    height: estimateNodeHeight(
      n.kind,
      n.fields?.length ?? 0,
      n.values?.length ?? 0,
      n.members?.length ?? 0,
    ),
  }));

  const baseEdges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed },
    style:
      e.kind === "implements"
        ? { strokeDasharray: "6 4", stroke: "var(--color-muted-foreground)" }
        : e.kind === "union"
          ? { stroke: "var(--color-chart-4)" }
          : { stroke: "var(--color-chart-1)" },
    labelStyle: { fontSize: 10, fill: "var(--color-muted-foreground)" },
  }));

  const positioned = layoutGraph(baseNodes, baseEdges);
  return { nodes: positioned, edges: baseEdges };
}

interface Props {
  graph: ParsedGraph;
  focusId?: string | null;
}

function SchemaGraphInner({ graph, focusId }: Props) {
  const { resolved } = useTheme();
  const flowData = useMemo(() => buildFlowData(graph), [graph]);
  const [nodes, setNodes, onNodesChange] = useNodesState(flowData.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(flowData.edges);
  const { fitView, setCenter, getNode } = useReactFlow();

  useEffect(() => {
    setNodes(flowData.nodes);
    setEdges(flowData.edges);
  }, [flowData, setNodes, setEdges]);

  const lastFitKey = useRef<string>("");
  useEffect(() => {
    const key = `${flowData.nodes.length}`;
    if (lastFitKey.current === key) return;
    lastFitKey.current = key;
    const handle = window.setTimeout(() => {
      fitView({ padding: 0.2, duration: 300 });
    }, 60);
    return () => window.clearTimeout(handle);
  }, [flowData, fitView]);

  useEffect(() => {
    setNodes((curr) =>
      curr.map((n) => {
        const shouldSelect = n.id === focusId;
        if (n.selected === shouldSelect) return n;
        return { ...n, selected: shouldSelect };
      }),
    );
    if (!focusId) return;
    const handle = window.setTimeout(() => {
      const node = getNode(focusId);
      if (!node) return;
      const w = (node.width ?? NODE_DIMENSIONS.width) as number;
      const h = (node.height ?? 140) as number;
      setCenter(node.position.x + w / 2, node.position.y + h / 2, {
        zoom: 1,
        duration: 500,
      });
    }, 80);
    return () => window.clearTimeout(handle);
  }, [focusId, setNodes, setCenter, getNode]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      fitView
      minZoom={0.1}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      onlyRenderVisibleElements
      colorMode={resolved}
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
      <MiniMap pannable zoomable className="!bg-card !border-border" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

export function SchemaGraph(props: Props) {
  return (
    <ReactFlowProvider>
      <SchemaGraphInner {...props} />
    </ReactFlowProvider>
  );
}
