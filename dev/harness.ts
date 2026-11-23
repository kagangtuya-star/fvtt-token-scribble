/**
 * Browser harness for the editor, toolbar and input layers without Foundry.
 *
 * It draws a fake battle map on a <canvas id="board"> with one "token" in the
 * middle, and wires the real ScribbleEditor / Toolbar / InputController to it.
 * Plain wheel zooms and right-drag pans, like Foundry. The drawing is persisted
 * through the real serializer into localStorage, so reloads exercise decoding.
 *
 * Build with `npm run harness` and serve `dist-dev/` with any static server.
 */
import { ScribbleEditor } from "../src/editor/editor.ts";
import { InputController } from "../src/editor/input.ts";
import type { Command } from "../src/editor/keymap.ts";
import { defaultToolState, sanitizeToolState } from "../src/editor/tool-state.ts";
import { DEFAULT_PALETTE, BRUSHES } from "../src/engine/brushes.ts";
import { freehandOutliner } from "../src/engine/freehand.ts";
import type { Raster } from "../src/engine/raster.ts";
import { drawingToSvg } from "../src/engine/svg-export.ts";
import { paperRectIn } from "../src/model/fit.ts";
import { decodeDrawing, encodeDrawing, storedSize } from "../src/model/serialize.ts";
import { randomId } from "../src/model/ops.ts";
import type { Op, Paper } from "../src/model/types.ts";
import { BrushCursor } from "../src/ui/cursor.ts";
import { Toolbar } from "../src/ui/toolbar.ts";
import type { MenuItem } from "../src/ui/toolbar.ts";

const STORE_KEY = "token-scribble.harness.drawing";
const TOOLS_KEY = "token-scribble.harness.tools";
const TOKEN_WORLD = 300; // token size in "world" units
const PAPER: Paper = { w: 1000, h: 1000 };
const MAX_BYTES = 384 * 1024;

const board = document.getElementById("board") as HTMLCanvasElement;
const ctx = board.getContext("2d")!;
const log = document.getElementById("h-log")!;
const params = new URLSearchParams(location.search);

const view = { x: 0, y: 0, zoom: Number(params.get("zoom")) || 1.4 };
let strings: Record<string, string> = {};
let editor: ScribbleEditor | null = null;
let toolbar: Toolbar | null = null;
let input: InputController | null = null;
let cursor: BrushCursor | null = null;
let lastSaved: Op[] = [];
let standalone: Raster | null = null;

/* ---------------- i18n ---------------- */

function flatten(obj: Record<string, unknown>, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v as Record<string, unknown>, key, out);
    else out[key] = String(v);
  }
  return out;
}

async function loadLang(lang: string): Promise<void> {
  const res = await fetch(`lang/${lang}.json`);
  strings = flatten((await res.json()) as Record<string, unknown>);
  document.documentElement.lang = lang;
}

function t(key: string, data: Record<string, string | number> = {}): string {
  const s = strings[`TOKEN_SCRIBBLE.${key}`] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k: string) => (k in data ? String(data[k]) : `{${k}}`));
}

/* ---------------- view ---------------- */

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  board.width = Math.round(innerWidth * dpr);
  board.height = Math.round(innerHeight * dpr);
}

/** Screen rectangle of the token frame. */
function tokenRect(): { x: number; y: number; size: number } {
  const size = TOKEN_WORLD * view.zoom;
  return { x: innerWidth / 2 + (-view.x - TOKEN_WORLD / 2) * view.zoom, y: innerHeight / 2 + (-view.y - TOKEN_WORLD / 2) * view.zoom, size };
}

function render(): void {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#3b4a3a";
  ctx.fillRect(0, 0, innerWidth, innerHeight);
  // Grid like a battle map.
  const cell = 100 * view.zoom;
  const ox = (innerWidth / 2 - view.x * view.zoom) % cell;
  const oy = (innerHeight / 2 - view.y * view.zoom) % cell;
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = ox; x < innerWidth; x += cell) ctx.moveTo(x, 0), ctx.lineTo(x, innerHeight);
  for (let y = oy; y < innerHeight; y += cell) ctx.moveTo(0, y), ctx.lineTo(innerWidth, y);
  ctx.stroke();
  const r = tokenRect();
  ctx.strokeStyle = editor ? "rgba(240,168,74,0.9)" : "rgba(255,255,255,0.35)";
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(r.x, r.y, r.size, r.size);
  ctx.setLineDash([]);
  const raster = editor?.raster ?? standalone;
  if (raster) {
    // The raster covers the paper plus any out-of-frame ink.
    const rect = paperRectIn(PAPER, r.size, r.size);
    const e = raster.extent;
    ctx.drawImage(raster.display as CanvasImageSource, r.x + rect.x + e.x * rect.scale, r.y + rect.y + e.y * rect.scale, e.w * rect.scale, e.h * rect.scale);
  }
  requestAnimationFrame(render);
}


