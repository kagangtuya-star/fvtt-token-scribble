/**
 * Browser harness for the replace-mode window without Foundry.
 *
 * Installs a small stand-in for the Foundry globals the window uses
 * (ApplicationV2 frame, DialogV2.confirm, FilePicker with an in-memory "server",
 * settings, notifications) and opens the real window on a fake token. The
 * token's current image is shown on the left, with the files on the fake
 * server, so apply / restore can be checked end to end.
 *
 * Build with `npm run harness` and open `dist-dev/replace.html`.
 */
import { MODULE_ID } from "../src/constants.ts";
import { openReplaceEditor } from "../src/foundry/replace-window.ts";
import { portraitTarget, tokenTarget } from "../src/foundry/replace.ts";
import { encodeDrawing } from "../src/model/serialize.ts";
import type { StrokeOp } from "../src/model/types.ts";

const params = new URLSearchParams(location.search);
const log = document.getElementById("h-log")!;
const say = (msg: string) =>
  (log.textContent = `${new Date().toLocaleTimeString()}  ${msg}\n${log.textContent}`.slice(0, 4000));

/* ---------------- i18n ---------------- */

let strings: Record<string, string> = {};
function flatten(obj: Record<string, unknown>, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v as Record<string, unknown>, key, out);
    else out[key] = String(v);
  }
  return out;
}
const format = (key: string, data: Record<string, unknown> = {}) =>
  (strings[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => (k in data ? String(data[k]) : `{${k}}`));

/* ---------------- fake server ---------------- */

const server = new Map<string, Blob>();
const urls = new Map<string, string>();
const dirs = new Set<string>(["worlds/harness"]);

/** Resolve a stored path to something the browser can load. */
const resolve = (src: string) => urls.get(src) ?? src;

function store(path: string, blob: Blob): void {
  server.set(path, blob);
  const old = urls.get(path);
  if (old) URL.revokeObjectURL(old);
  urls.set(path, URL.createObjectURL(blob));
}

const nativeFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (server.has(url)) {
    const blob = server.get(url)!;
    return init?.method === "HEAD"
      ? new Response(null, { status: 200 })
      : new Response(blob, { headers: { "content-type": blob.type } });
  }
  if (url.startsWith("worlds/") || url.startsWith("tokens/") || url.startsWith("portraits/"))
    return new Response(null, { status: 404 });
  return nativeFetch(input, init);
}) as typeof window.fetch;

