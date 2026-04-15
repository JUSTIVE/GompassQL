import type { NodeKind } from "@/lib/sdl-to-graph";

interface KindStyle {
  label: string;
  ring: string;
  header: string;
  badge: string;
}

export const KIND_STYLES: Record<NodeKind, KindStyle> = {
  Object: {
    label: "type",
    ring: "border-sky-500/60",
    header: "bg-sky-500/10 text-sky-600 dark:text-sky-300",
    badge: "bg-sky-500 text-white",
  },
  Interface: {
    label: "interface",
    ring: "border-violet-500/60",
    header: "bg-violet-500/10 text-violet-600 dark:text-violet-300",
    badge: "bg-violet-500 text-white",
  },
  Union: {
    label: "union",
    ring: "border-amber-500/60",
    header: "bg-amber-500/10 text-amber-600 dark:text-amber-300",
    badge: "bg-amber-500 text-white",
  },
  Enum: {
    label: "enum",
    ring: "border-emerald-500/60",
    header: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
    badge: "bg-emerald-500 text-white",
  },
  Scalar: {
    label: "scalar",
    ring: "border-rose-500/60",
    header: "bg-rose-500/10 text-rose-600 dark:text-rose-300",
    badge: "bg-rose-500 text-white",
  },
  Input: {
    label: "input",
    ring: "border-fuchsia-500/60",
    header: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-300",
    badge: "bg-fuchsia-500 text-white",
  },
};

const NODE_WIDTH = 220;
const HEADER_H = 38;
const ROW_H = 16;
const PADDING = 10;

export function estimateNodeHeight(
  kind: NodeKind,
  fieldCount = 0,
  valueCount = 0,
  memberCount = 0,
): number {
  const rows =
    kind === "Enum"
      ? valueCount
      : kind === "Union"
        ? memberCount
        : kind === "Scalar"
          ? 0
          : fieldCount;
  return HEADER_H + PADDING + Math.max(rows, 0) * ROW_H + (rows === 0 ? 10 : 0);
}

export const NODE_DIMENSIONS = { width: NODE_WIDTH };
