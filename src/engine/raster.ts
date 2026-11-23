import { strokeGeometry } from "./geometry.ts";
import type { Outliner } from "./geometry.ts";
import { paperExtent } from "../model/extent.ts";
import type { Extent } from "../model/extent.ts";
import { visibleStart } from "../model/ops.ts";
import type { Op, Paper, StrokeOp } from "../model/types.ts";

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type CanvasFactory = (width: number, height: number) => AnyCanvas;

export const createDomCanvas: CanvasFactory = (w, h) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

/** Hard cap on either canvas side; larger extents lower the resolution instead. */
export const MAX_CANVAS_PX = 4096;

/** Cached Path2D per immutable stroke object. */
const pathCache = new WeakMap<StrokeOp, Path2D>();

function ctxOf(canvas: AnyCanvas): Ctx {
  const ctx = canvas.getContext("2d") as Ctx | null;
  if (!ctx) throw new Error("TokenScribble: 2D canvas context unavailable");
  return ctx;
}

/**
 * Rasterises an op log onto a transparent canvas.
 *
 * Two canvases are kept: `committed` holds every finished stroke and only
 * changes on commit/undo/remote updates; `display` is what gets uploaded to the
 * GPU and additionally shows the stroke that is being drawn. Finished strokes
 * are drawn incrementally; a full replay only happens when history changes.
 *
 * The canvases cover `extent` (paper units), which may be larger than the
 * paper so ink drawn outside the token frame is kept. Canvas pixel (0, 0) is
 * paper point (extent.x, extent.y).
 */
export class Raster {
  readonly paper: Paper;
  readonly extent: Extent;
  /** The resolution that was asked for (paper long side, device px). */
  readonly requestedPx: number;
  /** Device pixels per paper unit. */
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  readonly committed: AnyCanvas;
  readonly display: AnyCanvas;
  /**
   * Image painted under the strokes, stretched over the paper (replace mode).
   * Erasers then remove image pixels too. Takes effect on the next full render.
   */
  background: CanvasImageSource | null = null;
  readonly #outliner: Outliner;
  #ops: readonly Op[] = [];
  #placeholder = false;
  #liveShown = false;

  constructor(
    paper: Paper,
    longSidePx: number,
    outliner: Outliner,
    factory: CanvasFactory = createDomCanvas,
    extent: Extent = paperExtent(paper),
  ) {
    this.paper = paper;
    this.extent = extent;
    this.requestedPx = Math.max(16, Math.round(longSidePx));
    const longSide = Math.max(paper.w, paper.h);
    this.scale = Math.min(this.requestedPx / longSide, MAX_CANVAS_PX / Math.max(extent.w, extent.h));
    this.width = Math.max(1, Math.round(extent.w * this.scale));
    this.height = Math.max(1, Math.round(extent.h * this.scale));
    this.committed = factory(this.width, this.height);
    this.display = factory(this.width, this.height);
    this.#outliner = outliner;
  }

  /** Paper long side in device pixels (after the canvas cap). */
  get paperPx(): number {
    return Math.max(this.paper.w, this.paper.h) * this.scale;
  }

  /** Ops currently represented by `committed`. */
  get ops(): readonly Op[] {
    return this.#ops;
  }

  #path(op: StrokeOp): Path2D {
    let p = pathCache.get(op);
    if (!p) {
      p = new Path2D(strokeGeometry(op, this.#outliner).path);
      pathCache.set(op, p);
    }
    return p;
  }

  #drawStroke(ctx: Ctx, op: StrokeOp, path: Path2D): void {
    ctx.save();
    ctx.globalCompositeOperation = op.tool === "eraser" ? "destination-out" : "source-over";
    ctx.globalAlpha = op.tool === "eraser" ? 1 : op.opacity;
    ctx.fillStyle = op.tool === "eraser" ? "#000" : op.color;
    const s = this.scale;
    const ox = -this.extent.x * s;
    const oy = -this.extent.y * s;
    ctx.setTransform(s, 0, 0, s, ox, oy);
    ctx.fill(path, "nonzero");
    if (op.mirror) {
      ctx.setTransform(-s, 0, 0, s, this.paper.w * s + ox, oy);
      ctx.fill(path, "nonzero");
    }
    ctx.restore();
  }

