import { BRUSHES, clampSize } from "../engine/brushes.ts";
import type { Outliner } from "../engine/geometry.ts";
import type { PressureMode, PressureSample } from "../engine/pressure.ts";
import { Raster } from "../engine/raster.ts";
import type { CanvasFactory } from "../engine/raster.ts";
import { StrokeRecorder } from "../engine/recorder.ts";
import { ScribbleDocument } from "../model/document.ts";
import { EXTENT_STEP, containsExtent, drawingExtent, growExtent, paperExtent, sameExtent, strokeBox } from "../model/extent.ts";
import type { Extent } from "../model/extent.ts";
import { isPictureEmpty, randomId, transplantStrokes } from "../model/ops.ts";
import type { Op, Paper, StrokeOp, ToolId } from "../model/types.ts";
import { rememberColor } from "./tool-state.ts";
import type { ToolState } from "./tool-state.ts";

export interface EditorOptions {
  paper: Paper;
  ops: readonly Op[];
  outliner: Outliner;
  /** Long side of the raster in device pixels. */
  rasterPx: number;
  canvasFactory?: CanvasFactory;
  tools: ToolState;
  pressureMode: PressureMode;
  /** Storage budget in bytes and a function measuring a log's stored size. */
  maxBytes: number;
  measure: (ops: readonly Op[]) => number;
  /** Draw a "draw here" placeholder while the picture is empty. */
  placeholder: boolean;
  /** Image under the strokes that erasers may erase (replace mode). */
  background?: CanvasImageSource | null;
  /** Grow the raster for ink outside the paper (default true). */
  overflow?: boolean;
}

/** UI-facing read model. */
export interface EditorSnapshot {
  tool: ToolId;
  color: string;
  size: number;
  opacity: number;
  thinning: number;
  mirror: boolean;
  recent: readonly string[];
  canUndo: boolean;
  canRedo: boolean;
  empty: boolean;
  drawing: boolean;
  usageBytes: number;
  maxBytes: number;
  realPressure: boolean;
}

export type EditorEvent =
  | { type: "change" }
  /** The op log changed (persist it). */
  | { type: "ops" }
  | { type: "budget" };

export interface BeginOptions {
  /** Straight line from the press point (Shift). */
  line?: boolean;
  /** Temporarily use a different tool (pen eraser end, Alt). */
  toolOverride?: ToolId;
}

interface LiveStroke {
  pointerId: number;
  recorder: StrokeRecorder;
  template: Omit<StrokeOp, "points">;
}

/**
 * Host-independent editing core: tool state, live stroke capture, history and
 * rasterisation. It knows nothing about Foundry; hosts feed it paper-space
 * samples and upload `raster.display` when {@link flush} reports a change.
 */
export class ScribbleEditor {
  readonly doc: ScribbleDocument;
  readonly tools: ToolState;
  readonly #opts: EditorOptions;
  #raster: Raster;
  #live: LiveStroke | null = null;
  #liveDirty = false;
  #displayChanged = true;
  #usage: number;
  #realPressure = false;
  readonly #listeners = new Set<(e: EditorEvent) => void>();

  constructor(opts: EditorOptions) {
    this.#opts = opts;
    this.tools = opts.tools;
    this.doc = new ScribbleDocument(opts.paper, opts.ops);
    this.#raster = new Raster(opts.paper, opts.rasterPx, opts.outliner, opts.canvasFactory, this.#neededExtent());
    this.#raster.background = opts.background ?? null;
    this.#raster.renderAll(this.doc.ops, this.#wantsPlaceholder());
    this.#usage = opts.measure(this.doc.ops);
  }

  get raster(): Raster {
    return this.#raster;
  }

  get paper(): Paper {
    return this.doc.paper;
  }

  get isDrawing(): boolean {
    return this.#live !== null;
  }

  get activePointer(): number | null {
    return this.#live?.pointerId ?? null;
  }

