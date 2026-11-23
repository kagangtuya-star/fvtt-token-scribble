import { quantizePoints } from "../src/model/codec.ts";
import { randomId } from "../src/model/ops.ts";
import type { ClearOp, Op, StrokeOp, ToolId } from "../src/model/types.ts";

/** A deterministic, already-quantised stroke for tests. */
export function stroke(id: string = randomId(), opts: Partial<StrokeOp> & { n?: number; tool?: ToolId } = {}): StrokeOp {
  const n = opts.n ?? 6;
  const pts: number[] = [];
  for (let i = 0; i < n; i++) pts.push(100 + i * 12.34, 200 + Math.sin(i) * 30, 0.3 + (i % 5) * 0.1);
  return {
    kind: "stroke",
    id,
    tool: opts.tool ?? "pen",
    color: opts.color ?? "#1f1b18",
    opacity: opts.opacity ?? 1,
    size: opts.size ?? 9,
    mirror: opts.mirror ?? false,
    points: opts.points ?? quantizePoints(pts),
    ...(opts.params ? { params: opts.params } : {}),
  };
}

export const clear = (id: string = randomId()): ClearOp => ({ kind: "clear", id });

export const ids = (ops: readonly Op[]): string[] => ops.map((o) => o.id);

/** Manually driven timers for deterministic async tests. */
export class FakeTimers {
  now = 0;
  #next = 1;
  #tasks = new Map<number, { at: number; fn: () => void }>();

  setTimeout = (fn: () => void, ms: number): number => {
    const id = this.#next++;
    this.#tasks.set(id, { at: this.now + ms, fn });
    return id;
  };

  clearTimeout = (h: unknown): void => {
    this.#tasks.delete(h as number);
  };

  get pending(): number {
    return this.#tasks.size;
  }

  /** Advance time, running due timers in order (and letting promises settle in between). */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      await settle();
      let due: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.#tasks) if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
      if (!due) break;
      this.#tasks.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].fn();
    }
    this.now = end;
    await settle();
  }
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
