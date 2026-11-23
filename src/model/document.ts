import { randomId, visibleStrokes } from "./ops.ts";
import type { ClearOp, Op, Paper, StrokeOp } from "./types.ts";

/** Upper bound on remembered undo transactions per editing session. */
const MAX_UNDO = 500;

/**
 * The editable op log of one token drawing plus its undo/redo history.
 *
 * Undo works on *transactions* (one stroke, one paste, one clear) identified
 * by op ids rather than indices, so it keeps working after remote changes are
 * merged in. The log loaded from storage seeds the undo stack, so undo also
 * reaches strokes from earlier sessions after a reload.
 */
export class ScribbleDocument {
  readonly paper: Paper;
  #ops: Op[];
  #undo: string[][] = [];
  #redo: Op[][] = [];
  /** Ids added in this session (for "revert this session"). */
  readonly #addedThisSession = new Set<string>();
  /** Ops present at session start that were removed in this session. */
  readonly #removedThisSession = new Map<string, Op>();
  #initial: readonly Op[];

  constructor(paper: Paper, ops: readonly Op[]) {
    this.paper = paper;
    this.#ops = ops.slice();
    this.#initial = ops.slice();
    for (const op of ops.slice(-MAX_UNDO)) this.#undo.push([op.id]);
  }

  get ops(): readonly Op[] {
    return this.#ops;
  }

  get canUndo(): boolean {
    return this.#undo.some((t) => t.some((id) => this.#has(id)));
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  /** True when this session changed anything relative to the loaded log. */
  get sessionChanged(): boolean {
    return this.#addedThisSession.size > 0 || this.#removedThisSession.size > 0;
  }

  #has(id: string): boolean {
    return this.#ops.some((o) => o.id === id);
  }

  /** Append a transaction of ops (e.g. one stroke, or a pasted group). */
  add(ops: readonly Op[]): void {
    if (ops.length === 0) return;
    this.#ops.push(...ops);
    for (const op of ops) this.#addedThisSession.add(op.id);
    this.#undo.push(ops.map((o) => o.id));
    if (this.#undo.length > MAX_UNDO) this.#undo.shift();
    this.#redo = [];
  }

  /** Add a clear marker if anything is visible. Returns the op or null. */
  clear(): ClearOp | null {
    if (visibleStrokes(this.#ops).length === 0) return null;
    const op: ClearOp = { kind: "clear", id: randomId() };
    this.add([op]);
    return op;
  }

  undo(): boolean {
    while (this.#undo.length > 0) {
      const ids = new Set(this.#undo.pop()!);
      const removed = this.#ops.filter((o) => ids.has(o.id));
      if (removed.length === 0) continue; // removed remotely; skip to the next transaction
      this.#ops = this.#ops.filter((o) => !ids.has(o.id));
      for (const op of removed) this.#noteRemoved(op);
      this.#redo.push(removed);
      return true;
    }
    return false;
  }

  /**
   * Redo re-adds the undone ops under *fresh ids*: the old ids may already be
   * tombstoned on other clients, and a deleted id must never come back.
   */
  redo(): boolean {
    const ops = this.#redo.pop();
    if (!ops) return false;
    const fresh = ops.filter((o) => !this.#has(o.id)).map((o) => ({ ...o, id: randomId() }));
    if (fresh.length === 0) return this.redo();
    this.#ops.push(...fresh);
    for (const op of fresh) this.#noteAdded(op);
    this.#undo.push(fresh.map((o) => o.id));
    return true;
  }

  #noteRemoved(op: Op): void {
    if (this.#addedThisSession.has(op.id)) this.#addedThisSession.delete(op.id);
    else this.#removedThisSession.set(op.id, op);
  }

  #noteAdded(op: Op): void {
    if (this.#removedThisSession.has(op.id)) this.#removedThisSession.delete(op.id);
    else this.#addedThisSession.add(op.id);
  }

  /**
   * Replace the log with a merged one (remote changes arrived). History entries
   * whose ops disappeared become no-ops and are skipped by undo.
   */
  replace(ops: readonly Op[]): void {
    this.#ops = ops.slice();
  }

  /**
   * The log as it would look if this session's own edits were rolled back,
   * while keeping anything other users added meanwhile. Ops this session had
   * removed come back under fresh ids (see {@link redo}).
   */
  revertedOps(): Op[] {
    const currentIds = new Set(this.#ops.map((o) => o.id));
    const initialIds = new Set(this.#initial.map((o) => o.id));
    const restored: Op[] = [];
    for (const o of this.#initial) {
      if (currentIds.has(o.id)) restored.push(o);
      else if (this.#removedThisSession.has(o.id)) restored.push({ ...o, id: randomId() });
    }
    const remote = this.#ops.filter((o) => !initialIds.has(o.id) && !this.#addedThisSession.has(o.id));
    return [...restored, ...remote];
  }

  /** Mark the current log as the new session baseline (after a revert was saved). */
  resetSessionTracking(): void {
    this.#initial = this.#ops.slice();
    this.#addedThisSession.clear();
    this.#removedThisSession.clear();
  }

  visibleStrokes(): StrokeOp[] {
    return visibleStrokes(this.#ops);
  }
}
