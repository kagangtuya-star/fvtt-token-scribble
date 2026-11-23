import { h } from "./dom.ts";

/**
 * Brush outline that follows the pointer over the drawing surface.
 * It is a single fixed-position element moved with transforms (no layout).
 */
export class BrushCursor {
  readonly #el: HTMLElement;
  #visible = false;

  constructor() {
    this.#el = h("div", { class: "ts-cursor", "aria-hidden": "true" }, h("span", { class: "ts-cursor-dot" }));
    document.body.append(this.#el);
  }

  update(clientX: number, clientY: number, diameterPx: number, mode: "ink" | "erase" | "fill", color: string): void {
    const d = Math.max(4, diameterPx);
    const el = this.#el;
    el.style.width = el.style.height = `${d.toFixed(1)}px`;
    el.style.transform = `translate(${(clientX - d / 2).toFixed(1)}px, ${(clientY - d / 2).toFixed(1)}px)`;
    el.dataset.mode = mode;
    el.style.setProperty("--ts-cursor-color", color);
    if (!this.#visible) {
      el.classList.add("ts-visible");
      this.#visible = true;
    }
  }

  /** Stack above a window (`z` is that window's z-index). */
  setLayer(z: number): void {
    this.#el.style.setProperty("--ts-z", String(z + 2));
  }

  hide(): void {
    if (!this.#visible) return;
    this.#el.classList.remove("ts-visible");
    this.#visible = false;
  }

  destroy(): void {
    this.#el.remove();
  }
}
