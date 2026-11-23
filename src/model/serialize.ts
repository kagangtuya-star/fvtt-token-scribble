import { FORMAT_VERSION, MAX_TOMBSTONES, PAPER_LONG_SIDE } from "../constants.ts";
import { CodecError, decodePoints, encodePoints } from "./codec.ts";
import { TOOL_IDS } from "./types.ts";
import type { DrawingState, Op, Paper, StrokeOp, StrokeParams, ToolId } from "./types.ts";

/* -------------------------------------------- */
/*  Stored (flag) representation                */
/* -------------------------------------------- */

export interface StoredStroke {
  k: "s";
  id: string;
  t: ToolId;
  c: string;
  /** opacity ×100, omitted when 100 */
  a?: number;
  /** size ×10 */
  z: number;
  m?: 1;
  x?: { th?: number; sm?: number; ts?: number; te?: number };
  p: string;
}

export interface StoredClear {
  k: "c";
  id: string;
}

export type StoredOp = StoredStroke | StoredClear;

export interface StoredDrawing {
  v: number;
  w: number;
  h: number;
  ops: StoredOp[];
  rev: string;
  par: string | null;
  seq: number;
  by: string | null;
  at: number;
  /** Tombstones: ids of recently deleted ops (omitted when empty). */
  del?: string[];
}

export type DecodeResult =
  | { ok: true; state: DrawingState }
  | { ok: false; reason: "missing" | "version" | "corrupt"; detail?: string };

const ID_RE = /^[0-9a-z]{4,32}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/;

/* -------------------------------------------- */
/*  Encoding                                    */
/* -------------------------------------------- */

/** Encoded stroke cache: ops are immutable, so encode each object once. */
const encodedCache = new WeakMap<StrokeOp, StoredStroke>();

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function encodeParams(params: StrokeParams | undefined): StoredStroke["x"] | undefined {
  if (!params) return undefined;
  const x: NonNullable<StoredStroke["x"]> = {};
  if (params.thinning !== undefined) x.th = round(params.thinning, 2);
  if (params.smoothing !== undefined) x.sm = round(params.smoothing, 2);
  if (params.taperStart !== undefined) x.ts = round(params.taperStart, 2);
  if (params.taperEnd !== undefined) x.te = round(params.taperEnd, 2);
  return Object.keys(x).length ? x : undefined;
}

export function encodeOp(op: Op): StoredOp {
  if (op.kind === "clear") return { k: "c", id: op.id };
  const cached = encodedCache.get(op);
  if (cached) return cached;
  const stored = encodeOpUncached(op);
  encodedCache.set(op, stored);
  return stored;
}

function encodeOpUncached(op: StrokeOp): StoredStroke {
  const stored: StoredStroke = {
    k: "s",
    id: op.id,
    t: op.tool,
    c: op.color,
    z: Math.round(op.size * 10),
    p: encodePoints(op.points),
  };
  const a = Math.round(op.opacity * 100);
  if (a !== 100) stored.a = a;
  if (op.mirror) stored.m = 1;
  const x = encodeParams(op.params);
  if (x) stored.x = x;
  return stored;
}

export interface EncodeMeta {
  rev: string;
  parent: string | null;
  seq: number;
  by: string | null;
  at: number;
  del?: readonly string[];
}

export function encodeDrawing(paper: Paper, ops: readonly Op[], meta: EncodeMeta): StoredDrawing {
  const stored: StoredDrawing = {
    v: FORMAT_VERSION,
    w: paper.w,
    h: paper.h,
    ops: ops.map(encodeOp),
    rev: meta.rev,
    par: meta.parent,
    seq: meta.seq,
    by: meta.by,
    at: meta.at,
  };
  if (meta.del?.length) stored.del = meta.del.slice(-MAX_TOMBSTONES);
  return stored;
}

/** Approximate serialized size in bytes (what Foundry stores and transmits). */
export function storedSize(stored: StoredDrawing): number {
  return JSON.stringify(stored).length;
}

