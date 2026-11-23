import { MAX_TOMBSTONES } from "../constants.ts";
import { mergeWithSummary } from "../model/merge.ts";
import { randomId, sameOpIds } from "../model/ops.ts";
import { encodeDrawing, storedSize } from "../model/serialize.ts";
import type { DecodeResult, StoredDrawing } from "../model/serialize.ts";
import type { DrawingState, Op, Paper } from "../model/types.ts";

export type SyncStatus = "saved" | "dirty" | "saving" | "error" | "offline";

export interface SyncBackend {
  /** Current persisted state (the local copy of the document). */
  read(): DecodeResult;
  /** Persist; resolves once the server accepted the write. */
  write(stored: StoredDrawing): Promise<void>;
  canWrite(): boolean;
  userId: string;
  maxBytes: number;
}

export interface SyncClient {
  /** The editor's current op log. */
  localOps(): readonly Op[];
  /** Replace the editor's log with a merged one. */
  applyMerged(ops: readonly Op[]): void;
  status(status: SyncStatus, detail?: SyncDetail): void;
  /** Remote changes by someone else were merged in. */
  merged?(info: { remoteAdded: number; by: string | null }): void;
}

export type SyncDetail =
  | { kind: "permission" }
  | { kind: "budget" }
  | { kind: "network"; error: unknown }
  | { kind: "timeout" };

export interface SyncOptions {
  /** Idle time after the last change before autosaving. */
  debounceMs?: number;
  /** Upper bound between saves while the user keeps drawing. */
  maxWaitMs?: number;
  writeTimeoutMs?: number;
  timers?: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

const MAX_HISTORY = 24;

/**
 * Optimistic, merge-based synchronisation of one token drawing.
 *
 * Every saved state carries a random revision id and the id of the revision it
 * was derived from. When an incoming state was derived from something other
 * than what we last saw (a concurrent write, or a blind overwrite in the race
 * window), we three-way merge it with our local log using the common ancestor
 * from our revision history and write the result back. Additions from every
 * side survive; undo/clear performed on either side are honoured.
 *
 * Deletions are additionally recorded as tombstones (persisted with the state)
 * so that a third client writing back a merge based on an older state cannot
 * resurrect an op somebody deleted meanwhile. Ids are never reused (redo and
 * revert mint fresh ids), so a tombstone is final.
 *
 * Writes are debounced — never per pointer move — and serialised: at most one
 * write is in flight and the newest state wins the next slot.
 */
export class SyncEngine {
  readonly #backend: SyncBackend;
  readonly #client: SyncClient;
  readonly #paper: Paper;
  readonly #opts: Required<Omit<SyncOptions, "timers">> & { timers: NonNullable<SyncOptions["timers"]> };
  #synced: DrawingState;
  readonly #history = new Map<string, readonly Op[]>();
  readonly #ownRevs = new Set<string>();
  /** Every op id this engine has seen in the local log or in a merged state. */
  readonly #seen = new Set<string>();
  /** Deleted op ids, insertion-ordered (oldest first). */
  readonly #tombs = new Set<string>();
  #dirty = false;
  #timer: unknown = null;
  #firstDirtyAt = 0;
  #inflight: Promise<boolean> | null = null;
  #again = false;
  #status: SyncStatus = "saved";
  #disposed = false;
  #retryDelay = 2000;

  constructor(paper: Paper, initial: DrawingState, backend: SyncBackend, client: SyncClient, options: SyncOptions = {}) {
    this.#paper = paper;
    this.#synced = initial;
    this.#backend = backend;
    this.#client = client;
    this.#opts = {
      debounceMs: options.debounceMs ?? 1200,
      maxWaitMs: options.maxWaitMs ?? 5000,
      writeTimeoutMs: options.writeTimeoutMs ?? 15000,
      timers: options.timers ?? {
        setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
        clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
      },
    };
    this.#remember(initial);
    for (const id of initial.del) this.#tombs.add(id);
    for (const op of initial.ops) this.#seen.add(op.id);
  }

