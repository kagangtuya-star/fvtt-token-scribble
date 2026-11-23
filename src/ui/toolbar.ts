import { BRUSHES } from "../engine/brushes.ts";
import type { EditorSnapshot, ScribbleEditor } from "../editor/editor.ts";
import { SHORTCUTS } from "../editor/keymap.ts";
import type { Command } from "../editor/keymap.ts";
import { normalizeColor } from "../editor/tool-state.ts";
import { TOOL_IDS } from "../model/types.ts";
import type { ToolId } from "../model/types.ts";
import { h, icon, setAttr, setText } from "./dom.ts";

export type SaveStatus = "saved" | "dirty" | "saving" | "error" | "offline";

export interface MenuItem {
  id: string;
  label: string;
  icon: string;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Draw a divider above this item. */
  divider?: boolean;
}

export interface Peer {
  name: string;
  color: string;
}

export interface ToolbarHost {
  /** Localise `TOKEN_SCRIBBLE.<key>`. */
  t(key: string, data?: Record<string, string | number>): string;
  palette: readonly string[];
  /** Current screen pixels per paper unit (for the size preview). */
  screenPxPerUnit(): number;
  command(cmd: Command): void;
  done(): void;
  menu(): MenuItem[];
  initialPosition: { x: number; y: number } | null;
  savePosition(pos: { x: number; y: number } | null): void;
  /** Embed the dock in this element (a window) instead of floating it over the map. */
  mount?: HTMLElement;
  /** Stacking level for popovers of an embedded dock (above its window). */
  layer?(): number;
}

const TOOL_ICONS: Record<ToolId, string> = {
  pen: "fa-solid fa-pen-nib",
  marker: "fa-solid fa-highlighter",
  brush: "fa-solid fa-paintbrush",
  fill: "fa-solid fa-draw-polygon",
  eraser: "fa-solid fa-eraser",
};

const STATUS_ICONS: Record<SaveStatus, string> = {
  saved: "fa-solid fa-check",
  dirty: "fa-solid fa-circle",
  saving: "fa-solid fa-rotate",
  error: "fa-solid fa-triangle-exclamation",
  offline: "fa-solid fa-plug-circle-xmark",
};

const sliderToSize = (tool: ToolId, v: number): number => {
  // Logarithmic slider: fine control for thin lines, still reaches big brushes.
  const { minSize, maxSize } = BRUSHES[tool];
  return minSize * Math.pow(maxSize / minSize, v / 1000);
};

const sizeToSlider = (tool: ToolId, size: number): number => {
  const { minSize, maxSize } = BRUSHES[tool];
  return Math.round((Math.log(size / minSize) / Math.log(maxSize / minSize)) * 1000);
};

/**
 * The editing dock. A compact, draggable capsule that floats above the map.
 *
 * - The active tool expands to show its name, so the current tool is never
 *   communicated by colour alone; colour swatches carry a check mark.
 * - Every control is a real <button>/<input> with an accessible name and a
 *   shortcut hint; arrow keys move focus along the dock.
 * - Brush details (opacity, pressure) live in a popover on the active tool to
 *   keep the dock short.
 */
export class Toolbar {
  readonly root: HTMLElement;
  readonly #editor: ScribbleEditor;
  readonly #host: ToolbarHost;
  readonly #abort = new AbortController();
  readonly #toolButtons = new Map<ToolId, HTMLButtonElement>();
  readonly #swatches: HTMLButtonElement[] = [];
  #recentWrap!: HTMLElement;
  #recentKey = "";
  #sizeInput!: HTMLInputElement;
  #sizeOut!: HTMLOutputElement;
  #sizeDot!: HTMLElement;
  #customInput!: HTMLInputElement;
  #customSwatch!: HTMLElement;
  #mirrorBtn!: HTMLButtonElement;
  #focusBtn!: HTMLButtonElement;
  #undoBtn!: HTMLButtonElement;
  #redoBtn!: HTMLButtonElement;
  #statusEl!: HTMLElement;
  #statusText!: HTMLElement;
  #statusIcon!: HTMLElement;
  #inkFill!: HTMLElement;
  #inkEl!: HTMLElement;
  #peersEl!: HTMLElement;
  #titleEl!: HTMLElement;
  #popover: HTMLElement | null = null;
  #popoverAnchor: HTMLElement | null = null;
  #lastSnap: EditorSnapshot | null = null;