  on(fn: (e: EditorEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit(e: EditorEvent): void {
    for (const fn of this.#listeners) fn(e);
  }

  #wantsPlaceholder(): boolean {
    return this.#opts.placeholder && isPictureEmpty(this.doc.ops);
  }

  snapshot(): EditorSnapshot {
    const t = this.tools;
    return {
      tool: t.tool,
      color: t.color,
      size: t.sizes[t.tool],
      opacity: t.opacity[t.tool],
      thinning: t.thinning[t.tool],
      mirror: t.mirror,
      recent: t.recent,
      canUndo: this.doc.canUndo,
      canRedo: this.doc.canRedo,
      empty: isPictureEmpty(this.doc.ops),
      drawing: this.isDrawing,
      usageBytes: this.#usage,
      maxBytes: this.#opts.maxBytes,
      realPressure: this.#realPressure,
    };
  }

  /* -------------------------------------------- */
  /*  Tool state                                  */
  /* -------------------------------------------- */

  setTool(tool: ToolId): void {
    if (this.tools.tool === tool) return;
    this.tools.tool = tool;
    this.#emit({ type: "change" });
  }

  setColor(color: string): void {
    this.tools.color = color;
    rememberColor(this.tools, color);
    // Picking a colour while erasing means "I want to paint again".
    if (this.tools.tool === "eraser") this.tools.tool = "pen";
    this.#emit({ type: "change" });
  }

  setSize(size: number, tool: ToolId = this.tools.tool): void {
    this.tools.sizes[tool] = clampSize(tool, size);
    this.#emit({ type: "change" });
  }

  /** Multiplicative size step used by `[`/`]` and Alt+wheel. */
  stepSize(direction: 1 | -1): void {
    const cur = this.tools.sizes[this.tools.tool];
    const next = direction > 0 ? Math.max(cur + 1, cur * 1.18) : Math.min(cur - 1, cur / 1.18);
    this.setSize(next);
  }

  /** Pressure sensitivity for pressure-aware tools (stored per stroke when non-default). */
  setThinning(thinning: number): void {
    const tool = this.tools.tool;
    if (!BRUSHES[tool].usesPressure) return;
    this.tools.thinning[tool] = Math.min(0.95, Math.max(0, Math.round(thinning * 100) / 100));
    this.#emit({ type: "change" });
  }

  setOpacity(opacity: number): void {
    this.tools.opacity[this.tools.tool] = Math.min(1, Math.max(0.05, Math.round(opacity * 100) / 100));
    this.#emit({ type: "change" });
  }

  toggleMirror(): void {
    this.tools.mirror = !this.tools.mirror;
    this.#emit({ type: "change" });
  }

  /* -------------------------------------------- */
  /*  Strokes                                     */
  /* -------------------------------------------- */

  beginStroke(pointerId: number, sample: PressureSample, options: BeginOptions = {}): void {
    if (this.#live) this.endStroke();
    const tool = options.toolOverride ?? this.tools.tool;
    const preset = BRUSHES[tool];
    const size = this.tools.sizes[tool];
    const recorder = new StrokeRecorder({
      streamline: preset.streamline,
      size,
      pressureMode: this.#opts.pressureMode,
      usesPressure: preset.usesPressure,
      minDistance: Math.max(0.2, size * 0.04),
    });
    recorder.lineMode = options.line === true && !preset.fill;
    recorder.add(sample);
    const thinning = this.tools.thinning[tool];
    const params = preset.usesPressure && thinning !== preset.thinning ? { thinning } : undefined;
    this.#live = {
      pointerId,
      recorder,
      template: {
        kind: "stroke",
        id: randomId(),
        tool,
        color: this.tools.color,
        opacity: preset.erase ? 1 : this.tools.opacity[tool],
        size,
        mirror: this.tools.mirror,
        ...(params ? { params } : {}),
      },
    };
    this.#liveDirty = true;
    this.#emit({ type: "change" });
  }

  addSamples(samples: readonly PressureSample[], line?: boolean): void {
    const live = this.#live;
    if (!live) return;
    if (line !== undefined && !BRUSHES[live.template.tool].fill) live.recorder.lineMode = line;
    for (const s of samples) live.recorder.add(s);
    this.#liveDirty = true;
    if (live.recorder.full) {
      // Very long scribbles are split so a single op never grows without bound.
      const last = samples[samples.length - 1]!;
      const pointerId = live.pointerId;
      const tool = live.template.tool;
      this.endStroke();
      this.beginStroke(pointerId, last, { toolOverride: tool });
    }
  }

  endStroke(): void {
    const live = this.#live;
    if (!live) return;
    this.#live = null;
    this.#liveDirty = true;
    this.#realPressure ||= live.recorder.usesRealPressure;
    const points = live.recorder.finish();
    const isFill = BRUSHES[live.template.tool].fill;
    if (points.length < 3 || (isFill && points.length < 9)) {
      this.#emit({ type: "change" });
      return;
    }
    const op: StrokeOp = { ...live.template, points };
    this.#commit([op]);
  }

  cancelStroke(): void {
    if (!this.#live) return;
    this.#live = null;
    this.#liveDirty = true;
    this.#emit({ type: "change" });
  }

  #commit(ops: Op[]): boolean {
    const next = [...this.doc.ops, ...ops];
    const usage = this.#opts.measure(next);
    if (usage > this.#opts.maxBytes && ops.some((o) => o.kind === "stroke")) {
      this.#emit({ type: "budget" });
      this.#emit({ type: "change" });
      return false;
    }
    this.doc.add(ops);
    this.#afterOpsChanged(usage, true);
    return true;
  }

  /**
   * Keep the raster covering every visible stroke. Appends only ever grow it
   * (so the margin added while drawing is kept); other changes replay the
   * whole log anyway and may shrink it back.
   */
  #neededExtent(): Extent {
    return this.#opts.overflow === false ? paperExtent(this.#opts.paper) : drawingExtent(this.doc.ops, this.#opts.paper);
  }

  #fitRaster(appended: boolean): boolean {
    const need = this.#neededExtent();
    const cur = this.#raster.extent;
    if (appended ? containsExtent(cur, need) : sameExtent(cur, need)) return false;
    this.#rebuildRaster(this.#raster.requestedPx, appended ? growExtent(cur, [need.x, need.y, need.x + need.w, need.y + need.h], this.paper) : need);
    return true;
  }

