import { strokeGeometry } from "./geometry.ts";
import type { Outliner } from "./geometry.ts";
import { drawingExtent } from "../model/extent.ts";
import { visibleStrokes } from "../model/ops.ts";
import type { Op, Paper } from "../model/types.ts";

/**
 * Export the visible drawing as a standalone SVG document. Eraser strokes are
 * expressed as nested masks so they only affect what was drawn before them,
 * exactly like the canvas renderer. The view box covers ink drawn outside the
 * paper as well; paper coordinates are kept, so it may start at negative values.
 */
export function drawingToSvg(paper: Paper, ops: readonly Op[], outliner: Outliner): string {
  const { w } = paper;
  const e = drawingExtent(ops, paper);
  const box = `x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}"`;
  const defs: string[] = [];
  let group: string[] = [];
  let maskIndex = 0;
  const mirror = `transform="matrix(-1 0 0 1 ${w} 0)"`;
  for (const op of visibleStrokes(ops)) {
    const d = strokeGeometry(op, outliner).path;
    if (!d) continue;
    if (op.tool === "eraser") {
      const id = `ts-erase-${maskIndex++}`;
      const cut = `<path d="${d}" fill="#000"/>` + (op.mirror ? `<path d="${d}" fill="#000" ${mirror}/>` : "");
      defs.push(
        `<mask id="${id}" maskUnits="userSpaceOnUse" ${box}>` + `<rect ${box} fill="#fff"/>${cut}</mask>`,
      );
      group = [`<g mask="url(#${id})">${group.join("")}</g>`];
      continue;
    }
    const opacity = op.opacity < 1 ? ` fill-opacity="${op.opacity}"` : "";
    group.push(`<path d="${d}" fill="${op.color}"${opacity}/>`);
    if (op.mirror) group.push(`<path d="${d}" fill="${op.color}"${opacity} ${mirror}/>`);
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${e.x} ${e.y} ${e.w} ${e.h}" width="${e.w}" height="${e.h}">` +
    (defs.length ? `<defs>${defs.join("")}</defs>` : "") +
    group.join("") +
    `</svg>\n`
  );
}
