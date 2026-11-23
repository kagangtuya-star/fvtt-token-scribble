import { MODULE_ID } from "../constants.ts";
import { DEFAULT_PALETTE } from "../engine/brushes.ts";
import { freehandOutliner } from "../engine/freehand.ts";
import { createDomCanvas, Raster } from "../engine/raster.ts";
import { ScribbleEditor } from "../editor/editor.ts";
import { InputController } from "../editor/input.ts";
import type { Command } from "../editor/keymap.ts";
import { paperExtent } from "../model/extent.ts";
import { paperForAspect, transplantStrokes, visibleStrokes } from "../model/ops.ts";
import { isVectorSrc, isVideoSrc, outputSize } from "../model/replace.ts";
import { decodeDrawing } from "../model/serialize.ts";
import type { Op, Paper } from "../model/types.ts";
import { BrushCursor } from "../ui/cursor.ts";
import { h, icon } from "../ui/dom.ts";
import { Toolbar } from "../ui/toolbar.ts";
import type { MenuItem } from "../ui/toolbar.ts";
import { confirm, downloadBlob, notify, safeFilename } from "./compat.ts";
import { loadImage } from "./files.ts";
import { esc, t } from "./i18n.ts";
import { applyReplacement, BackupError, replaceRefusal, restoreOriginal } from "./replace.ts";
import type { ReplaceTarget } from "./replace.ts";
import { getPressureMode, getToolState, saveToolState } from "./settings.ts";

/**
 * Replace mode editor: a Foundry window with its own drawing stage. The
 * result is baked into a new image file that replaces the token image or the
 * actor portrait (see replace.ts), so it works with any module that reads
 * plain images. Unlike the in-place editor, the eraser here also erases the
 * original image.
 */

/** Toolbar strings that differ in replace mode. */
const KEY_OVERRIDES: Record<string, string> = {
  "ToolHint.eraser": "Replace.EraserHint",
  "ToolHint.eraserLong": "Replace.EraserLong",
  "Toolbar.Focus": "Replace.Fit",
  "Status.saved": "Replace.StatusClean",
  "Status.dirty": "Replace.StatusDirty",
};

const MAX_EDIT_PX = 2048;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 32;

interface Loaded {
  image: HTMLImageElement | null;
  paper: Paper;
  out: { w: number; h: number };
  ops: Op[];
  bakesOverlay: boolean;
}

/** Load the current image and any in-place drawing that should be baked in. */
async function loadTarget(target: ReplaceTarget): Promise<Loaded> {
  const src = target.src();
  let image: HTMLImageElement | null = null;
  if (src) image = await loadImage(src);
  const nw = image?.naturalWidth ?? 0;
  const nh = image?.naturalHeight ?? 0;
  const out = outputSize(nw, nh, isVectorSrc(src));
  const paper = paperForAspect(out.w, out.h);
  let ops: Op[] = [];
  let bakesOverlay = false;
  const decoded = decodeDrawing(target.overlay());
  if (decoded.ok) {
    const strokes = visibleStrokes(decoded.state.ops);
    if (strokes.length) {
      ops = transplantStrokes(strokes, decoded.state.paper, paper);
      bakesOverlay = true;
    }
  }
  return { image, paper, out, ops, bakesOverlay };
}

/** Topmost z-index of an element or its ancestors (Foundry windows set it inline). */
function zIndexOf(el: Element | null): number {
  for (let e = el; e; e = e.parentElement) {
    const z = Number.parseInt(getComputedStyle(e).zIndex, 10);
    if (Number.isFinite(z)) return z;
  }
  return 100;
}

type WindowCtor = new (target: ReplaceTarget, loaded: Loaded) => ReplaceWindow;

export interface ReplaceWindow extends ApplicationV2Instance {
  readonly target: ReplaceTarget;
}

let windowClass: WindowCtor | null = null;
let current: ReplaceWindow | null = null;