  #drawPlaceholder(ctx: Ctx): void {
    const s = this.scale;
    const { w, h } = this.paper;
    const inset = Math.min(w, h) * 0.08;
    ctx.save();
    ctx.setTransform(s, 0, 0, s, -this.extent.x * s, -this.extent.y * s);
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = Math.min(w, h) * 0.018;
    ctx.setLineDash([Math.min(w, h) * 0.06, Math.min(w, h) * 0.045]);
    const r = Math.min(w, h) * 0.12;
    ctx.beginPath();
    ctx.roundRect(inset, inset, w - inset * 2, h - inset * 2, r);
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = Math.min(w, h) * 0.02 * s;
    ctx.stroke();
    // A small nib glyph in the centre hints "draw here".
    ctx.setLineDash([]);
    const cx = w / 2;
    const cy = h / 2;
    const k = Math.min(w, h) * 0.12;
    ctx.beginPath();
    ctx.moveTo(cx - k, cy + k);
    ctx.lineTo(cx - k * 0.75, cy + k * 0.25);
    ctx.lineTo(cx + k * 0.6, cy - k * 1.1);
    ctx.lineTo(cx + k * 1.1, cy - k * 0.6);
    ctx.lineTo(cx - k * 0.25, cy + k * 0.75);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  /** Full replay of the visible part of the log. */
  renderAll(ops: readonly Op[], placeholder = false): void {
    this.#ops = ops.slice();
    this.#placeholder = placeholder;
    const ctx = ctxOf(this.committed);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (this.background) {
      const s = this.scale;
      ctx.drawImage(this.background, -this.extent.x * s, -this.extent.y * s, this.paper.w * s, this.paper.h * s);
    }
    for (let i = visibleStart(ops); i < ops.length; i++) {
      const op = ops[i]!;
      if (op.kind === "stroke") this.#drawStroke(ctx, op, this.#path(op));
    }
    if (placeholder) this.#drawPlaceholder(ctx);
    this.#copyToDisplay();
  }

  /**
   * Bring `committed` up to date with `ops`, incrementally when `ops` only
   * appended strokes to what is already drawn.
   */
  sync(ops: readonly Op[], placeholder = false): void {
    const prev = this.#ops;
    const appendOnly =
      !this.#placeholder &&
      !placeholder &&
      prev.length <= ops.length &&
      prev.every((op, i) => ops[i]!.id === op.id) &&
      ops.slice(prev.length).every((op) => op.kind === "stroke");
    if (!appendOnly) {
      this.renderAll(ops, placeholder);
      return;
    }
    if (prev.length === ops.length && !this.#liveShown) return;
    const ctx = ctxOf(this.committed);
    for (let i = prev.length; i < ops.length; i++) this.#drawStroke(ctx, ops[i] as StrokeOp, this.#path(ops[i] as StrokeOp));
    this.#ops = ops.slice();
    this.#copyToDisplay();
  }

  #copyToDisplay(): void {
    const ctx = ctxOf(this.display);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "copy";
    ctx.drawImage(this.committed, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    this.#liveShown = false;
  }

  /** Show `live` (an uncommitted stroke) on top of the committed picture. */
  showLive(live: StrokeOp | null): void {
    this.#copyToDisplay();
    if (!live || live.points.length === 0) return;
    const geometry = strokeGeometry(live, this.#outliner, true);
    this.#drawStroke(ctxOf(this.display), live, new Path2D(geometry.path));
    this.#liveShown = true;
  }

  /** Render the visible picture at an arbitrary resolution (PNG export), covering `extent`. */
  static renderStandalone(
    paper: Paper,
    ops: readonly Op[],
    longSidePx: number,
    outliner: Outliner,
    factory: CanvasFactory = createDomCanvas,
    extent: Extent = paperExtent(paper),
    background: CanvasImageSource | null = null,
  ): AnyCanvas {
    const r = new Raster(paper, longSidePx, outliner, factory, extent);
    r.background = background;
    r.renderAll(ops);
    return r.committed;
  }
}
