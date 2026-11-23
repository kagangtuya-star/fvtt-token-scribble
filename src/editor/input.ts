import type { PressureSample } from "../engine/pressure.ts";
import type { Point, ToolId } from "../model/types.ts";
import type { ScribbleEditor } from "./editor.ts";
import { commandForKey, isPassThroughKey } from "./keymap.ts";
import type { Command } from "./keymap.ts";

export interface InputHost {
  /** Is this the drawing surface (e.g. the Foundry board canvas)? */
  isDrawTarget(target: EventTarget | null): boolean;
  /** Map viewport coordinates to paper coordinates (may lie outside the paper). */
  clientToPaper(clientX: number, clientY: number): Point | null;
  /** Hover position for the brush cursor; `null` when the pointer left the surface. */
  hover(clientX: number, clientY: number, over: boolean): void;
  command(cmd: Command): void;
  /**
   * Should this key event go to the editor? Omitted: every key does (the
   * board editor owns the keyboard while it runs). Windowed editors use it to
   * leave keys alone that were meant for the rest of Foundry.
   */
  ownsKey?(e: KeyboardEvent): boolean;
}

const UI_NATIVE_KEYS = new Set([
  "Enter",
  "NumpadEnter",
  "Space",
  "Tab",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
]);

const isEditable = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement &&
  (t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement);

/**
 * Captures pointer, wheel and keyboard input while an editing session runs.
 *
 * Listeners are registered on `window` in the capture phase, so they run
 * before PIXI's EventSystem and Foundry's KeyboardManager. Left button / pen /
 * touch presses on the drawing surface become strokes and never reach the
 * canvas (no token drag, no box select). Right/middle drags pass through so
 * Foundry's own panning keeps working; plain wheel zoom passes through, while
 * modified wheel (token rotation in Foundry) is captured for brush size.
 *
 * Nothing is registered until {@link attach} and everything is removed by
 * {@link detach}.
 */
export class InputController {
  readonly #editor: ScribbleEditor;
  readonly #host: InputHost;
  readonly #abort = new AbortController();
  #penSeen = false;
  #touches = new Set<number>();
  #captureTarget: Element | null = null;
  #attached = false;

  constructor(editor: ScribbleEditor, host: InputHost) {
    this.#editor = editor;
    this.#host = host;
  }

