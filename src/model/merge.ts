import type { Op } from "./types.ts";

const EMPTY: ReadonlySet<string> = new Set();

/**
 * Three-way merge of op logs, keyed by op id.
 *
 * - `base`   the common ancestor both sides started from
 * - `ours`   our local log (descends from `base`)
 * - `theirs` the incoming remote log (descends from `base`)
 *
 * Rules (never silently drops anyone's additions):
 * 1. Ops removed by either side relative to `base` are removed (undo/clear-undo).
 * 2. The remote order is kept for everything that survives.
 * 3. Ops that only we added are appended on top, in our order.
 * 4. Ops whose id is tombstoned (deleted somewhere, possibly by a third party
 *    whose state neither side has seen as a base) are removed.
 *
 * The result is deterministic, so two clients merging the same inputs agree.
 */
export function mergeOps(
  base: readonly Op[],
  ours: readonly Op[],
  theirs: readonly Op[],
  tombstones: ReadonlySet<string> = EMPTY,
): Op[] {
  const baseIds = new Set(base.map((o) => o.id));
  const oursIds = new Set(ours.map((o) => o.id));
  const theirsIds = new Set(theirs.map((o) => o.id));

  const result: Op[] = [];
  for (const op of theirs) {
    const deletedByOurs = baseIds.has(op.id) && !oursIds.has(op.id);
    if (!deletedByOurs && !tombstones.has(op.id)) result.push(op);
  }
  for (const op of ours) {
    if (!baseIds.has(op.id) && !theirsIds.has(op.id) && !tombstones.has(op.id)) result.push(op);
  }
  return result;
}

export interface MergeSummary {
  ops: Op[];
  /** Remote ops that were not in base (someone else drew something). */
  remoteAdded: number;
  /** Our ops that had to be re-applied on top of the remote state. */
  localKept: number;
}

export function mergeWithSummary(
  base: readonly Op[],
  ours: readonly Op[],
  theirs: readonly Op[],
  tombstones: ReadonlySet<string> = EMPTY,
): MergeSummary {
  const baseIds = new Set(base.map((o) => o.id));
  const theirsIds = new Set(theirs.map((o) => o.id));
  const ops = mergeOps(base, ours, theirs, tombstones);
  return {
    ops,
    remoteAdded: theirs.filter((o) => !baseIds.has(o.id) && !tombstones.has(o.id)).length,
    localKept: ours.filter((o) => !baseIds.has(o.id) && !theirsIds.has(o.id) && !tombstones.has(o.id)).length,
  };
}
