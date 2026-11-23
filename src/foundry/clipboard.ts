import { MODULE_ID } from "../constants.ts";
import { decodeOp, encodeOp } from "../model/serialize.ts";
import type { Paper, StrokeOp } from "../model/types.ts";

/** Module clipboard for copying a drawing between tokens (per browser, survives reloads). */

const KEY = `${MODULE_ID}.clipboard`;

export interface ClipboardContent {
  paper: Paper;
  strokes: StrokeOp[];
}

let memory: ClipboardContent | null = null;

export function copyStrokes(paper: Paper, strokes: readonly StrokeOp[]): void {
  memory = { paper, strokes: strokes.slice() };
  try {
    localStorage.setItem(KEY, JSON.stringify({ w: paper.w, h: paper.h, ops: strokes.map(encodeOp) }));
  } catch {
    /* memory copy still works for this session */
  }
}

export function readClipboard(): ClipboardContent | null {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as { w: number; h: number; ops: unknown[] };
    const strokes = rec.ops.map(decodeOp).filter((o): o is StrokeOp => o.kind === "stroke");
    memory = { paper: { w: rec.w, h: rec.h }, strokes };
    return memory;
  } catch {
    return null;
  }
}
