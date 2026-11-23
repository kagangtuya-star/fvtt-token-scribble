/**
 * Replace mode, pure part: file naming, the backup record stored on the
 * document, output sizing and restore decisions. No Foundry or DOM access.
 *
 * Replace mode bakes a drawing into a new image file and points the token's
 * `texture.src` (or the actor's `img`) at it, so every other module sees an
 * ordinary image. The first replacement backs the original image up into the
 * world folder and remembers where it came from, so it can be restored.
 */

/** What a replacement changes. */
export type ReplaceKind = "token" | "portrait";

export const REPLACE_KINDS: readonly ReplaceKind[] = ["token", "portrait"];

/** Stored at `flags.token-scribble.replaced` on the TokenDocument / Actor (and prototype token). */
export interface ReplaceRecord {
  v: 1;
  kind: ReplaceKind;
  /** The image path before the first replacement ("" when there was none). */
  original: string;
  /** Copy of the original inside the world folder (null when there was nothing to copy). */
  backup: string | null;
  /** The generated image currently in use. */
  current: string;
  /** In-place drawing that was baked into the image (restored together with the image). */
  drawing?: unknown;
  /** The actor's prototype token was updated together with this token. */
  proto?: boolean;
  at: number;
  by: string | null;
}

const isStr = (v: unknown): v is string => typeof v === "string";

export function decodeReplaceRecord(raw: unknown): ReplaceRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || !REPLACE_KINDS.includes(r.kind as ReplaceKind)) return null;
  if (!isStr(r.original) || !isStr(r.current) || !r.current) return null;
  if (r.backup !== null && !isStr(r.backup)) return null;
  const rec: ReplaceRecord = {
    v: 1,
    kind: r.kind as ReplaceKind,
    original: r.original,
    backup: r.backup as string | null,
    current: r.current,
    at: typeof r.at === "number" && Number.isFinite(r.at) ? r.at : 0,
    by: isStr(r.by) ? r.by : null,
  };
  if (r.drawing !== undefined && r.drawing !== null) rec.drawing = r.drawing;
  if (r.proto === true) rec.proto = true;
  return rec;
}

/**
 * The record that applies to an image path: only while the document still
 * shows the image we generated. If someone picked another image since, the
 * old backup no longer describes "the original" and a new one is taken.
 */
export function activeRecord(raw: unknown, currentSrc: string | null | undefined): ReplaceRecord | null {
  const rec = decodeReplaceRecord(raw);
  return rec && rec.current === (currentSrc ?? "") ? rec : null;
}

/* -------------------------------------------- */
/*  Paths                                       */
/* -------------------------------------------- */

/** Root folder for replace-mode files inside the world (Foundry "data" storage). */
export function worldFolder(worldId: string): string {
  return `worlds/${worldId}/token-scribble`;
}

export function folderFor(worldId: string, use: ReplaceKind | "backup"): string {
  const sub = use === "token" ? "tokens" : use === "portrait" ? "portraits" : "backups";
  return `${worldFolder(worldId)}/${sub}`;
}

/** Path without query/hash. */
export function stripQuery(src: string): string {
  return src.replace(/[?#].*$/, "");
}

export function extensionOf(src: string): string {
  const path = stripQuery(src);
  const m = /\.([a-z0-9]{1,5})$/i.exec(path.slice(path.lastIndexOf("/") + 1));
  return m ? m[1]!.toLowerCase() : "";
}

const VIDEO_EXT = new Set(["webm", "mp4", "m4v", "ogv", "ogg", "mov"]);

export function isVideoSrc(src: string): boolean {
  return VIDEO_EXT.has(extensionOf(src));
}

export function isVectorSrc(src: string): boolean {
  return extensionOf(src) === "svg";
}

/** ASCII file-name slug (server paths stay portable across hosts and OSes). */
export function slug(text: string, fallback: string): string {
  const s = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || fallback;
}

/** Compact, sortable timestamp: base36 milliseconds. */
export const stamp = (now: number): string => Math.floor(now).toString(36);

/** File name of a generated image, e.g. `goblin-scout-AbC123-lx3k9z1.png`. */
export function imageFileName(name: string, docId: string, now: number): string {
  return `${slug(name, "image")}-${slug(docId, "doc")}-${stamp(now)}.png`;
}

/** File name of a backup copy, keeping the original's base name and extension. */
export function backupFileName(originalSrc: string, docId: string, now: number, mimeExt = ""): string {
  const path = stripQuery(originalSrc);
  const file = decodeURIComponentSafe(path.slice(path.lastIndexOf("/") + 1));
  const ext = extensionOf(path) || mimeExt || "img";
  const base = file.replace(/\.[^.]*$/, "");
  return `${slug(base, "original")}-${slug(docId, "doc")}-${stamp(now)}.${ext}`;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** File extension for an image MIME type (used when the source path has none). */
export function extForMime(mime: string): string {
  const m = /^image\/([a-z0-9.+-]+)/i.exec(mime);
  if (!m) return "";
  const sub = m[1]!.toLowerCase();
  if (sub === "jpeg") return "jpg";
  if (sub === "svg+xml") return "svg";
  return sub.replace(/[^a-z0-9]/g, "").slice(0, 5);
}

/* -------------------------------------------- */
/*  Sizing                                      */
/* -------------------------------------------- */

export const MAX_OUTPUT_PX = 4096;
/** Vector, tiny or missing images are drawn at this long side. */
export const DEFAULT_OUTPUT_PX = 512;

/**
 * Pixel size of the generated image: the original's own size (so other
 * modules and token scaling see the same proportions), upscaled for vector or
 * tiny sources and capped for huge ones.
 */
export function outputSize(naturalW: number, naturalH: number, vector: boolean): { w: number; h: number } {
  if (!(naturalW > 0) || !(naturalH > 0)) return { w: DEFAULT_OUTPUT_PX, h: DEFAULT_OUTPUT_PX };
  const long = Math.max(naturalW, naturalH);
  let target = long;
  if (vector || long < 256) target = Math.max(DEFAULT_OUTPUT_PX, long);
  target = Math.min(MAX_OUTPUT_PX, target);
  const k = target / long;
  return { w: Math.max(1, Math.round(naturalW * k)), h: Math.max(1, Math.round(naturalH * k)) };
}

/* -------------------------------------------- */
/*  Restore                                     */
/* -------------------------------------------- */

/**
 * Which image to restore: the original path while it still exists (keeps
 * links to shared art intact), otherwise the world-folder backup.
 */
export function restoreSource(rec: ReplaceRecord, originalExists: boolean): string {
  if (!rec.original) return "";
  if (originalExists || !rec.backup) return rec.original;
  return rec.backup;
}