  #rebuildRaster(longSidePx: number, extent: Extent): void {
    this.#raster = new Raster(this.paper, longSidePx, this.#opts.outliner, this.#opts.canvasFactory, extent);
    this.#raster.background = this.#opts.background ?? null;
    this.#raster.renderAll(this.doc.ops, this.#wantsPlaceholder());
    this.#liveDirty = true;
    this.#displayChanged = true;
  }

  #afterOpsChanged(usage?: number, appended = false): void {
    this.#usage = usage ?? this.#opts.measure(this.doc.ops);
    if (!this.#fitRaster(appended)) this.#raster.sync(this.doc.ops, this.#wantsPlaceholder());
    this.#displayChanged = true;
    this.#emit({ type: "ops" });
    this.#emit({ type: "change" });
  }

  undo(): boolean {
    if (this.#live) this.cancelStroke();
    if (!this.doc.undo()) return false;
    this.#afterOpsChanged();
    return true;
  }

  redo(): boolean {
    if (this.#live) return false;
    if (!this.doc.redo()) return false;
    this.#afterOpsChanged();
    return true;
  }

  clear(): boolean {
    if (this.#live) this.cancelStroke();
    if (!this.doc.clear()) return false;
    this.#afterOpsChanged();
    return true;
  }

  /** Paste strokes copied from another drawing as one undoable group. */
  paste(strokes: readonly StrokeOp[], from: Paper): boolean {
    if (strokes.length === 0) return false;
    return this.#commit(transplantStrokes(strokes, from, this.paper));
  }

  /** Replace the log after merging remote changes. */
  applyMerged(ops: readonly Op[]): void {
    this.doc.replace(ops);
    this.#afterOpsChanged();
  }

  /** Replace the log with a revert result (counts as a local edit). */
  applyRevert(ops: readonly Op[]): void {
    this.doc.replace(ops);
    this.#afterOpsChanged();
  }

  /** Rebuild the raster at a new resolution (e.g. zoom level changed a lot). */
  resizeRaster(longSidePx: number): void {
    if (Math.abs(longSidePx - this.#raster.requestedPx) < 8) return;
    this.#rebuildRaster(longSidePx, this.#raster.extent);
  }

  /**
   * Called once per animation frame by the host. Returns true when the
   * display canvas changed and must be uploaded.
   */
  flush(): boolean {
    if (this.#liveDirty) {
      const live = this.#live;
      const stroke = live ? { ...live.template, points: live.recorder.preview() } : null;
      // Ink leaving the current raster: grow it (with headroom) before drawing.
      if (stroke && stroke.tool !== "eraser" && this.#opts.overflow !== false) {
        const cur = this.#raster.extent;
        const next = growExtent(cur, strokeBox(stroke, this.paper), this.paper, EXTENT_STEP);
        if (!sameExtent(cur, next)) this.#rebuildRaster(this.#raster.requestedPx, next);
      }
      this.#liveDirty = false;
      this.#raster.showLive(stroke);
      this.#displayChanged = true;
    }
    const changed = this.#displayChanged;
    this.#displayChanged = false;
    return changed;
  }
}
