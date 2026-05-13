import type { CSSProperties } from "react";

/**
 * Position-aware tooltip placement. Uses `right` / `bottom` anchors
 * when the cursor is near the viewport's right / bottom edge so the
 * bubble never gets clipped. Combine with `whitespace-nowrap` on the
 * tooltip element and the bubble always fully wraps its text.
 */
export function tooltipStyle(clientX: number, clientY: number): CSSProperties {
  const PAD = 12;
  const EDGE = 8;
  if (typeof window === "undefined") {
    return { left: clientX + PAD, top: clientY + PAD };
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const flipX = clientX > vw / 2;
  const flipY = clientY > vh - 80;
  return {
    left: flipX ? undefined : clientX + PAD,
    right: flipX ? vw - clientX + PAD : undefined,
    top: flipY ? undefined : clientY + PAD,
    bottom: flipY ? vh - clientY + PAD : undefined,
    maxWidth: `calc(100vw - ${EDGE * 2}px)`,
  };
}