  constructor(editor: ScribbleEditor, host: ToolbarHost, title: string) {
    this.#editor = editor;
    this.#host = host;
    this.root = this.#build(title);
    if (host.mount) {
      this.root.classList.add("ts-dock-embedded", "ts-in");
      host.mount.append(this.root);
    } else {
      document.body.append(this.root);
      this.#placeInitially();
    }
    this.update(editor.snapshot());
    const offChange = editor.on((e) => {
      if (e.type === "change") this.update(editor.snapshot());
    });
    this.#abort.signal.addEventListener("abort", offChange);
    // Close popovers on outside clicks.
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!this.#popover) return;
        const t = e.target as Node;
        if (!this.#popover.contains(t) && !this.#popoverAnchor?.contains(t)) this.closePopover();
      },
      { capture: true, signal: this.#abort.signal },
    );
    window.addEventListener("resize", () => this.#clampIntoView(), { signal: this.#abort.signal });
    requestAnimationFrame(() => this.root.classList.add("ts-in"));
  }

  #t(key: string, data?: Record<string, string | number>): string {
    return this.#host.t(key, data);
  }

  #tip(label: string, shortcut?: string): string {
    return shortcut ? `${label} <kbd>${shortcut}</kbd>` : label;
  }

  #button(cls: string, iconCls: string, label: string, shortcut: string | undefined, onClick: () => void): HTMLButtonElement {
    const btn = h(
      "button",
      { type: "button", class: `ts-btn ${cls}`, "aria-label": label, "data-tooltip-html": this.#tip(label, shortcut) },
      icon(iconCls),
    );
    if (shortcut) btn.setAttribute("aria-keyshortcuts", shortcut.replace(/ /g, ""));
    btn.addEventListener("click", onClick, { signal: this.#abort.signal });
    return btn;
  }

  #build(title: string): HTMLElement {
    const sig = { signal: this.#abort.signal };
    const root = h("section", {
      class: "ts-dock",
      "data-ts-ui": true,
      role: "toolbar",
      "aria-label": this.#t("Toolbar.Label", { name: title }),
    });

    // Grip + title
    const grip = h(
      "div",
      { class: "ts-grip", "data-tooltip-html": this.#t("Toolbar.Drag"), "aria-hidden": "true" },
      icon("fa-solid fa-grip-vertical"),
    );
    grip.addEventListener("pointerdown", (e) => this.#startDrag(e), sig);
    grip.addEventListener("dblclick", () => this.#resetPosition(), sig);
    this.#titleEl = h("span", { class: "ts-title" }, title);
    this.#peersEl = h("span", { class: "ts-peers", "aria-live": "polite" });
    const head = h("div", { class: "ts-head" }, grip, this.#titleEl, this.#peersEl);

    // Tools
    const tools = h("div", { class: "ts-group ts-tools", role: "radiogroup", "aria-label": this.#t("Toolbar.Tools") });
    for (const tool of TOOL_IDS) {
      const label = this.#t(`Tool.${tool}`);
      const btn = h(
        "button",
        {
          type: "button",
          role: "radio",
          class: "ts-btn ts-tool",
          "data-tool": tool,
          "aria-label": label,
          "aria-keyshortcuts": SHORTCUTS[tool],
          "data-tooltip-html": this.#tip(`${label} — ${this.#t(`ToolHint.${tool}`)}`, SHORTCUTS[tool]),
        },
        icon(TOOL_ICONS[tool]),
        h("span", { class: "ts-tool-label" }, label),
      );
      btn.addEventListener(
        "click",
        () => {
          if (this.#editor.tools.tool === tool) this.#toggleBrushPopover(btn);
          else {
            this.closePopover();
            this.#editor.setTool(tool);
          }
        },
        sig,
      );
      this.#toolButtons.set(tool, btn);
      tools.append(btn);
    }

    // Size
    this.#sizeDot = h("span", { class: "ts-size-dot", "aria-hidden": "true" });
    this.#sizeInput = h("input", {
      type: "range",
      min: 0,
      max: 1000,
      step: 1,
      class: "ts-range",
      "aria-label": this.#t("Toolbar.Size"),
      "aria-keyshortcuts": "[ ]",
    });
    this.#sizeInput.addEventListener(
      "input",
      () => this.#editor.setSize(sliderToSize(this.#editor.tools.tool, Number(this.#sizeInput.value))),
      sig,
    );
    this.#sizeOut = h("output", { class: "ts-size-out", "aria-hidden": "true" });
    const size = h(
      "div",
      { class: "ts-size", "data-tooltip-html": this.#tip(this.#t("Toolbar.Size"), `${SHORTCUTS.sizeDown} ${SHORTCUTS.sizeUp}`) },
      h("span", { class: "ts-size-preview" }, this.#sizeDot),
      this.#sizeInput,
      this.#sizeOut,
    );

    // Colours
    const colors = h("div", { class: "ts-group ts-colors", role: "radiogroup", "aria-label": this.#t("Toolbar.Colors") });
    this.#host.palette.forEach((c, i) => {
      const key = i === 9 ? "0" : String(i + 1);
      colors.append(this.#swatch(c, key));
    });
    this.#recentWrap = h("span", { class: "ts-recent" });
    colors.append(this.#recentWrap);
    this.#customInput = h("input", {
      type: "color",
      class: "ts-color-input",
      "aria-label": this.#t("Toolbar.CustomColor"),
      tabindex: -1,
    });
    this.#customInput.addEventListener(
      "input",
      () => {
        const c = normalizeColor(this.#customInput.value);
        if (c) this.#editor.setColor(c);
      },
      sig,
    );
    this.#customSwatch = h(
      "button",
      {
        type: "button",
        class: "ts-swatch ts-custom",
        "aria-label": this.#t("Toolbar.CustomColor"),
        "data-tooltip-html": this.#t("Toolbar.CustomColor"),
      },
      icon("fa-solid fa-eye-dropper"),
    );
    this.#customSwatch.addEventListener(
      "click",
      () => {
        this.#customInput.value = this.#editor.tools.color;
        this.#customInput.click();
      },
      sig,
    );
    colors.append(h("span", { class: "ts-custom-wrap" }, this.#customSwatch, this.#customInput));

    // Toggles
    this.#mirrorBtn = this.#button("ts-toggle", "fa-solid fa-arrows-left-right-to-line", this.#t("Toolbar.Mirror"), SHORTCUTS.mirror, () =>
      this.#host.command({ type: "mirror" }),
    );
    this.#focusBtn = this.#button("ts-toggle", "fa-solid fa-magnifying-glass-plus", this.#t("Toolbar.Focus"), SHORTCUTS.focus, () =>
      this.#host.command({ type: "focus" }),
    );
    this.#mirrorBtn.setAttribute("aria-pressed", "false");
    this.#focusBtn.setAttribute("aria-pressed", "false");

    // History
    this.#undoBtn = this.#button("", "fa-solid fa-rotate-left", this.#t("Toolbar.Undo"), SHORTCUTS.undo, () => this.#host.command({ type: "undo" }));
    this.#redoBtn = this.#button("", "fa-solid fa-rotate-right", this.#t("Toolbar.Redo"), SHORTCUTS.redo, () => this.#host.command({ type: "redo" }));

    // Status: storage gauge + save state
    this.#inkFill = h("span", { class: "ts-ink-fill" });
    this.#inkEl = h("span", { class: "ts-ink", role: "meter", "aria-valuemin": 0, "aria-valuemax": 100 }, this.#inkFill);
    this.#statusIcon = icon(STATUS_ICONS.saved);
    this.#statusText = h("span", { class: "ts-status-text" });
    this.#statusEl = h("span", { class: "ts-status", role: "status", "aria-live": "polite" }, this.#statusIcon, this.#statusText);

    const menuBtn = this.#button("ts-menu-btn", "fa-solid fa-ellipsis", this.#t("Toolbar.More"), undefined, () => this.#toggleMenu(menuBtn));
    menuBtn.setAttribute("aria-haspopup", "menu");
    menuBtn.setAttribute("aria-expanded", "false");
    const done = h(
      "button",
      {
        type: "button",
        class: "ts-btn ts-done",
        "data-tooltip-html": this.#tip(this.#t("Toolbar.DoneHint"), SHORTCUTS.done),
        "aria-keyshortcuts": "Enter Escape",
      },
      icon("fa-solid fa-check"),
      h("span", {}, this.#t("Toolbar.Done")),
    );
    done.addEventListener("click", () => this.#host.done(), sig);

    const sep = () => h("span", { class: "ts-sep", role: "separator", "aria-orientation": "vertical" });
    const body = h(
      "div",
      { class: "ts-body" },
      tools,
      sep(),
      size,
      sep(),
      colors,
      sep(),
      h("div", { class: "ts-group" }, this.#mirrorBtn, this.#focusBtn),
      sep(),
      h("div", { class: "ts-group" }, this.#undoBtn, this.#redoBtn),
      sep(),
      h("div", { class: "ts-group ts-end" }, this.#inkEl, this.#statusEl, menuBtn, done),
    );
    root.append(head, body);

    // Keyboard: arrows move focus along the dock; nothing leaks to Foundry.
    root.addEventListener(
      "keydown",
      (e) => {
        if (e.code === "ArrowLeft" || e.code === "ArrowRight" || e.code === "Home" || e.code === "End") {
          if (e.target instanceof HTMLInputElement && e.target.type === "range") {
            e.stopPropagation();
            return;
          }
          const items = [...root.querySelectorAll<HTMLElement>(".ts-body button:not([disabled]), .ts-body input[type=range]")].filter(
            (el) => el.offsetParent !== null,
          );
          const i = items.indexOf(document.activeElement as HTMLElement);
          let next = i;
          if (e.code === "ArrowLeft") next = Math.max(0, i - 1);
          if (e.code === "ArrowRight") next = Math.min(items.length - 1, i + 1);
          if (e.code === "Home") next = 0;
          if (e.code === "End") next = items.length - 1;
          items[next]?.focus();
          e.preventDefault();
        }
        // Escape leaves the dock: focus returns to the map, the next Escape finishes.
        if (e.code === "Escape" && !this.closePopover()) (document.activeElement as HTMLElement | null)?.blur();
        e.stopPropagation();
      },
      sig,
    );
    root.addEventListener("keyup", (e) => e.stopPropagation(), sig);
    return root;
  }

  #swatch(color: string, key?: string): HTMLButtonElement {
    const name = this.#t("Toolbar.ColorName", { color: color.toUpperCase() });
    const btn = h(
      "button",
      {
        type: "button",
        role: "radio",
        class: "ts-swatch",
        "data-color": color,
        style: `--swatch:${color}`,
        "aria-label": name,
        "data-tooltip-html": key ? this.#tip(name, key) : name,
      },
      icon("fa-solid fa-check ts-swatch-check"),
    );
    btn.addEventListener("click", () => this.#editor.setColor(color), { signal: this.#abort.signal });
    this.#swatches.push(btn);
    return btn;
  }

  /* -------------------------------------------- */
  /*  State                                       */
  /* -------------------------------------------- */

  update(s: EditorSnapshot): void {
    this.#lastSnap = s;
    for (const [tool, btn] of this.#toolButtons) {
      const active = s.tool === tool;
      setAttr(btn, "aria-checked", String(active));
      btn.classList.toggle("ts-active", active);
      btn.tabIndex = active ? 0 : -1;
    }
    this.root.dataset.tool = s.tool;
    // Size
    this.#sizeInput.value = String(sizeToSlider(s.tool, s.size));
    setText(this.#sizeOut, String(Math.round(s.size)));
    setAttr(this.#sizeInput, "aria-valuetext", String(Math.round(s.size)));
    this.#refreshSizeDot();
    // Colour
    const recentKey = s.recent.join(",");
    if (recentKey !== this.#recentKey) {
      this.#recentKey = recentKey;
      for (const old of this.#swatches.filter((b) => this.#recentWrap.contains(b))) {
        this.#swatches.splice(this.#swatches.indexOf(old), 1);
      }
      this.#recentWrap.replaceChildren(...s.recent.map((c) => this.#swatch(c)));
    }
    const erasing = s.tool === "eraser";
    for (const sw of this.#swatches) {
      const on = !erasing && sw.dataset.color === s.color;
      setAttr(sw, "aria-checked", String(on));
      sw.classList.toggle("ts-active", on);
    }
    this.#customSwatch.style.setProperty("--swatch", s.color);
    this.root.style.setProperty("--ts-ink-color", s.color);
    // Toggles & history
    setAttr(this.#mirrorBtn, "aria-pressed", String(s.mirror));
    this.#mirrorBtn.classList.toggle("ts-active", s.mirror);
    this.#undoBtn.disabled = !s.canUndo;
    this.#redoBtn.disabled = !s.canRedo;
    // Storage gauge
    const pct = Math.min(100, Math.round((s.usageBytes / s.maxBytes) * 100));
    this.#inkFill.style.width = `${pct}%`;
    this.#inkEl.classList.toggle("ts-warn", pct >= 80);
    setAttr(this.#inkEl, "aria-valuenow", String(pct));
    const tip = this.#t("Toolbar.Storage", { used: Math.ceil(s.usageBytes / 1024), max: Math.round(s.maxBytes / 1024), pct });
    setAttr(this.#inkEl, "aria-label", tip);
    setAttr(this.#inkEl, "data-tooltip-html", tip);
    this.root.classList.toggle("ts-drawing", s.drawing);
    if (this.#popover?.dataset.kind === "brush") this.#syncBrushPopover();
  }

  #refreshSizeDot(): void {
    const s = this.#lastSnap;
    if (!s) return;
    const px = Math.max(2, Math.min(26, s.size * this.#host.screenPxPerUnit()));
    this.#sizeDot.style.width = this.#sizeDot.style.height = `${px.toFixed(1)}px`;
  }

  /** Call when the map zoom changes so the size preview stays true to scale. */
  refreshScale(): void {
    this.#refreshSizeDot();
  }

  setTitle(title: string): void {
    setText(this.#titleEl, title);
  }

  setStatus(status: SaveStatus, detail?: string): void {
    this.#statusEl.dataset.status = status;
    this.#statusIcon.className = `${STATUS_ICONS[status]} ts-icon`;
    const text = this.#t(`Status.${status}`);
    setText(this.#statusText, text);
    setAttr(this.#statusEl, "data-tooltip-text", detail ?? text);
  }

  setPeers(peers: readonly Peer[]): void {
    this.#peersEl.replaceChildren(
      ...peers.map((p) =>
        h(
          "span",
          {
            class: "ts-peer",
            style: `--peer:${p.color}`,
            "data-tooltip-text": this.#t("Toolbar.PeerEditing", { name: p.name }),
            "aria-label": this.#t("Toolbar.PeerEditing", { name: p.name }),
          },
          p.name.slice(0, 1).toUpperCase(),
        ),
      ),
    );
  }

  setFocusActive(active: boolean): void {
    setAttr(this.#focusBtn, "aria-pressed", String(active));
    this.#focusBtn.classList.toggle("ts-active", active);
  }

  /* -------------------------------------------- */
  /*  Popovers                                    */
  /* -------------------------------------------- */

  /** Close the open popover, if any. Returns whether one was open. */
  closePopover(): boolean {
    if (!this.#popover) return false;
    this.#popover.remove();
    this.#popoverAnchor?.setAttribute("aria-expanded", "false");
    this.#popover = null;
    this.#popoverAnchor = null;
    return true;
  }

  #openPopover(anchor: HTMLElement, kind: string, content: HTMLElement, role = "dialog"): HTMLElement {
    this.closePopover();
    const pop = h("div", { class: `ts-popover ts-popover-${kind}`, "data-ts-ui": true, "data-kind": kind, role });
    pop.append(content);
    if (this.#host.layer) pop.style.setProperty("--ts-z", String(this.#host.layer()));
    pop.addEventListener("keydown", (e) => {
      if (e.code === "Escape") {
        e.stopPropagation();
        this.closePopover();
        anchor.focus();
      }
      e.stopPropagation();
    });
    document.body.append(pop);
    this.#popover = pop;
    this.#popoverAnchor = anchor;
    anchor.setAttribute("aria-expanded", "true");
    this.#positionPopover(pop, anchor);
    return pop;
  }

  #positionPopover(pop: HTMLElement, anchor: HTMLElement): void {
    const a = anchor.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    const dock = this.root.getBoundingClientRect();
    const above = dock.top > p.height + 16;
    let left = a.left + a.width / 2 - p.width / 2;
    left = Math.max(8, Math.min(window.innerWidth - p.width - 8, left));
    const top = above ? dock.top - p.height - 8 : dock.bottom + 8;
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
    pop.classList.toggle("ts-below", !above);
  }

  #toggleBrushPopover(anchor: HTMLElement): void {
    if (this.#popover?.dataset.kind === "brush") {
      this.closePopover();
      return;
    }
    const content = h("div", { class: "ts-brush-panel" });
    const pop = this.#openPopover(anchor, "brush", content);
    this.#syncBrushPopover();
    pop.querySelector<HTMLElement>("input")?.focus();
  }

  #syncBrushPopover(): void {
    const pop = this.#popover;
    const s = this.#lastSnap;
    if (!pop || !s) return;
    const panel = pop.querySelector(".ts-brush-panel")!;
    const preset = BRUSHES[s.tool];
    const key = `${s.tool}`;
    if (panel.getAttribute("data-for") !== key) {
      panel.setAttribute("data-for", key);
      const rows: HTMLElement[] = [h("div", { class: "ts-panel-title" }, this.#t(`Tool.${s.tool}`))];
      if (!preset.erase) {
        rows.push(this.#rangeRow("opacity", this.#t("Toolbar.Opacity"), 5, 100, (v) => this.#editor.setOpacity(v / 100)));
      }
      if (preset.usesPressure) {
        rows.push(this.#rangeRow("thinning", this.#t("Toolbar.Pressure"), 0, 95, (v) => this.#editor.setThinning(v / 100)));
        rows.push(h("p", { class: "ts-panel-hint" }, this.#t(s.realPressure ? "Toolbar.PressurePen" : "Toolbar.PressureMouse")));
      }
      if (preset.fill) rows.push(h("p", { class: "ts-panel-hint" }, this.#t("ToolHint.fillLong")));
      if (preset.erase) rows.push(h("p", { class: "ts-panel-hint" }, this.#t("ToolHint.eraserLong")));
      panel.replaceChildren(...rows);
      // The panel changed size (and the tool may have changed via keyboard): re-anchor it.
      const anchor = this.#toolButtons.get(s.tool);
      if (anchor) {
        this.#popoverAnchor?.setAttribute("aria-expanded", "false");
        this.#popoverAnchor = anchor;
        anchor.setAttribute("aria-expanded", "true");
        this.#positionPopover(pop, anchor);
      }
    }
    const setRange = (name: string, value: number) => {
      const input = panel.querySelector<HTMLInputElement>(`input[name=${name}]`);
      if (!input) return;
      if (document.activeElement !== input) input.value = String(value);
      const out = input.parentElement?.querySelector("output");
      if (out) setText(out, `${value}%`);
    };
    setRange("opacity", Math.round(s.opacity * 100));
    setRange("thinning", Math.round(s.thinning * 100));
  }

  #rangeRow(name: string, label: string, min: number, max: number, onInput: (v: number) => void): HTMLElement {
    const id = `ts-${name}-${Math.random().toString(36).slice(2, 7)}`;
    const input = h("input", { type: "range", class: "ts-range", id, name, min, max, step: 1 });
    input.addEventListener("input", () => onInput(Number(input.value)));
    return h("div", { class: "ts-row" }, h("label", { for: id }, label), input, h("output", { for: id }));
  }

  #toggleMenu(anchor: HTMLElement): void {
    if (this.#popover?.dataset.kind === "menu") {
      this.closePopover();
      return;
    }
    const list = h("div", { class: "ts-menu" });
    for (const item of this.#host.menu()) {
      if (item.divider) list.append(h("hr", { role: "separator" }));
      const btn = h(
        "button",
        { type: "button", role: "menuitem", class: `ts-menu-item${item.danger ? " ts-danger" : ""}`, "data-id": item.id },
        icon(item.icon),
        h("span", {}, item.label),
      );
      btn.disabled = item.disabled === true;
      btn.addEventListener("click", () => {
        this.closePopover();
        item.run();
      });
      list.append(btn);
    }
    const pop = this.#openPopover(anchor, "menu", list, "menu");
    pop.addEventListener("keydown", (e) => {
      if (e.code !== "ArrowDown" && e.code !== "ArrowUp") return;
      const items = [...pop.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(i + (e.code === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      e.preventDefault();
    });
    pop.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  }

  /** Keyboard help, shown from the menu or with `?`. */
  showHelp(): void {
    const rows: [string, string][] = [
      [this.#t("Tool.pen"), SHORTCUTS.pen],
      [this.#t("Tool.marker"), SHORTCUTS.marker],
      [this.#t("Tool.brush"), SHORTCUTS.brush],
      [this.#t("Tool.fill"), SHORTCUTS.fill],
      [this.#t("Tool.eraser"), SHORTCUTS.eraser],
      [this.#t("Help.Line"), this.#t("Help.LineKey")],
      [this.#t("Toolbar.Size"), `${SHORTCUTS.sizeDown} ${SHORTCUTS.sizeUp} / Alt+${this.#t("Help.Wheel")}`],
      [this.#t("Toolbar.Colors"), SHORTCUTS.colors],
      [this.#t("Toolbar.Mirror"), SHORTCUTS.mirror],
      [this.#t("Toolbar.Focus"), SHORTCUTS.focus],
      [this.#t("Toolbar.Undo"), SHORTCUTS.undo],
      [this.#t("Toolbar.Redo"), `${SHORTCUTS.redo} / Ctrl+Y`],
      [this.#t("Help.Pan"), this.#t("Help.PanKey")],
      [this.#t("Toolbar.Done"), SHORTCUTS.done],
    ];
    const table = h(
      "dl",
      { class: "ts-help" },
      ...rows.flatMap(([label, key]) => [h("dt", {}, label), h("dd", {}, h("kbd", {}, key))]),
    );
    const content = h("div", {}, h("div", { class: "ts-panel-title" }, this.#t("Help.Title")), table);
    const anchor = this.root.querySelector<HTMLElement>(".ts-menu-btn")!;
    this.#openPopover(anchor, "help", content);
  }

  /* -------------------------------------------- */
  /*  Positioning                                 */
  /* -------------------------------------------- */

  #placeInitially(): void {
    const pos = this.#host.initialPosition;
    if (pos) {
      this.root.style.left = `${pos.x}px`;
      this.root.style.top = `${pos.y}px`;
      this.root.classList.add("ts-placed");
      requestAnimationFrame(() => this.#clampIntoView());
    }
  }

  #resetPosition(): void {
    this.root.classList.remove("ts-placed");
    this.root.style.left = "";
    this.root.style.top = "";
    this.#host.savePosition(null);
  }

  #clampIntoView(): void {
    if (!this.root.classList.contains("ts-placed")) return;
    const r = this.root.getBoundingClientRect();
    const x = Math.max(4, Math.min(window.innerWidth - r.width - 4, r.left));
    const y = Math.max(4, Math.min(window.innerHeight - r.height - 4, r.top));
    this.root.style.left = `${Math.round(x)}px`;
    this.root.style.top = `${Math.round(y)}px`;
  }

  #startDrag(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = this.root.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const grip = e.currentTarget as HTMLElement;
    grip.setPointerCapture(e.pointerId);
    this.root.classList.add("ts-placed", "ts-dragging");
    this.closePopover();
    const move = (ev: PointerEvent) => {
      const x = Math.max(4, Math.min(window.innerWidth - r.width - 4, ev.clientX - dx));
      const y = Math.max(4, Math.min(window.innerHeight - r.height - 4, ev.clientY - dy));
      this.root.style.left = `${Math.round(x)}px`;
      this.root.style.top = `${Math.round(y)}px`;
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      this.root.classList.remove("ts-dragging");
      const nr = this.root.getBoundingClientRect();
      this.#host.savePosition({ x: Math.round(nr.left), y: Math.round(nr.top) });
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  }

  destroy(): void {
    this.closePopover();
    this.#abort.abort();
    this.root.remove();
  }
}