const filePicker = {
  async browse(_s: string, target: string) {
    if (!dirs.has(target)) throw new Error(`${target} does not exist`);
    return { target, dirs: [], files: [...server.keys()].filter((k) => k.startsWith(`${target}/`)) };
  },
  async createDirectory(_s: string, target: string) {
    dirs.add(target);
    say(`mkdir ${target}`);
    return {};
  },
  async upload(_s: string, path: string, file: File) {
    if (!dirs.has(path)) return false;
    store(`${path}/${file.name}`, file);
    say(`upload ${path}/${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
    renderFiles();
    return { path: `${path}/${file.name}` };
  },
};

/* ---------------- Foundry stand-ins ---------------- */

let zTop = 100;

class FakeApplicationV2 {
  static DEFAULT_OPTIONS = { classes: [] as string[], window: {}, position: { width: 600, height: 400 } };
  options: Record<string, any>;
  #element: HTMLElement | null = null;
  #content: HTMLElement | null = null;

  constructor(options: Record<string, any> = {}) {
    const chain: any[] = [];
    for (let c = this.constructor as any; c && c.DEFAULT_OPTIONS; c = Object.getPrototypeOf(c))
      chain.unshift(c.DEFAULT_OPTIONS);
    const merged: Record<string, any> = { classes: [], window: {}, position: {} };
    for (const o of [...chain, options]) {
      merged.classes = [...merged.classes, ...(o.classes ?? [])];
      merged.window = { ...merged.window, ...(o.window ?? {}) };
      merged.position = { ...merged.position, ...(o.position ?? {}) };
      if (o.id) merged.id = o.id;
    }
    this.options = merged;
  }
  get id() {
    return this.options.id as string;
  }
  get element() {
    return this.#element!;
  }
  get rendered() {
    return !!this.#element;
  }
  async render() {
    if (!this.#element) {
      const el = document.createElement("div");
      el.id = this.id;
      el.className = `application ${this.options.classes.join(" ")}`;
      const { width, height } = this.options.position;
      Object.assign(el.style, { width: `${width}px`, height: `${height}px`, zIndex: String(++zTop) });
      const header = document.createElement("header");
      header.className = "window-header";
      header.innerHTML = `<i class="${this.options.window.icon ?? ""}"></i><h1 class="window-title"></h1><button type="button" data-close>✕</button>`;
      header.querySelector("h1")!.textContent = this.options.window.title ?? "";
      header.querySelector("[data-close]")!.addEventListener("click", () => void (this as any).close());
      this.#content = document.createElement("section");
      this.#content.className = `window-content ${(this.options.window.contentClasses ?? []).join(" ")}`;
      el.append(header, this.#content);
      document.body.append(el);
      this.#element = el;
    }
    const result = await (this as any)._renderHTML({}, {});
    (this as any)._replaceHTML(result, this.#content, {});
    return this;
  }
  bringToFront() {
    if (this.#element) this.#element.style.zIndex = String(++zTop);
  }
  async close() {
    this.#element?.remove();
    this.#element = null;
    (this as any)._onClose({});
    return this;
  }
  async _renderHTML(): Promise<unknown> {
    return null;
  }
  _replaceHTML(): void {}
  _onClose(): void {}
}

const settings = new Map<string, unknown>();
const g = globalThis as Record<string, unknown>;
g.game = {
  user: { id: "harness-user", name: "Harness", isGM: true, can: () => params.get("files") !== "0" },
  world: { id: "harness" },
  release: { generation: 13 },
  version: "13",
  i18n: {
    lang: "en",
    localize: (k: string) => format(k),
    format: (k: string, d: Record<string, unknown>) => format(k, d),
    has: (k: string) => k in strings,
  },
  settings: {
    get: (m: string, k: string) => settings.get(`${m}.${k}`),
    set: async (m: string, k: string, v: unknown) => settings.set(`${m}.${k}`, v),
  },
};
g.CONFIG = { ux: { FilePicker: filePicker } };
g.foundry = {
  utils: {},
  applications: {
    api: {
      ApplicationV2: FakeApplicationV2,
      DialogV2: {
        confirm: async (o: { window?: { title?: string }; content?: string }) =>
          window.confirm(`${o.window?.title}\n\n${(o.content ?? "").replace(/<[^>]+>/g, "")}`),
      },
    },
  },
};
g.ui = {
  notifications: {
    info: (m: string) => say(`ℹ ${m}`),
    warn: (m: string) => say(`⚠ ${m}`),
    error: (m: string) => say(`✖ ${m}`),
  },
};

/* ---------------- fake documents ---------------- */

function setPath(obj: Record<string, any>, path: string, value: unknown): void {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)!] = value;
}

function doc<T extends Record<string, unknown>>(data: T) {
  const d = {
    ...data,
    flags: {} as Record<string, Record<string, unknown> | undefined>,
    canUserModify: () => true,
    async update(change: Record<string, unknown>) {
      for (const [k, v] of Object.entries(change)) setPath(d as Record<string, any>, k, v);
      say(`update ${Object.keys(change).join(", ")}`);
      renderPreview();
    },
  };
  return d;
}

/** A recognisable "original" image: drawn once and stored on the fake server. */
async function makeOriginal(path: string, w: number, h: number, hue: number): Promise<void> {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d")!;
  const grad = x.createRadialGradient(w * 0.4, h * 0.35, 10, w / 2, h / 2, Math.max(w, h) * 0.6);
  grad.addColorStop(0, `hsl(${hue} 70% 65%)`);
  grad.addColorStop(1, `hsl(${hue + 40} 60% 30%)`);
  x.fillStyle = grad;
  x.beginPath();
  x.ellipse(w / 2, h / 2, w * 0.45, h * 0.45, 0, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = "#111";
  x.beginPath();
  x.arc(w * 0.38, h * 0.42, w * 0.05, 0, Math.PI * 2);
  x.arc(w * 0.62, h * 0.42, w * 0.05, 0, Math.PI * 2);
  x.fill();
  x.lineWidth = w * 0.03;
  x.strokeStyle = "#111";
  x.beginPath();
  x.arc(w / 2, h * 0.55, w * 0.18, 0.15 * Math.PI, 0.85 * Math.PI);
  x.stroke();
  const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/png"));
  store(path, blob);
}

const actor = doc({
  id: "actor1",
  name: "Goblin",
  img: "portraits/goblin.png",
  prototypeToken: { flags: {}, texture: { src: "tokens/goblin.png" } },
});
const token = doc({
  id: "token1",
  name: "Goblin Scout",
  texture: { src: "tokens/goblin.png" },
  actorLink: true,
  actor,
  baseActor: actor,
});

/* ---------------- page ---------------- */

function renderPreview(): void {
  const box = document.getElementById("h-preview")!;
  box.replaceChildren();
  for (const [label, src] of [
    ["token texture.src", token.texture.src],
    ["prototype texture.src", actor.prototypeToken.texture.src],
    ["actor img", actor.img],
  ] as const) {
    const fig = document.createElement("figure");
    const img = document.createElement("img");
    img.src = resolve(src ?? "");
    img.alt = label;
    const cap = document.createElement("figcaption");
    cap.textContent = `${label}: ${src}`;
    fig.append(img, cap);
    box.append(fig);
  }
  const pre = document.createElement("pre");
  pre.textContent = `token flags: ${JSON.stringify(token.flags[MODULE_ID] ?? {}, (k, v) => (k === "drawing" && v ? "[drawing]" : v), 1)}`;
  box.append(pre);
}

function renderFiles(): void {
  const list = document.getElementById("h-files")!;
  list.textContent = [...server.keys()].sort().join("\n");
}

// Image loads by the editor use stored paths: resolve them to the in-memory files.
const srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!;
Object.defineProperty(HTMLImageElement.prototype, "src", {
  ...srcDesc,
  set(this: HTMLImageElement, v: string) {
    srcDesc.set!.call(this, resolve(v));
  },
});

async function boot(): Promise<void> {
  const lang = params.get("lang") === "zh-CN" ? "zh-CN" : "en";
  const res = await fetch(`lang/${lang}.json`);
  strings = flatten(await res.json());
  if (params.get("theme") === "light") document.body.classList.add("theme-light");
  await makeOriginal("tokens/goblin.png", 400, 400, 120);
  await makeOriginal("portraits/goblin.png", 300, 400, 20);
  // An in-place drawing on the token, to check that it is baked in.
  if (params.get("overlay") === "1") {
    const points: number[] = [];
    for (let i = 0; i <= 40; i++) points.push(150 + i * 17, 820 - Math.sin(i / 6) * 60, 0.5);
    const op: StrokeOp = {
      kind: "stroke",
      id: "harnessa1",
      tool: "marker",
      color: "#c62f2f",
      opacity: 0.8,
      size: 40,
      mirror: false,
      points,
    };
    token.flags[MODULE_ID] = {
      drawing: encodeDrawing({ w: 1000, h: 1000 }, [op], { rev: "r", parent: null, seq: 1, by: null, at: 0 }),
    };
  }
  renderPreview();
  renderFiles();
  document
    .getElementById("h-token")!
    .addEventListener("click", () => void openReplaceEditor(tokenTarget(token as unknown as FoundryTokenDocument)));
  document
    .getElementById("h-portrait")!
    .addEventListener("click", () => void openReplaceEditor(portraitTarget(actor as unknown as FoundryActor)));
  if (params.get("open") !== "0") void openReplaceEditor(tokenTarget(token as unknown as FoundryTokenDocument));
}

void boot();
