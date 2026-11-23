import { resolveStroke } from "./brushes.ts";
import type { StrokeOp } from "../model/types.ts";

/** `[x, y, pressure]` triples as consumed by perfect-freehand. */
export type InputPoint = [number, number, number];

/** Options passed to the outline function (a subset of perfect-freehand's StrokeOptions). */
export interface OutlineOptions {
  size: number;
  thinning: number;
  smoothing: number;
  streamline: number;
  simulatePressure: boolean;
  last: boolean;
  start: { cap: boolean; taper: number };
  end: { cap: boolean; taper: number };
}

/** Computes an outline polygon; in production this is perfect-freehand's `getStroke`. */
export type Outliner = (points: InputPoint[], options: OutlineOptions) => number[][];

/**
 * Densify a flat point list with a centripetal-free uniform Catmull–Rom spline.
 * Stored strokes are simplified, so this restores smooth curvature before the
 * outline is computed. Pressure is interpolated linearly.
 */
export function resample(flat: readonly number[], spacing: number): InputPoint[] {
  const n = flat.length / 3;
  const out: InputPoint[] = [];
  if (n === 0) return out;
  if (n === 1) return [[flat[0]!, flat[1]!, flat[2]!]];
  const step = Math.max(0.25, spacing);
  const px = (i: number) => flat[Math.min(n - 1, Math.max(0, i)) * 3]!;
  const py = (i: number) => flat[Math.min(n - 1, Math.max(0, i)) * 3 + 1]!;
  for (let i = 0; i < n - 1; i++) {
    const x0 = px(i - 1);
    const y0 = py(i - 1);
    const x1 = px(i);
    const y1 = py(i);
    const x2 = px(i + 1);
    const y2 = py(i + 1);
    const x3 = px(i + 2);
    const y3 = py(i + 2);
    const p1 = flat[i * 3 + 2]!;
    const p2 = flat[(i + 1) * 3 + 2]!;
    const segLen = Math.hypot(x2 - x1, y2 - y1);
    const count = Math.max(1, Math.min(64, Math.ceil(segLen / step)));
    for (let k = 0; k < count; k++) {
      const t = k / count;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * (2 * x1 + (-x0 + x2) * t + (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2 + (-x0 + 3 * x1 - 3 * x2 + x3) * t3);
      const y = 0.5 * (2 * y1 + (-y0 + y2) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (-y0 + 3 * y1 - 3 * y2 + y3) * t3);
      out.push([x, y, p1 + (p2 - p1) * t]);
    }
  }
  out.push([flat[(n - 1) * 3]!, flat[(n - 1) * 3 + 1]!, flat[(n - 1) * 3 + 2]!]);
  return out;
}

const fmt = (v: number) => (Math.round(v * 100) / 100).toString();

/**
 * SVG path data for a closed outline, using quadratic curves through the
 * midpoints of consecutive outline points (the approach recommended by
 * perfect-freehand). Works both for `new Path2D(d)` and for SVG export.
 */
export function outlineToPath(outline: readonly (readonly number[])[]): string {
  const len = outline.length;
  if (len < 3) {
    if (len === 0) return "";
    // Degenerate outline: a tiny square so the dot is still visible.
    const [x, y] = outline[0]!;
    return `M${fmt(x! - 0.5)} ${fmt(y! - 0.5)}h1v1h-1Z`;
  }
  const a = outline[0]!;
  const b = outline[1]!;
  let d = `M${fmt(a[0]!)} ${fmt(a[1]!)}Q${fmt(b[0]!)} ${fmt(b[1]!)} ${fmt((b[0]! + outline[2]![0]!) / 2)} ${fmt((b[1]! + outline[2]![1]!) / 2)}T`;
  for (let i = 2; i < len - 1; i++) {
    const p = outline[i]!;
    const q = outline[i + 1]!;
    d += `${fmt((p[0]! + q[0]!) / 2)} ${fmt((p[1]! + q[1]!) / 2)} `;
  }
  return d.trimEnd() + "Z";
}

/** SVG path data for a closed polygon (lasso fill). */
export function polygonToPath(points: readonly InputPoint[]): string {
  if (points.length === 0) return "";
  let d = `M${fmt(points[0]![0])} ${fmt(points[0]![1])}`;
  for (let i = 1; i < points.length; i++) d += `L${fmt(points[i]![0])} ${fmt(points[i]![1])}`;
  return d + "Z";
}

export interface StrokeGeometry {
  /** SVG path data in paper coordinates. */
  readonly path: string;
  /** Axis-aligned bounds in paper coordinates [minX, minY, maxX, maxY]. */
  readonly bounds: readonly [number, number, number, number];
}

function boundsOf(points: readonly InputPoint[], pad: number): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX - pad, minY - pad, maxX + pad, maxY + pad];
}

/**
 * Build the geometry of a stroke (or of an in-progress stroke when `live`).
 * Shared by the canvas rasteriser and the SVG exporter.
 */
export function strokeGeometry(
  op: Pick<StrokeOp, "tool" | "size" | "params" | "points">,
  outliner: Outliner,
  live = false,
): StrokeGeometry {
  const r = resolveStroke(op);
  const spacing = Math.max(0.5, Math.min(4, r.size / 6));
  const pts = resample(op.points, spacing);
  if (r.preset.fill) {
    return { path: polygonToPath(pts), bounds: boundsOf(pts, 1) };
  }
  const outline = outliner(pts, {
    size: r.size,
    thinning: r.thinning,
    smoothing: r.smoothing,
    streamline: 0,
    simulatePressure: false,
    last: !live,
    start: { cap: true, taper: r.taperStart * r.size },
    end: { cap: true, taper: live ? 0 : r.taperEnd * r.size },
  });
  return { path: outlineToPath(outline), bounds: boundsOf(pts, r.size) };
}