/* ---------------- persistence ---------------- */

function loadOps(): Op[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const res = decodeDrawing(raw ? JSON.parse(raw) : undefined);
    if (res.ok) return res.state.ops.slice();
    if (res.reason !== "missing") console.warn("harness: stored drawing unreadable", res);
  } catch (err) {
    console.warn("harness: could not read storage", err);
  }
  return [];
}

function saveOps(ops: readonly Op[]): number {
  const stored = encodeDrawing(PAPER, ops, { rev: randomId(), parent: null, seq: 0, by: "harness", at: Date.now() });
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(stored));
  } catch (err) {
    console.warn("harness: could not write storage", err);
  }
  lastSaved = ops.slice();
  return storedSize(stored);
}

function report(extra = ""): void {
  const s = editor?.snapshot();
  const ops = editor?.doc.ops ?? lastSaved;
  log.textContent =
    `ops ${ops.length} · ${(saveSizeOf(ops) / 1024).toFixed(1)} KB` +
    (s ? ` · ${s.tool} ${s.size.toFixed(1)} ${s.color}${s.realPressure ? " · pen" : ""}` : " · not editing") +
    (extra ? `\n${extra}` : "");
}

const saveSizeOf = (ops: readonly Op[]) =>
  storedSize(encodeDrawing(PAPER, ops, { rev: "0000000000", parent: null, seq: 0, by: "harness", at: 0 }));

/* ---------------- editing ---------------- */

function clientToPaper(cx: number, cy: number) {
  const r = tokenRect();
  const rect = paperRectIn(PAPER, r.size, r.size);
  return { x: (cx - r.x - rect.x) / rect.scale, y: (cy - r.y - rect.y) / rect.scale };
}

function screenPxPerUnit(): number {
  return tokenRect().size / PAPER.w;
}

function command(cmd: Command): void {
  const ed = editor;
  if (!ed) return;
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
      view.x = 0;
      view.y = 0;
      view.zoom = Math.min(innerWidth, innerHeight) * 0.6 / TOKEN_WORLD;
      toolbar?.setFocusActive(true);
      toolbar?.refreshScale();
      break;
    case "help":
      toolbar?.showHelp();
      break;
    case "done":
      if (!toolbar?.closePopover()) stopEditing();
      break;
  }
}

function menu(): MenuItem[] {
  const ed = editor!;
  return [
    {
      id: "svg",
      label: t("Menu.ExportSvg"),
      icon: "fa-solid fa-bezier-curve",
      run: () => {
        const svg = drawingToSvg(PAPER, ed.doc.ops, freehandOutliner);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
        a.download = "scribble.svg";
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      },
    },
    { id: "help", label: t("Menu.Help"), icon: "fa-solid fa-keyboard", run: () => toolbar?.showHelp(), divider: true },
    {
      id: "clear",
      label: t("Menu.Clear"),
      icon: "fa-solid fa-trash",
      danger: true,
      divider: true,
      disabled: ed.snapshot().empty,
      run: () => ed.clear(),
    },
  ];
}

function loadTools() {
  try {
    return sanitizeToolState(JSON.parse(localStorage.getItem(TOOLS_KEY) ?? "null"));
  } catch {
    return defaultToolState();
  }
}

function startEditing(): void {
  if (editor) return;
  const ops = loadOps();
  editor = new ScribbleEditor({
    paper: PAPER,
    ops,
    outliner: freehandOutliner,
    rasterPx: Math.min(2048, Math.round(tokenRect().size * (devicePixelRatio || 1))),
    tools: loadTools(),
    pressureMode: (params.get("pressure") as "auto" | "simulate" | "off") ?? "auto",
    maxBytes: MAX_BYTES,
    measure: saveSizeOf,
    placeholder: true,
  });
  const ed = editor;
  cursor = new BrushCursor();
  toolbar = new Toolbar(
    ed,
    {
      t,
      palette: DEFAULT_PALETTE,
      screenPxPerUnit,
      command,
      done: stopEditing,
      menu,
      initialPosition: null,
      savePosition: () => {},
    },
    "Goblin scout",
  );
  input = new InputController(ed, {
    isDrawTarget: (target) => target === board,
    clientToPaper,
    hover: (x, y, over) => {
      if (!over) return cursor?.hide();
      const s = ed.snapshot();
      const mode = BRUSHES[s.tool].erase ? "erase" : BRUSHES[s.tool].fill ? "fill" : "ink";
      cursor?.update(x, y, Math.max(4, s.size * screenPxPerUnit()), mode, s.color);
    },
    command,
  });
  input.attach();
  board.classList.add("ts-board-drawing");
  let timer: ReturnType<typeof setTimeout> | null = null;
  ed.on((e) => {
    if (e.type === "ops") {
      toolbar?.setStatus("dirty");
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        toolbar?.setStatus("saving");
        const bytes = saveOps(ed.doc.ops);
        setTimeout(() => toolbar?.setStatus("saved"), 250);
        report(`saved ${bytes} B`);
      }, 800);
    }
    if (e.type === "budget") report("budget reached");
    report();
  });
  toolbar.setStatus("saved");
  report();
}

