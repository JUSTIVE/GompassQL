import type { NodeKind } from "@/lib/sdl-to-graph";

interface KindStyle {
  label: string;
  ring: string;
  header: string;
  badge: string;
}

/**
 * Tailwind-class style map used by the tree panel / badge UIs.
 * SVG rendering uses KIND_COLORS below (raw color strings).
 */
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

/**
 * Raw color values for SVG rendering. Derived from Tailwind's *-500 palette.
 * Per spec (rule 6) only type/input/union/interface are colored distinctly;
 * enum and scalar reuse type/interface tones.
 */
export const KIND_COLORS: Record<NodeKind, string> = {
  Object: "#0ea5e9", // sky-500
  Interface: "#8b5cf6", // violet-500
  Union: "#f59e0b", // amber-500
  Enum: "#10b981", // emerald-500
  Scalar: "#f43f5e", // rose-500
  Input: "#d946ef", // fuchsia-500
};

export const KIND_COLORS_DARK: Record<NodeKind, string> = {
  Object: "#0369a1", // sky-700
  Interface: "#5b21b6", // violet-800
  Union: "#b45309", // amber-700
  Enum: "#047857", // emerald-700
  Scalar: "#be123c", // rose-700
  Input: "#a21caf", // fuchsia-700
};


export const NODE_WIDTH = 220;
export const HEADER_H = 42;
export const ROW_H = 14;
export const TOP_BODY_PAD = 8;
export const BOTTOM_PAD = 10;

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
  const body = rows === 0 ? 14 : rows * ROW_H;
  return HEADER_H + TOP_BODY_PAD + body + BOTTOM_PAD;
}

export const NODE_DIMENSIONS = { width: NODE_WIDTH };