/* -------------------------------------------- */
/*  Decoding + validation                       */
/* -------------------------------------------- */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finiteIn(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

function decodeParams(x: unknown): StrokeParams | undefined {
  if (!isObject(x)) return undefined;
  const params: StrokeParams = {};
  if (finiteIn(x.th, -1, 1)) params.thinning = x.th;
  if (finiteIn(x.sm, 0, 1)) params.smoothing = x.sm;
  if (finiteIn(x.ts, 0, 20)) params.taperStart = x.ts;
  if (finiteIn(x.te, 0, 20)) params.taperEnd = x.te;
  return Object.keys(params).length ? params : undefined;
}

export function decodeOp(raw: unknown): Op {
  if (!isObject(raw) || typeof raw.id !== "string" || !ID_RE.test(raw.id)) {
    throw new CodecError("Invalid op");
  }
  if (raw.k === "c") return { kind: "clear", id: raw.id };
  if (raw.k !== "s") throw new CodecError(`Unknown op kind ${String(raw.k)}`);
  if (!TOOL_IDS.includes(raw.t as ToolId)) throw new CodecError("Unknown tool");
  if (typeof raw.c !== "string" || !COLOR_RE.test(raw.c)) throw new CodecError("Invalid color");
  if (!finiteIn(raw.z, 1, 100000)) throw new CodecError("Invalid size");
  if (raw.a !== undefined && !finiteIn(raw.a, 0, 100)) throw new CodecError("Invalid opacity");
  const points = decodePoints(raw.p as string);
  if (points.length === 0) throw new CodecError("Empty stroke");
  const params = decodeParams(raw.x);
  const op: StrokeOp = {
    kind: "stroke",
    id: raw.id,
    tool: raw.t as ToolId,
    color: raw.c,
    opacity: raw.a === undefined ? 1 : (raw.a as number) / 100,
    size: (raw.z as number) / 10,
    mirror: raw.m === 1,
    points,
    ...(params ? { params } : {}),
  };
  // Remember the stored form so re-saving does not re-encode untouched strokes.
  // A copy is cached so later in-place changes to document source cannot leak in.
  const copy = { ...(raw as unknown as StoredStroke) };
  if (copy.x) copy.x = { ...copy.x };
  encodedCache.set(op, copy);
  return op;
}

export function decodeDrawing(raw: unknown): DecodeResult {
  if (raw === undefined || raw === null) return { ok: false, reason: "missing" };
  if (!isObject(raw)) return { ok: false, reason: "corrupt", detail: "not an object" };
  if (typeof raw.v !== "number") return { ok: false, reason: "corrupt", detail: "no version" };
  if (raw.v > FORMAT_VERSION) return { ok: false, reason: "version", detail: String(raw.v) };
  if (!finiteIn(raw.w, 1, PAPER_LONG_SIDE) || !finiteIn(raw.h, 1, PAPER_LONG_SIDE)) {
    return { ok: false, reason: "corrupt", detail: "paper" };
  }
  if (!Array.isArray(raw.ops)) return { ok: false, reason: "corrupt", detail: "ops" };
  const ops: Op[] = [];
  const seen = new Set<string>();
  try {
    for (const rawOp of raw.ops) {
      const op = decodeOp(rawOp);
      if (seen.has(op.id)) continue; // tolerate duplicated ops from a bad merge
      seen.add(op.id);
      ops.push(op);
    }
  } catch (err) {
    return { ok: false, reason: "corrupt", detail: (err as Error).message };
  }
  return {
    ok: true,
    state: {
      paper: { w: raw.w as number, h: raw.h as number },
      ops,
      rev: typeof raw.rev === "string" ? raw.rev : null,
      parent: typeof raw.par === "string" ? raw.par : null,
      seq: finiteIn(raw.seq, 0, Number.MAX_SAFE_INTEGER) ? raw.seq : 0,
      by: typeof raw.by === "string" ? raw.by : null,
      // Tombstones are advisory: malformed entries are dropped, never fatal.
      del: Array.isArray(raw.del)
        ? raw.del.filter((id): id is string => typeof id === "string" && ID_RE.test(id)).slice(-MAX_TOMBSTONES)
        : [],
    },
  };
}

/** An empty, never-saved drawing for the given paper. */
export function emptyState(paper: Paper): DrawingState {
  return { paper, ops: [], rev: null, parent: null, seq: 0, by: null, del: [] };
}
