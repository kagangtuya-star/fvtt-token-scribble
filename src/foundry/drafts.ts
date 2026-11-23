import { MODULE_ID } from "../constants.ts";
import { decodeOp, encodeOp } from "../model/serialize.ts";
import type { StoredOp } from "../model/serialize.ts";
import type { Op, Paper } from "../model/types.ts";

/**
 * Crash protection: unsaved local edits are mirrored to localStorage on every
 * commit, so a reload, a crash or a lost connection never loses strokes. The
 * draft is removed once the document confirms the same log.
 */

const PREFIX = `${MODULE_ID}.draft.`;
const MAX_AGE_MS = 14 * 24 * 3600 * 1000;

interface DraftRecord {
  at: number;
  /** Revision the draft was based on. */
  base: string | null;
  w: number;
  h: number;
  ops: StoredOp[];
}

export interface Draft {
  at: number;
  base: string | null;
  paper: Paper;
  ops: Op[];
}

const keyFor = (sceneId: string, tokenId: string) => `${PREFIX}${sceneId}.${tokenId}`;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function saveDraft(sceneId: string, tokenId: string, paper: Paper, base: string | null, ops: readonly Op[]): boolean {
  const s = storage();
  if (!s) return false;
  const record: DraftRecord = { at: Date.now(), base, w: paper.w, h: paper.h, ops: ops.map(encodeOp) };
  try {
    s.setItem(keyFor(sceneId, tokenId), JSON.stringify(record));
    return true;
  } catch (err) {
    console.warn(`${MODULE_ID} | could not store local draft`, err);
    return false;
  }
}

export function loadDraft(sceneId: string, tokenId: string): Draft | null {
  const s = storage();
  const raw = s?.getItem(keyFor(sceneId, tokenId));
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as DraftRecord;
    if (typeof rec.at !== "number" || !Array.isArray(rec.ops)) return null;
    return { at: rec.at, base: rec.base ?? null, paper: { w: rec.w, h: rec.h }, ops: rec.ops.map(decodeOp) };
  } catch (err) {
    console.warn(`${MODULE_ID} | discarding unreadable draft`, err);
    s?.removeItem(keyFor(sceneId, tokenId));
    return null;
  }
}

export function clearDraft(sceneId: string, tokenId: string): void {
  try {
    storage()?.removeItem(keyFor(sceneId, tokenId));
  } catch {
    /* ignore */
  }
}

/** Drop drafts that are too old to be useful. */
export function pruneDrafts(): void {
  const s = storage();
  if (!s) return;
  const now = Date.now();
  for (let i = s.length - 1; i >= 0; i--) {
    const key = s.key(i);
    if (!key?.startsWith(PREFIX)) continue;
    try {
      const rec = JSON.parse(s.getItem(key) ?? "null") as { at?: number } | null;
      if (!rec || typeof rec.at !== "number" || now - rec.at > MAX_AGE_MS) s.removeItem(key);
    } catch {
      s.removeItem(key);
    }
  }
}