  attach(): void {
    if (this.#attached) return;
    this.#attached = true;
    const opts = { capture: true, signal: this.#abort.signal };
    window.addEventListener("pointerdown", this.#onDown, opts);
    window.addEventListener("pointermove", this.#onMove, opts);
    window.addEventListener("pointerup", this.#onUp, opts);
    window.addEventListener("pointercancel", this.#onCancel, opts);
    window.addEventListener("lostpointercapture", this.#onLostCapture, opts);
    window.addEventListener("wheel", this.#onWheel, { ...opts, passive: false });
    window.addEventListener("keydown", this.#onKeyDown, opts);
    window.addEventListener("keyup", this.#onKeyUp, opts);
    window.addEventListener("blur", this.#onBlur, { signal: this.#abort.signal });
    window.addEventListener("contextmenu", this.#onContextMenu, opts);
  }

  detach(): void {
    this.#editor.cancelStroke();
    this.#abort.abort();
    this.#attached = false;
    this.#touches.clear();
  }

  #sample(e: PointerEvent, p: Point): PressureSample {
    return { x: p.x, y: p.y, time: e.timeStamp, pressure: e.pressure, pointerType: e.pointerType };
  }

  readonly #onDown = (e: PointerEvent): void => {
    if (!this.#host.isDrawTarget(e.target)) return;
    if (e.pointerType === "pen") this.#penSeen = true;
    if (e.pointerType === "touch") {
      this.#touches.add(e.pointerId);
      // Palm rejection: once a pen was used, fingers are for navigation only.
      if (this.#penSeen) return;
      // A second finger means a pinch/pan gesture: drop the half-started stroke.
      if (this.#touches.size > 1) {
        this.#editor.cancelStroke();
        return;
      }
    }
    const penEraser = e.pointerType === "pen" && (e.button === 5 || (e.buttons & 32) !== 0);
    if (e.button !== 0 && !penEraser) return; // right/middle: let Foundry pan
    const p = this.#host.clientToPaper(e.clientX, e.clientY);
    if (!p) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const target = e.target as Element;
    try {
      target.setPointerCapture(e.pointerId);
      this.#captureTarget = target;
    } catch {
      this.#captureTarget = null;
    }
    const toolOverride: ToolId | undefined = penEraser ? "eraser" : undefined;
    this.#editor.beginStroke(e.pointerId, this.#sample(e, p), { line: e.shiftKey, toolOverride });
  };

  readonly #onMove = (e: PointerEvent): void => {
    const active = this.#editor.activePointer;
    if (active !== null && e.pointerId === active) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
      const list = events.length ? events : [e];
      const samples: PressureSample[] = [];
      for (const ev of list) {
        const p = this.#host.clientToPaper(ev.clientX, ev.clientY);
        if (p) samples.push(this.#sample(ev, p));
      }
      this.#editor.addSamples(samples, e.shiftKey);
      this.#host.hover(e.clientX, e.clientY, true);
      return;
    }
    const over = this.#host.isDrawTarget(e.target);
    this.#host.hover(e.clientX, e.clientY, over);
    // Hover over the surface without a pan button held: keep Foundry from
    // reacting (token hover borders, cursor changes) while drawing.
    if (over && (e.buttons & 6) === 0) e.stopImmediatePropagation();
  };

  readonly #onUp = (e: PointerEvent): void => {
    if (e.pointerType === "touch") this.#touches.delete(e.pointerId);
    if (this.#editor.activePointer !== e.pointerId) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const p = this.#host.clientToPaper(e.clientX, e.clientY);
    if (p) this.#editor.addSamples([this.#sample(e, p)], e.shiftKey);
    this.#editor.endStroke();
    this.#releaseCapture(e.pointerId);
  };

  readonly #onCancel = (e: PointerEvent): void => {
    if (e.pointerType === "touch") this.#touches.delete(e.pointerId);
    if (this.#editor.activePointer !== e.pointerId) return;
    e.stopImmediatePropagation();
    // A cancelled pointer (e.g. OS gesture) still keeps what was drawn so far.
    this.#editor.endStroke();
    this.#releaseCapture(e.pointerId);
  };

  readonly #onLostCapture = (e: PointerEvent): void => {
    if (this.#editor.activePointer === e.pointerId) this.#editor.endStroke();
  };

  #releaseCapture(pointerId: number): void {
    try {
      this.#captureTarget?.releasePointerCapture(pointerId);
    } catch {
      /* already released */
    }
    this.#captureTarget = null;
  }

  readonly #onWheel = (e: WheelEvent): void => {
    if (!this.#host.isDrawTarget(e.target)) return;
    // Foundry rotates controlled tokens on Shift/Ctrl+wheel; never let that
    // happen mid-edit. Alt+wheel (or Shift+wheel) resizes the brush instead.
    if (e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.altKey || e.shiftKey) {
        const delta = e.deltaY || e.deltaX;
        if (delta) this.#editor.stepSize(delta < 0 ? 1 : -1);
      }
    }
  };

  readonly #onKeyDown = (e: KeyboardEvent): void => {
    if (this.#host.ownsKey && !this.#host.ownsKey(e)) return;
    if (isEditable(e.target)) {
      if (e.code === "Escape") (e.target as HTMLElement).blur();
      return;
    }
    if (isPassThroughKey(e)) return;
    // Keyboard operation of our own controls (activation, roving focus) is
    // native; the UI root stops these keys from bubbling on to Foundry.
    // Escape inside our UI closes popovers / leaves the dock instead of finishing.
    if (e.target instanceof Element && e.target.closest("[data-ts-ui]") && (UI_NATIVE_KEYS.has(e.code) || e.code === "Escape")) {
      return;
    }
    const cmd = commandForKey(e);
    // Every other key is swallowed: core map shortcuts (delete, move, rotate,
    // copy/paste, tab-cycling…) would otherwise act on the token being drawn.
    e.stopImmediatePropagation();
    // Keep native browser behaviour for things like Ctrl+R / Ctrl+Shift+I.
    if (!cmd) return;
    e.preventDefault();
    if (e.repeat && (cmd.type === "done" || cmd.type === "tool" || cmd.type === "mirror" || cmd.type === "focus")) return;
    this.#host.command(cmd);
  };

  readonly #onKeyUp = (e: KeyboardEvent): void => {
    if (this.#host.ownsKey && !this.#host.ownsKey(e)) return;
    if (isEditable(e.target) || isPassThroughKey(e)) return;
    if (e.target instanceof Element && e.target.closest("[data-ts-ui]")) return;
    e.stopImmediatePropagation();
  };

  readonly #onBlur = (): void => {
    // Window lost focus mid-stroke (alt-tab): finish what we have.
    this.#editor.endStroke();
  };

  readonly #onContextMenu = (e: MouseEvent): void => {
    // Pen barrel buttons and long-press can raise context menus over the board.
    if (this.#host.isDrawTarget(e.target) && this.#editor.isDrawing) e.preventDefault();
  };
}