  get synced(): DrawingState {
    return this.#synced;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  get status(): SyncStatus {
    return this.#status;
  }

  get saving(): boolean {
    return this.#inflight !== null;
  }

  #setStatus(s: SyncStatus, detail?: SyncDetail): void {
    this.#status = s;
    this.#client.status(s, detail);
  }

  #remember(state: DrawingState): void {
    if (!state.rev) return;
    this.#history.set(state.rev, state.ops);
    while (this.#history.size > MAX_HISTORY) this.#history.delete(this.#history.keys().next().value!);
  }

  /** Record local deletions (ids seen before that are gone now) as tombstones. */
  #observeLocal(): readonly Op[] {
    const local = this.#client.localOps();
    const present = new Set(local.map((o) => o.id));
    for (const id of this.#seen) {
      if (!present.has(id)) {
        this.#tombs.delete(id); // re-insert as newest
        this.#tombs.add(id);
        this.#seen.delete(id);
      }
    }
    for (const id of present) this.#seen.add(id);
    while (this.#tombs.size > MAX_TOMBSTONES * 2) this.#tombs.delete(this.#tombs.values().next().value!);
    return local;
  }

  /** The tombstones to persist with the next write. */
  get tombstones(): string[] {
    return [...this.#tombs].slice(-MAX_TOMBSTONES);
  }

  /** The editor changed its log: schedule an autosave. */
  touch(): void {
    if (this.#disposed) return;
    const local = this.#observeLocal();
    if (sameOpIds(local, this.#synced.ops) && this.#synced.rev !== null) {
      this.#dirty = false;
      if (!this.#inflight) this.#setStatus("saved");
      return;
    }
    if (!this.#dirty) this.#firstDirtyAt = Date.now();
    this.#dirty = true;
    if (!this.#inflight && this.#status !== "error" && this.#status !== "offline") this.#setStatus("dirty");
    this.#schedule(this.#opts.debounceMs);
  }

  #schedule(ms: number): void {
    if (this.#timer !== null) this.#opts.timers.clearTimeout(this.#timer);
    const waited = Date.now() - this.#firstDirtyAt;
    const delay = Math.max(0, Math.min(ms, this.#opts.maxWaitMs - waited));
    this.#timer = this.#opts.timers.setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, delay);
  }

  /**
   * An update for this document arrived (from anyone, including our own echo).
   * Call with the decoded state of the document after the update.
   */
  receive(result: DecodeResult): void {
    if (this.#disposed) return;
    if (!result.ok && result.reason !== "missing") return; // unreadable: never merge garbage
    const incoming: DrawingState = result.ok
      ? result.state
      : { paper: this.#paper, ops: [], rev: null, parent: this.#synced.rev, seq: this.#synced.seq, by: null, del: [] };
    this.#integrate(incoming);
  }

  #integrate(incoming: DrawingState): void {
    if (incoming.rev !== null && incoming.rev === this.#synced.rev) return;
    if (incoming.rev !== null && this.#ownRevs.has(incoming.rev)) {
      // Our own write coming back: just a fast-forward.
      this.#synced = incoming;
      this.#remember(incoming);
      return;
    }
    // Pick the common ancestor: what the writer started from, if we know it.
    const base = (incoming.parent !== null ? this.#history.get(incoming.parent) : undefined) ?? this.#synced.ops;
    const local = this.#observeLocal();
    for (const id of incoming.del) {
      if (!this.#tombs.has(id)) this.#tombs.add(id);
    }
    const summary = mergeWithSummary(base, local, incoming.ops, this.#tombs);
    this.#synced = incoming;
    this.#remember(incoming);
    if (!sameOpIds(summary.ops, local)) this.#client.applyMerged(summary.ops);
    this.#observeLocal();
    if (summary.remoteAdded > 0 && incoming.by !== this.#backend.userId) {
      this.#client.merged?.({ remoteAdded: summary.remoteAdded, by: incoming.by });
    }
    if (!sameOpIds(summary.ops, incoming.ops)) {
      // Our contribution is missing from the persisted state: write the merge back.
      if (!this.#dirty) this.#firstDirtyAt = Date.now();
      this.#dirty = true;
      if (!this.#inflight) this.#setStatus("dirty");
      this.#schedule(this.#opts.debounceMs / 2);
    } else if (!this.#inflight) {
      this.#dirty = false;
      this.#setStatus("saved");
    }
  }

  /** Save now. Resolves true when the latest local state is persisted. */
  flush(): Promise<boolean> {
    if (this.#timer !== null) {
      this.#opts.timers.clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#inflight) {
      this.#again = true;
      return this.#inflight;
    }
    const run = this.#run().finally(() => {
      this.#inflight = null;
    });
    this.#inflight = run;
    return run;
  }

  async #run(): Promise<boolean> {
    let ok = true;
    do {
      this.#again = false;
      ok = await this.#writeOnce();
      if (!ok) break;
    } while (this.#again && !this.#disposed);
    return ok && !this.#dirty;
  }

  async #writeOnce(): Promise<boolean> {
    // Catch up with any document change we have not processed yet.
    const current = this.#backend.read();
    if (current.ok && current.state.rev !== this.#synced.rev) this.#integrate(current.state);
    const ops = this.#observeLocal().slice();
    if (sameOpIds(ops, this.#synced.ops) && this.#synced.rev !== null) {
      this.#dirty = false;
      this.#setStatus("saved");
      return true;
    }
    if (!this.#backend.canWrite()) {
      this.#setStatus("error", { kind: "permission" });
      return false;
    }
    const rev = randomId();
    const del = this.tombstones;
    const stored = encodeDrawing(this.#paper, ops, {
      rev,
      parent: this.#synced.rev,
      seq: this.#synced.seq + 1,
      by: this.#backend.userId,
      at: Date.now(),
      del,
    });
    if (storedSize(stored) > this.#backend.maxBytes * 1.05) {
      this.#setStatus("error", { kind: "budget" });
      return false;
    }
    this.#ownRevs.add(rev);
    this.#setStatus("saving");
    try {
      await this.#withTimeout(this.#backend.write(stored));
    } catch (error) {
      this.#ownRevs.delete(rev);
      const timeout = error instanceof SyncTimeout;
      this.#setStatus(timeout ? "offline" : "error", timeout ? { kind: "timeout" } : { kind: "network", error });
      this.#dirty = true;
      if (!this.#disposed) {
        this.#schedule(this.#retryDelay);
        this.#retryDelay = Math.min(30_000, this.#retryDelay * 2);
      }
      return false;
    }
    this.#retryDelay = 2000;
    const state: DrawingState = {
      paper: this.#paper,
      ops,
      rev,
      parent: this.#synced.rev,
      seq: this.#synced.seq + 1,
      by: this.#backend.userId,
      del,
    };
    // The echo may already have been processed; only advance if nothing newer arrived.
    if (this.#synced.rev === state.parent || this.#synced.rev === rev) {
      this.#synced = state;
      this.#remember(state);
    }
    this.#dirty = !sameOpIds(this.#client.localOps(), this.#synced.ops);
    if (this.#dirty) this.#schedule(this.#opts.debounceMs);
    this.#setStatus(this.#dirty ? "dirty" : "saved");
    return true;
  }

  #withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const h = this.#opts.timers.setTimeout(() => reject(new SyncTimeout()), this.#opts.writeTimeoutMs);
      p.then(
        (v) => {
          this.#opts.timers.clearTimeout(h);
          resolve(v);
        },
        (e: unknown) => {
          this.#opts.timers.clearTimeout(h);
          reject(e);
        },
      );
    });
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== null) this.#opts.timers.clearTimeout(this.#timer);
    this.#timer = null;
  }
}

class SyncTimeout extends Error {
  override name = "SyncTimeout";
}

/** Convenience for building a fresh revision id outside the engine (tests, drafts). */
export const newRevision = (): string => randomId();
