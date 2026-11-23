import { drawingExtent } from "./extent.ts";
import type { Extent } from "./extent.ts";
import type { ReplaceKind } from "./replace.ts";
import type { Op, Paper } from "./types.ts";

export interface ReplaceView {
  zoom: number;
  x: number;
  y: number;
}

/** Keep a token's original centre and aspect ratio when adding transparent margins. */
export function replacementExtent(paper: Paper, ops: readonly Op[], kind: ReplaceKind): Extent {
  const e = drawingExtent(ops, paper);
  if (kind === "portrait") return e;
  const factor = Math.max(
    1,
    1 - 2 * e.x / paper.w,
    1 - 2 * e.y / paper.h,
    2 * (e.x + e.w) / paper.w - 1,
    2 * (e.y + e.h) / paper.h - 1,
  );
  const w = paper.w * factor;
  const h = paper.h * factor;
  return { x: (paper.w - w) / 2, y: (paper.h - h) / 2, w, h };
}

/** Fit the whole exported area using CSS pixels, including a negative origin. */
export function fitReplacementView(width: number, height: number, e: Extent): ReplaceView {
  const zoom = Math.max(0.001, Math.min(32, Math.max(1, width - 64) / e.w, Math.max(1, height - 64) / e.h));
  return { zoom, x: (width - e.w * zoom) / 2 - e.x * zoom, y: (height - e.h * zoom) / 2 - e.y * zoom };
}