/** Built on first use: ApplicationV2 only exists once Foundry has loaded. */
function getWindowClass(): WindowCtor {
  if (windowClass) return windowClass;
  const Base = foundry.applications.api.ApplicationV2;

  class ReplaceEditorWindow extends Base implements ReplaceWindow {
    static override DEFAULT_OPTIONS: ApplicationV2Options = {
      classes: ["ts-replace-app"],
      window: {
        icon: "fa-solid fa-paintbrush",
        resizable: true,
        minimizable: true,
        contentClasses: ["ts-replace-content"],
      },
      position: { width: 760, height: 700 },
    };

    readonly target: ReplaceTarget;
    readonly #loaded: Loaded;
    readonly #editor: ScribbleEditor;
    readonly #abort = new AbortController();
    readonly #cursor = new BrushCursor();
    #root: HTMLElement | null = null;
    #stage!: HTMLElement;
    #canvas!: HTMLCanvasElement;
    #ctx!: CanvasRenderingContext2D;
    #toolbar: Toolbar | null = null;
    #input: InputController | null = null;
    #applyBtn!: HTMLButtonElement;
    #restoreBtn!: HTMLButtonElement;
    #protoBox: HTMLInputElement | null = null;
    #frame = 0;
    #dirtyView = true;
    #view = { zoom: 1, x: 0, y: 0 };
    #fitted = false;
    #hover: { x: number; y: number; over: boolean } | null = null;
    #pan: { id: number; x: number; y: number; vx: number; vy: number } | null = null;
    #active = false;
    #busy = false;
    #closing = false;
    #checker: CanvasPattern | null = null;

    constructor(target: ReplaceTarget, loaded: Loaded) {
      super({
        id: `${MODULE_ID}-replace-${target.kind}-${target.docId}`,
        window: {
          title: t(target.kind === "token" ? "Replace.TitleToken" : "Replace.TitlePortrait", { name: target.name }),
        },
      });
      this.target = target;
      this.#loaded = loaded;
      this.#editor = new ScribbleEditor({
        paper: loaded.paper,
        ops: loaded.ops,
        outliner: freehandOutliner,
        rasterPx: Math.min(MAX_EDIT_PX, Math.max(loaded.out.w, loaded.out.h)),
        tools: getToolState(),
        pressureMode: getPressureMode(),
        maxBytes: Number.POSITIVE_INFINITY,
        measure: () => 0,
        placeholder: false,
        background: loaded.image,
        overflow: false,
      });
    }

    /* ---------------- ApplicationV2 ---------------- */

    override async _renderHTML(): Promise<HTMLElement> {
      this.#root ??= this.#build();
      return this.#root;
    }

    override _replaceHTML(result: unknown, content: HTMLElement): void {
      if (result instanceof HTMLElement && result.parentElement !== content) {
        content.replaceChildren(result);
        queueMicrotask(() => this.#start());
      }
    }

    override async close(options: { animate?: boolean } = {}): Promise<unknown> {
      if (this.#busy) return this;
      if (!this.#closing && this.#editor.snapshot().canUndo) {
        const ok = await confirm(
          t("Replace.DiscardTitle"),
          `<p>${esc(t("Replace.DiscardContent"))}</p>`,
          t("Replace.Discard"),
        );
        if (!ok) return this;
      }
      this.#closing = true;
      return super.close(options);
    }

    override _onClose(options: unknown): void {
      super._onClose(options);
      this.#abort.abort();
      cancelAnimationFrame(this.#frame);
      this.#input?.detach();
      this.#toolbar?.destroy();
      this.#cursor.destroy();
      saveToolState(this.#editor.tools);
      if (current === this) current = null;
    }

    /* ---------------- DOM ---------------- */

    #build(): HTMLElement {
      this.#canvas = h("canvas", { class: "ts-replace-canvas", "aria-label": t("Replace.Canvas") });
      this.#ctx = this.#canvas.getContext("2d")!;
      this.#stage = h("div", { class: "ts-replace-stage" }, this.#canvas);
      const dockHost = h("div", { class: "ts-replace-dock" });

      const info = h(
        "p",
        { class: "ts-replace-info" },
        icon("fa-solid fa-circle-info"),
        h("span", {}, t("Replace.Info", { w: this.#loaded.out.w, h: this.#loaded.out.h })),
      );
      if (this.#loaded.bakesOverlay) info.append(h("span", {}, t("Replace.BakesOverlay")));

      const options = h("div", { class: "ts-replace-options" });
      if (this.target.prototypeActor()) {
        this.#protoBox = h("input", { type: "checkbox", name: "prototype" });
        this.#protoBox.checked = true;
        options.append(
          h("label", { class: "ts-replace-check" }, this.#protoBox, h("span", {}, t("Replace.Prototype"))),
        );
      }

      this.#restoreBtn = h(
        "button",
        { type: "button", class: "ts-replace-restore" },
        icon("fa-solid fa-clock-rotate-left"),
        h("span", {}, t("Replace.Restore")),
      );
      this.#restoreBtn.hidden = !this.target.record();
      this.#restoreBtn.addEventListener("click", () => void this.#restore(), { signal: this.#abort.signal });
      const cancel = h("button", { type: "button", class: "ts-replace-cancel" }, h("span", {}, t("Replace.Cancel")));
      cancel.addEventListener("click", () => void this.close(), { signal: this.#abort.signal });
      this.#applyBtn = h(
        "button",
        { type: "button", class: "ts-replace-apply" },
        icon("fa-solid fa-check"),
        h("span", {}, t("Replace.Apply")),
      );
      this.#applyBtn.addEventListener("click", () => void this.#apply(), { signal: this.#abort.signal });

      const footer = h(
        "footer",
        { class: "ts-replace-footer", "data-ts-ui": true },
        options,
        h("div", { class: "ts-replace-actions" }, this.#restoreBtn, cancel, this.#applyBtn),
      );
      return h("div", { class: "ts-replace" }, this.#stage, dockHost, info, footer);
    }

    #start(): void {
      if (this.#toolbar) return;
      const sig = { signal: this.#abort.signal };
      const dockHost = this.#root!.querySelector<HTMLElement>(".ts-replace-dock")!;
      this.#toolbar = new Toolbar(
        this.#editor,
        {
          t: (key, data) => t(KEY_OVERRIDES[key] ?? key, data),
          palette: DEFAULT_PALETTE,
          screenPxPerUnit: () => this.#view.zoom,
          command: (cmd) => this.#command(cmd),
          done: () => void this.#apply(),
          menu: () => this.#menu(),
          initialPosition: null,
          savePosition: () => {},
          mount: dockHost,
          layer: () => zIndexOf(this.element) + 1,
        },
        this.target.name,
      );
      this.#toolbar.setStatus("saved");

      // Which window the keyboard belongs to: decided by the last press. Registered
      // before the input controller so it sees presses the controller swallows.
      window.addEventListener(
        "pointerdown",
        (e) => {
          const target = e.target as Element;
          this.#active = this.element.contains(target) || !!target.closest?.(".ts-popover");
        },
        { capture: true, ...sig },
      );
      this.#input = new InputController(this.#editor, {
        isDrawTarget: (target) => target === this.#canvas && !this.#busy,
        clientToPaper: (x, y) => this.#clientToPaper(x, y),
        hover: (x, y, over) => {
          this.#hover = { x, y, over };
          this.#refreshCursor();
        },
        command: (cmd) => this.#command(cmd),
        ownsKey: (e) => this.#active || this.element.contains(e.target as Node),
      });
      this.#input.attach();

      this.#editor.on((e) => {
        if (e.type === "change") this.#refreshCursor();
        if (e.type === "ops") this.#toolbar?.setStatus(this.#editor.snapshot().canUndo ? "dirty" : "saved");
      });

      // Navigation inside the stage: wheel zooms at the pointer, right/middle drag pans.
      this.#canvas.addEventListener("wheel", (e) => this.#onWheel(e), { passive: false, ...sig });
      this.#canvas.addEventListener("pointerdown", (e) => this.#onPanStart(e), sig);
      this.#canvas.addEventListener("pointermove", (e) => this.#onPanMove(e), sig);
      this.#canvas.addEventListener("pointerup", (e) => this.#onPanEnd(e), sig);
      this.#canvas.addEventListener("pointercancel", (e) => this.#onPanEnd(e), sig);
      this.#canvas.addEventListener("contextmenu", (e) => e.preventDefault(), sig);
      this.#canvas.addEventListener("pointerleave", () => this.#cursor.hide(), sig);
      const resizer = new ResizeObserver(() => this.#resize());
      resizer.observe(this.#stage);
      this.#abort.signal.addEventListener("abort", () => resizer.disconnect());
      this.#active = true;
      this.#resize();
      this.#loop();
    }

    /* ---------------- View ---------------- */

    #resize(): void {
      const r = this.#stage.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      const dpr = window.devicePixelRatio || 1;
      this.#canvas.width = Math.round(r.width * dpr);
      this.#canvas.height = Math.round(r.height * dpr);
      this.#canvas.style.width = `${r.width}px`;
      this.#canvas.style.height = `${r.height}px`;
      if (!this.#fitted) this.#fit();
      this.#dirtyView = true;
    }

    #fit(): void {
      const r = this.#stage.getBoundingClientRect();
      const { w, h: ph } = this.#editor.paper;
      const zoom = Math.max(MIN_ZOOM, Math.min((r.width - 32) / w, (r.height - 32) / ph));
      this.#view = { zoom, x: (r.width - w * zoom) / 2, y: (r.height - ph * zoom) / 2 };
      this.#fitted = true;
      this.#dirtyView = true;
      this.#toolbar?.refreshScale();
    }

    #clientToPaper(clientX: number, clientY: number) {
      const r = this.#canvas.getBoundingClientRect();
      const { zoom, x, y } = this.#view;
      return { x: (clientX - r.left - x) / zoom, y: (clientY - r.top - y) / zoom };
    }

    #onWheel(e: WheelEvent): void {
      if (e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return; // brush size (input controller)
      e.preventDefault();
      const r = this.#canvas.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const v = this.#view;
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.zoom * Math.exp(-e.deltaY * 0.0015)));
      this.#view = { zoom, x: px - ((px - v.x) * zoom) / v.zoom, y: py - ((py - v.y) * zoom) / v.zoom };
      this.#dirtyView = true;
      this.#toolbar?.refreshScale();
      this.#refreshCursor();
    }

    #onPanStart(e: PointerEvent): void {
      if (e.button !== 1 && e.button !== 2) return;
      e.preventDefault();
      this.#canvas.setPointerCapture(e.pointerId);
      this.#pan = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: this.#view.x, vy: this.#view.y };
    }

    #onPanMove(e: PointerEvent): void {
      const p = this.#pan;
      if (!p || p.id !== e.pointerId) return;
      this.#view = { ...this.#view, x: p.vx + e.clientX - p.x, y: p.vy + e.clientY - p.y };
      this.#dirtyView = true;
    }

    #onPanEnd(e: PointerEvent): void {
      if (this.#pan?.id !== e.pointerId) return;
      this.#pan = null;
      try {
        this.#canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    }

    #refreshCursor(): void {
      const hv = this.#hover;
      if (!hv?.over || this.#pan) {
        this.#cursor.hide();
        return;
      }
      const tools = this.#editor.tools;
      const mode = tools.tool === "eraser" ? "erase" : tools.tool === "fill" ? "fill" : "ink";
      const d = tools.tool === "fill" ? 10 : tools.sizes[tools.tool] * this.#view.zoom;
      this.#cursor.setLayer(zIndexOf(this.element));
      this.#cursor.update(hv.x, hv.y, d, mode, tools.color);
    }

    /* ---------------- Rendering ---------------- */

    #loop = (): void => {
      this.#frame = requestAnimationFrame(this.#loop);
      const changed = this.#editor.flush();
      if (!changed && !this.#dirtyView) return;
      this.#dirtyView = false;
      this.#draw();
    };

    #draw(): void {
      const ctx = this.#ctx;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const { zoom, x, y } = this.#view;
      const { w, h: ph } = this.#editor.paper;
      // Transparency checkerboard under the image.
      this.#checker ??= this.#makeChecker();
      if (this.#checker) {
        ctx.save();
        ctx.fillStyle = this.#checker;
        ctx.fillRect(x, y, w * zoom, ph * zoom);
        ctx.restore();
      }
      const raster = this.#editor.raster;
      const e = raster.extent;
      ctx.imageSmoothingEnabled = zoom * (raster.width / e.w) < 2;
      ctx.drawImage(raster.display as CanvasImageSource, x + e.x * zoom, y + e.y * zoom, e.w * zoom, e.h * zoom);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.strokeRect(Math.round(x) - 0.5, Math.round(y) - 0.5, Math.round(w * zoom) + 1, Math.round(ph * zoom) + 1);
    }

    #makeChecker(): CanvasPattern | null {
      const c = document.createElement("canvas");
      c.width = c.height = 16;
      const g = c.getContext("2d");
      if (!g) return null;
      g.fillStyle = "#d9d9d9";
      g.fillRect(0, 0, 16, 16);
      g.fillStyle = "#f4f4f4";
      g.fillRect(0, 0, 8, 8);
      g.fillRect(8, 8, 8, 8);
      return this.#ctx.createPattern(c, "repeat");
    }

    /* ---------------- Commands ---------------- */

    #command(cmd: Command): void {
      const ed = this.#editor;
      switch (cmd.type) {
        case "tool":
          ed.setTool(cmd.tool);
          break;
        case "color": {
          const c = DEFAULT_PALETTE[cmd.index];
          if (c) ed.setColor(c);
          break;
        }
        case "undo":
          ed.undo();
          break;
        case "redo":
          ed.redo();
          break;
        case "size":
          ed.stepSize(cmd.direction);
          break;
        case "mirror":
          ed.toggleMirror();
          break;
        case "focus":
          this.#fit();
          break;
        case "help":
          this.#toolbar?.showHelp();
          break;
        case "done":
          // Enter/Escape never apply or discard by accident here: they only close popovers.
          this.#toolbar?.closePopover();
          break;
      }
    }

    #menu(): MenuItem[] {
      const snap = this.#editor.snapshot();
      return [
        {
          id: "export",
          label: t("Replace.ExportPreview"),
          icon: "fa-solid fa-file-image",
          run: () =>
            void this.#render().then((blob) =>
              downloadBlob(blob, `${safeFilename(this.target.name)}-${this.target.kind}.png`),
            ),
        },
        {
          id: "clear",
          label: t("Replace.ClearStrokes"),
          icon: "fa-solid fa-broom",
          disabled: snap.empty,
          danger: true,
          divider: true,
          run: () => this.#editor.clear(),
        },
        {
          id: "help",
          label: t("Menu.Help"),
          icon: "fa-solid fa-keyboard",
          divider: true,
          run: () => this.#toolbar?.showHelp(),
        },
      ];
    }

    /* ---------------- Apply / restore ---------------- */

    /** The final image at output size. */
    async #render(): Promise<Blob> {
      const { paper, out, image } = this.#loaded;
      const canvas = Raster.renderStandalone(
        paper,
        this.#editor.doc.ops,
        Math.max(out.w, out.h),
        freehandOutliner,
        createDomCanvas,
        paperExtent(paper),
        image,
      ) as HTMLCanvasElement;
      return new Promise<Blob>((resolve, reject) => {
        try {
          canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))), "image/png");
        } catch (err) {
          // SecurityError: the source image came from another origin without CORS.
          reject(err);
        }
      });
    }

    #setBusy(busy: boolean): void {
      this.#busy = busy;
      this.#applyBtn.disabled = busy;
      this.#restoreBtn.disabled = busy;
      this.#root?.classList.toggle("ts-busy", busy);
      if (busy) this.#editor.cancelStroke();
    }

    async #apply(): Promise<void> {
      if (this.#busy) return;
      const refusal = replaceRefusal(this.target, isVideoSrc);
      if (refusal) {
        notify("warn", t(`Replace.Refused.${refusal}`));
        return;
      }
      this.#setBusy(true);
      this.#toolbar?.setStatus("saving");
      try {
        const blob = await this.#render();
        await applyReplacement(this.target, blob, {
          prototype: this.#protoBox?.checked === true,
          bakedOverlay: this.#loaded.bakesOverlay,
        });
        notify(
          "info",
          t(this.target.kind === "token" ? "Replace.DoneToken" : "Replace.DonePortrait", { name: this.target.name }),
        );
        this.#closing = true;
        this.#busy = false;
        await this.close();
      } catch (err) {
        console.error(`${MODULE_ID} | replace failed`, err);
        const key =
          err instanceof BackupError
            ? "Replace.BackupFailed"
            : (err as Error)?.name === "SecurityError"
              ? "Replace.CrossOrigin"
              : "Replace.Failed";
        notify("error", t(key));
        this.#toolbar?.setStatus("error", t(key));
        this.#setBusy(false);
      }
    }

    async #restore(): Promise<void> {
      if (this.#busy || !this.target.record()) return;
      const ok = await confirm(
        t("Replace.RestoreTitle"),
        `<p>${esc(t("Replace.RestoreContent"))}</p>`,
        t("Replace.Restore"),
      );
      if (!ok) return;
      this.#setBusy(true);
      try {
        await restoreOriginal(this.target);
        notify("info", t("Replace.Restored", { name: this.target.name }));
        this.#closing = true;
        this.#busy = false;
        await this.close();
      } catch (err) {
        console.error(`${MODULE_ID} | restore failed`, err);
        notify("error", t("Replace.RestoreFailed"));
        this.#setBusy(false);
      }
    }
  }

  windowClass = ReplaceEditorWindow;
  return windowClass;
}

