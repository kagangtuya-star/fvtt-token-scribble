import { MAX_SAMPLES_PER_STROKE } from "../constants.ts";
import { quantizePoints } from "../model/codec.ts";
import { simplifyStroke } from "../model/simplify.ts";
import { PressureModel } from "./pressure.ts";
import type { PressureMode, PressureSample } from "./pressure.ts";

export interface RecorderOptions {
  /** 0..1; same meaning as perfect-freehand's streamline. */
  streamline: number;
  /** Stroke size in paper units. */
  size: number;
  pressureMode: PressureMode;
  /** Whether this tool records pressure at all. */
  usesPressure: boolean;
  /** Minimum spacing between recorded points, in paper units. */
  minDistance: number;
}

/**
 * Turns raw pointer samples (already mapped to paper space) into stroke points.
 *
 * Streamlining is applied here, at input time, using the same interpolation as
 * perfect-freehand. The stored points are therefore already smooth and the
 * renderer can draw them with `streamline: 0`, which keeps live preview, the
 * committed stroke and remote clients pixel-consistent.
 */
export class StrokeRecorder {
  readonly #opts: RecorderOptions;
  readonly #pressure: PressureModel;
  /** Smoothed points: flat [x, y, p]. */
  #points: number[] = [];
  #sx = 0;
  #sy = 0;
  #raw: PressureSample | null = null;
  #first: PressureSample | null = null;
  #samples = 0;
  /** Straight-line mode (Shift): only the anchor and the current point matter. */
  #line = false;

  constructor(opts: RecorderOptions) {
    this.#opts = opts;
    this.#pressure = new PressureModel(opts.usesPressure ? opts.pressureMode : "off", opts.size);
  }

  get sampleCount(): number {
    return this.#samples;
  }

  get full(): boolean {
    return this.#samples >= MAX_SAMPLES_PER_STROKE;
  }

  get usesRealPressure(): boolean {
    return this.#pressure.usesRealPressure;
  }

  set lineMode(on: boolean) {
    this.#line = on;
  }

  get lineMode(): boolean {
    return this.#line;
  }

  add(sample: PressureSample): void {
    this.#samples++;
    const p = this.#pressure.next(sample);
    this.#raw = sample;
    if (!this.#first) {
      this.#first = sample;
      this.#sx = sample.x;
      this.#sy = sample.y;
      this.#points.push(sample.x, sample.y, p);
      return;
    }
    const t = 0.15 + (1 - this.#opts.streamline) * 0.85;
    this.#sx += (sample.x - this.#sx) * t;
    this.#sy += (sample.y - this.#sy) * t;
    const n = this.#points.length;
    const lx = this.#points[n - 3]!;
    const ly = this.#points[n - 2]!;
    if (Math.hypot(this.#sx - lx, this.#sy - ly) < this.#opts.minDistance) {
      // Too close: just update the pressure of the last point (keeps the tip responsive).
      this.#points[n - 1] = p;
      return;
    }
    this.#points.push(this.#sx, this.#sy, p);
  }

  /** Points for the live preview (includes the un-streamlined tip so the line meets the cursor). */
  preview(): number[] {
    if (this.#line) return this.#linePoints();
    const pts = this.#points.slice();
    const raw = this.#raw;
    if (raw && pts.length >= 3) {
      const n = pts.length;
      if (Math.hypot(raw.x - pts[n - 3]!, raw.y - pts[n - 2]!) > 0.01) pts.push(raw.x, raw.y, pts[n - 1]!);
    }
    return pts;
  }

  #linePoints(): number[] {
    const a = this.#first;
    const b = this.#raw;
    if (!a || !b) return [];
    const p = this.#opts.usesPressure ? 0.6 : 0.5;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    // A few interior points let tapers and thinning behave naturally on straight lines.
    const steps = Math.max(1, Math.min(32, Math.ceil(len / Math.max(2, this.#opts.size))));
    const out: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      out.push(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, p);
    }
    return out;
  }

  /**
   * Final, storage-ready points: the raw end point is appended (so the stroke
   * ends exactly where the pointer was released), then simplified and quantised.
   */
  finish(): number[] {
    const pts = this.preview();
    const tolerance = Math.max(0.15, Math.min(0.6, this.#opts.size * 0.02));
    return quantizePoints(this.#line ? pts : simplifyStroke(pts, tolerance));
  }
}
