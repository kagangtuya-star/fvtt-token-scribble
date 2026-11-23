/**
 * Pressure handling.
 *
 * Mice report no (or constant) pressure. Rather than letting perfect-freehand
 * simulate pressure from raw point spacing (which jitters with uneven event
 * timing), we derive a *smoothed* pressure from speed at input time and store
 * it. Rendering then uses the stored values, so every client draws the exact
 * same shape. Pens/stylus devices use their real pressure, lightly filtered.
 */

export type PressureMode = "auto" | "simulate" | "off";

export interface PressureSample {
  /** Paper-space position. */
  x: number;
  y: number;
  /** Event timestamp in ms. */
  time: number;
  /** Raw PointerEvent.pressure (0..1). */
  pressure: number;
  pointerType: string;
}

/** True when a pointer event stream carries real pressure information. */
export function hasRealPressure(sample: Pick<PressureSample, "pointerType" | "pressure">): boolean {
  return sample.pointerType === "pen" && sample.pressure > 0 && sample.pressure !== 0.5;
}

export class PressureModel {
  readonly #mode: PressureMode;
  /** Stroke size in paper units; speed is normalised by it so behaviour is size independent. */
  readonly #size: number;
  #last: PressureSample | null = null;
  #speed = 0;
  #value = 0.5;
  #real = false;

  constructor(mode: PressureMode, size: number) {
    this.#mode = mode;
    this.#size = Math.max(1, size);
  }

  /** Returns the pressure to store for this sample. */
  next(s: PressureSample): number {
    if (this.#mode === "off") return 0.5;
    if (this.#mode === "auto" && (this.#real || hasRealPressure(s))) {
      this.#real = true;
      // Light low-pass filter removes digitiser noise without adding lag.
      const target = Math.min(1, Math.max(0.05, s.pressure));
      this.#value = this.#last ? this.#value + (target - this.#value) * 0.45 : target;
      this.#last = s;
      return this.#value;
    }
    return this.#simulate(s);
  }

  #simulate(s: PressureSample): number {
    const prev = this.#last;
    this.#last = s;
    if (!prev) {
      this.#value = 0.55;
      return this.#value;
    }
    const dt = Math.max(1, s.time - prev.time);
    const dist = Math.hypot(s.x - prev.x, s.y - prev.y);
    // Speed in "stroke diameters per 16 ms" so the curve feels the same at any size.
    const instant = (dist / this.#size) * (16 / dt);
    this.#speed += (instant - this.#speed) * 0.18;
    const target = 0.82 - Math.min(1, this.#speed / 2.2) * 0.5;
    // Slow pressure response prevents sudden width jumps when the mouse stalls.
    this.#value += (target - this.#value) * 0.12;
    return Math.min(0.9, Math.max(0.3, this.#value));
  }

  get usesRealPressure(): boolean {
    return this.#real;
  }
}