/** Open the replace-mode editor for a target (one at a time). */
export async function openReplaceEditor(target: ReplaceTarget): Promise<ReplaceWindow | null> {
  const refusal = replaceRefusal(target, isVideoSrc);
  if (refusal) {
    notify("warn", t(`Replace.Refused.${refusal}`));
    return null;
  }
  if (current) {
    if (current.target.kind === target.kind && current.target.docId === target.docId) {
      current.bringToFront();
      return current;
    }
    notify("info", t("Replace.AlreadyOpen"));
    current.bringToFront();
    return null;
  }
  let loaded: Loaded;
  try {
    loaded = await loadTarget(target);
  } catch (err) {
    console.error(`${MODULE_ID} | could not load image for replace mode`, err);
    notify("error", t("Replace.LoadFailed"));
    return null;
  }
  const Win = getWindowClass();
  const win = new Win(target, loaded);
  current = win;
  await win.render({ force: true });
  return win;
}

/** Restore without opening the editor (context menus, API). */
export async function restoreTarget(target: ReplaceTarget): Promise<boolean> {
  if (!target.record()) return false;
  if (!target.canModify()) {
    notify("warn", t("Replace.Refused.permission"));
    return false;
  }
  const ok = await confirm(
    t("Replace.RestoreTitle"),
    `<p>${esc(t("Replace.RestoreContent"))}</p>`,
    t("Replace.Restore"),
  );
  if (!ok) return false;
  try {
    await restoreOriginal(target);
    notify("info", t("Replace.Restored", { name: target.name }));
    return true;
  } catch (err) {
    console.error(`${MODULE_ID} | restore failed`, err);
    notify("error", t("Replace.RestoreFailed"));
    return false;
  }
}

export const replaceWindowOpen = (): boolean => current !== null;
