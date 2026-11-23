import type { Paper, Point } from "./types.ts";

/** Where the paper sits inside a texture frame of `width × height` (contain fit, centred). */
export interface PaperRect {
  x: number;
  y: number;
  /** Texture units per paper unit. */
  scale: number;
  width: number;
  height: number;
}

export function paperRectIn(paper: Paper, width: number, height: number): PaperRect {
  const scale = Math.min(width / paper.w, height / paper.h);
  const w = paper.w * scale;
  const hgt = paper.h * scale;
  return { x: (width - w) / 2, y: (height - hgt) / 2, scale, width: w, height: hgt };
}

/** Texture-frame point (origin top-left) → paper point. */
export function textureToPaper(rect: PaperRect, p: Point): Point {
  return { x: (p.x - rect.x) / rect.scale, y: (p.y - rect.y) / rect.scale };
}

/** Paper point → texture-frame point. */
export function paperToTexture(rect: PaperRect, p: Point): Point {
  return { x: rect.x + p.x * rect.scale, y: rect.y + p.y * rect.scale };
}
