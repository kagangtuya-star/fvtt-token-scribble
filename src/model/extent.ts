import { visibleStrokes } from "./ops.ts";
import type { Op, Paper, StrokeOp } from "./types.ts";

/**
 * Axis-aligned rectangle in paper units. The paper itself is `{0, 0, w, h}`;
 * strokes may extend beyond it ("out-of-frame" drawing) and the rasteriser
 * covers the union, so ink outside the token frame is kept and shown.
 */
export interface Extent {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Extents grow in steps of this many paper units, so rasters are not rebuilt for every pixel. */
export const EXTENT_STEP = 100;

/**
 * How far ink may reach beyond the paper on each side, as a fraction of the
 * paper's long side. Bounds the composite texture (at most 3× the paper).
 */
export const OVERFLOW_LIMIT = 1;

export function paperExtent(paper: Paper): Extent {
  return { x: 0, y: 0, w: paper.w, h: paper.h };
}

/** The largest extent ink is rendered in; anything beyond is clipped. */
export function maxExtent(paper: Paper): Extent {
  const m = Math.max(paper.w, paper.h) * OVERFLOW_LIMIT;
  return { x: -m, y: -m, w: paper.w + 2 * m, h: paper.h + 2 * m };
}

type Box = [number, number, number, number];

/**
 * Conservative ink bounds of one stroke, mirror copy included. The outline
 * radius never exceeds the base size, so padding by `size` is always enough.
 */
export function strokeBox(op: Pick<StrokeOp, "size" | "mirror" | "points">, paper: Paper): Box | null {
  const pts = op.points;
  if (pts.length < 3) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 3) {
    const x = pts[i]!;
    const y = pts[i + 1]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (op.mirror) {
    const mMin = paper.w - maxX;
    const mMax = paper.w - minX;
    minX = Math.min(minX, mMin);
    maxX = Math.max(maxX, mMax);
  }
  const pad = op.size;
  return [minX - pad, minY - pad, maxX + pad, maxY + pad];
}

/** Union of `base` and `box`, snapped outwards to the step grid and clamped to {@link maxExtent}. */
export function growExtent(base: Extent, box: Box | null, paper: Paper, margin = 0): Extent {
  if (!box) return base;
  const lim = maxExtent(paper);
  const snapDown = (v: number) => Math.floor(v / EXTENT_STEP) * EXTENT_STEP;
  const snapUp = (v: number, edge: number) => edge + Math.ceil((v - edge) / EXTENT_STEP) * EXTENT_STEP;
  let x0 = base.x;
  let y0 = base.y;
  let x1 = base.x + base.w;
  let y1 = base.y + base.h;
  if (box[0] < x0) x0 = snapDown(box[0] - margin);
  if (box[1] < y0) y0 = snapDown(box[1] - margin);
  // Right/bottom snap relative to the paper edge so the paper rect itself stays exact.
  if (box[2] > x1) x1 = snapUp(box[2] + margin, paper.w);
  if (box[3] > y1) y1 = snapUp(box[3] + margin, paper.h);
  x0 = Math.max(lim.x, x0);
  y0 = Math.max(lim.y, y0);
  x1 = Math.min(lim.x + lim.w, x1);
  y1 = Math.min(lim.y + lim.h, y1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The area the visible picture needs: the paper plus every visible ink
 * stroke (erasers only remove ink, so they never widen it).
 */
export function drawingExtent(ops: readonly Op[], paper: Paper): Extent {
  let e = paperExtent(paper);
  for (const op of visibleStrokes(ops)) {
    if (op.tool === "eraser") continue;
    e = growExtent(e, strokeBox(op, paper), paper);
  }
  return e;
}

export function containsExtent(outer: Extent, inner: Extent): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

export function sameExtent(a: Extent, b: Extent): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** True when the extent is exactly the paper (nothing drawn outside). */
export function isPaperExtent(e: Extent, paper: Paper): boolean {
  return e.x === 0 && e.y === 0 && e.w === paper.w && e.h === paper.h;
}
