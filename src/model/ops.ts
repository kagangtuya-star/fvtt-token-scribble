import { PAPER_LONG_SIDE } from "../constants.ts";
import type { Op, Paper, StrokeOp } from "./types.ts";

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Random 10-character id (≈51 bits), unique enough for ops and revisions. */
export function randomId(length = 10): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let id = "";
  for (const b of bytes) id += ID_ALPHABET[b % ID_ALPHABET.length];
  return id;
}

/** Paper whose long side is PAPER_LONG_SIDE and whose aspect ratio matches `width / height`. */
export function paperForAspect(width: number, height: number): Paper {
  if (!(width > 0) || !(height > 0)) return { w: PAPER_LONG_SIDE, h: PAPER_LONG_SIDE };
  if (width >= height) {
    return { w: PAPER_LONG_SIDE, h: Math.max(1, Math.round((PAPER_LONG_SIDE * height) / width)) };
  }
  return { w: Math.max(1, Math.round((PAPER_LONG_SIDE * width) / height)), h: PAPER_LONG_SIDE };
}

/** Index of the first op that is still visible (just after the last clear). */
export function visibleStart(ops: readonly Op[]): number {
  for (let i = ops.length - 1; i >= 0; i--) {
    if (ops[i]!.kind === "clear") return i + 1;
  }
  return 0;
}

/** Strokes that currently contribute to the picture. */
export function visibleStrokes(ops: readonly Op[]): StrokeOp[] {
  const out: StrokeOp[] = [];
  for (let i = visibleStart(ops); i < ops.length; i++) {
    const op = ops[i]!;
    if (op.kind === "stroke") out.push(op);
  }
  return out;
}

/** True when the picture has no visible ink (eraser-only strokes count as empty). */
export function isPictureEmpty(ops: readonly Op[]): boolean {
  return !visibleStrokes(ops).some((s) => s.tool !== "eraser");
}

export function sameOpIds(a: readonly Op[], b: readonly Op[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]!.id !== b[i]!.id) return false;
  return true;
}

/**
 * Map strokes from one paper onto another (contain-fit, centred) and give them
 * fresh ids. Used when pasting a copied drawing onto a different token.
 */
export function transplantStrokes(strokes: readonly StrokeOp[], from: Paper, to: Paper): StrokeOp[] {
  const scale = Math.min(to.w / from.w, to.h / from.h);
  const ox = (to.w - from.w * scale) / 2;
  const oy = (to.h - from.h * scale) / 2;
  return strokes.map((s) => {
    const pts = new Array<number>(s.points.length);
    for (let i = 0; i < s.points.length; i += 3) {
      pts[i] = s.points[i]! * scale + ox;
      pts[i + 1] = s.points[i + 1]! * scale + oy;
      pts[i + 2] = s.points[i + 2]!;
    }
    return { ...s, id: randomId(), size: s.size * scale, points: pts };
  });
}