function stopEditing(): void {
  if (!editor) return;
  editor.endStroke();
  saveOps(editor.doc.ops);
  try {
    localStorage.setItem(TOOLS_KEY, JSON.stringify(editor.tools));
  } catch {
    /* ignore */
  }
  input?.detach();
  toolbar?.destroy();
  cursor?.destroy();
  board.classList.remove("ts-board-drawing");
  // Keep showing the finished drawing, re-rendered from the saved data like other clients would.
  standalone = previewOf(lastSaved);
  editor = null;
  toolbar = null;
  input = null;
  cursor = null;
  report();
}

/* ---------------- map navigation (what Foundry does) ---------------- */

board.addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    view.zoom = Math.min(8, Math.max(0.2, view.zoom * factor));
    toolbar?.setFocusActive(false);
    toolbar?.refreshScale();
  },
  { passive: false },
);

let pan: { x: number; y: number; vx: number; vy: number } | null = null;
board.addEventListener("pointerdown", (e) => {
  if (e.button === 2 || e.button === 1) {
    pan = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    board.setPointerCapture(e.pointerId);
  } else if (!editor && e.button === 0) {
    const r = tokenRect();
    if (e.clientX >= r.x && e.clientX <= r.x + r.size && e.clientY >= r.y && e.clientY <= r.y + r.size) {
      log.textContent = "token clicked (would select / drag in Foundry)";
    }
  }
});
board.addEventListener("pointermove", (e) => {
  if (!pan) return;
  view.x = pan.vx - (e.clientX - pan.x) / view.zoom;
  view.y = pan.vy - (e.clientY - pan.y) / view.zoom;
});
board.addEventListener("pointerup", () => (pan = null));
board.addEventListener("contextmenu", (e) => e.preventDefault());

window.addEventListener("keydown", (e) => {
  if (!editor && e.code === "KeyB") startEditing();
});

/* ---------------- boot ---------------- */

async function boot(): Promise<void> {
  const lang = params.get("lang") === "zh-CN" ? "zh-CN" : "en";
  const theme = params.get("theme") === "light" ? "light" : "dark";
  document.body.classList.add(`theme-${theme}`);
  (document.getElementById("h-lang") as HTMLSelectElement).value = lang;
  (document.getElementById("h-theme") as HTMLSelectElement).value = theme;
  await loadLang(lang);
  resize();
  window.addEventListener("resize", resize);
  lastSaved = loadOps();
  const go = (key: string, value: string) => {
    params.set(key, value);
    location.search = params.toString();
  };
  document.getElementById("h-edit")!.addEventListener("click", startEditing);
  document.getElementById("h-lang")!.addEventListener("change", (e) => go("lang", (e.target as HTMLSelectElement).value));
  document.getElementById("h-theme")!.addEventListener("change", (e) => go("theme", (e.target as HTMLSelectElement).value));
  document.getElementById("h-reset")!.addEventListener("click", () => {
    localStorage.removeItem(STORE_KEY);
    location.reload();
  });
  if (lastSaved.length) standalone = previewOf(lastSaved);
  if (params.get("edit") !== "0") startEditing();
  requestAnimationFrame(render);
  report();
}

/** Render a drawing from scratch (what a client that only reads the document sees). */
function previewOf(ops: readonly Op[]): Raster {
  const preview = new ScribbleEditor({
    paper: PAPER,
    ops,
    outliner: freehandOutliner,
    rasterPx: 1024,
    tools: defaultToolState(),
    pressureMode: "off",
    maxBytes: MAX_BYTES,
    measure: saveSizeOf,
    placeholder: false,
  });
  return preview.raster;
}

void boot();
