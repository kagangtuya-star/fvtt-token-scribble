import { COORD_SCALE, PRESSURE_LEVELS } from "../constants.ts";

/**
 * Compact point codec.
 *
 * Points are quantised (0.1 paper unit, 64 pressure levels), delta-encoded,
 * zig-zag mapped and written as LEB128 varints, then base64 encoded. A typical
 * freehand point costs 3–5 bytes before base64, an order of magnitude smaller
 * than the equivalent JSON number array.
 *
 * Layout: varint(count) then for each point varint(zz(dx)) varint(zz(dy)) varint(zz(dp)).
 */

export class CodecError extends Error {
  override name = "CodecError";
}

const MAX_POINTS = 100_000;

function zigzag(n: number): number {
  return n >= 0 ? n * 2 : -n * 2 - 1;
}

function unzigzag(n: number): number {
  return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
}

class ByteWriter {
  #buf = new Uint8Array(256);
  #len = 0;

  varint(value: number): void {
    let v = value;
    if (!Number.isSafeInteger(v) || v < 0) throw new CodecError(`Invalid varint ${value}`);
    do {
      let byte = v % 128;
      v = Math.floor(v / 128);
      if (v > 0) byte |= 0x80;
      this.#push(byte);
    } while (v > 0);
  }

  #push(byte: number): void {
    if (this.#len === this.#buf.length) {
      const next = new Uint8Array(this.#buf.length * 2);
      next.set(this.#buf);
      this.#buf = next;
    }
    this.#buf[this.#len++] = byte;
  }

  bytes(): Uint8Array {
    return this.#buf.subarray(0, this.#len);
  }
}

class ByteReader {
  #pos = 0;
  readonly buf: Uint8Array;

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  varint(): number {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 8; i++) {
      if (this.#pos >= this.buf.length) throw new CodecError("Unexpected end of data");
      const byte = this.buf[this.#pos++]!;
      result += (byte & 0x7f) * mul;
      if ((byte & 0x80) === 0) return result;
      mul *= 128;
    }
    throw new CodecError("Varint too long");
  }

  get done(): boolean {
    return this.#pos >= this.buf.length;
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function fromBase64(text: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(text);
  } catch {
    throw new CodecError("Invalid base64");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Quantise one coordinate to the stored fixed-point grid. */
export function quantizeCoord(v: number): number {
  return Math.round(v * COORD_SCALE);
}

/** Quantise a 0..1 pressure value. */
export function quantizePressure(p: number): number {
  return Math.round(Math.min(1, Math.max(0, p)) * PRESSURE_LEVELS);
}

/** Encode a flat `[x, y, p, ...]` array. */
export function encodePoints(flat: readonly number[]): string {
  if (flat.length % 3 !== 0) throw new CodecError("Point array length must be a multiple of 3");
  const count = flat.length / 3;
  const w = new ByteWriter();
  w.varint(count);
  let px = 0;
  let py = 0;
  let pp = 0;
  for (let i = 0; i < flat.length; i += 3) {
    const x = quantizeCoord(flat[i]!);
    const y = quantizeCoord(flat[i + 1]!);
    const p = quantizePressure(flat[i + 2]!);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new CodecError("Non-finite coordinate");
    w.varint(zigzag(x - px));
    w.varint(zigzag(y - py));
    w.varint(zigzag(p - pp));
    px = x;
    py = y;
    pp = p;
  }
  return toBase64(w.bytes());
}

/** Decode the output of {@link encodePoints} back into a flat array. */
export function decodePoints(text: string): number[] {
  if (typeof text !== "string") throw new CodecError("Points must be a string");
  const r = new ByteReader(fromBase64(text));
  const count = r.varint();
  if (count > MAX_POINTS) throw new CodecError("Too many points");
  const out = new Array<number>(count * 3);
  let x = 0;
  let y = 0;
  let p = 0;
  for (let i = 0; i < count; i++) {
    x += unzigzag(r.varint());
    y += unzigzag(r.varint());
    p += unzigzag(r.varint());
    if (p < 0 || p > PRESSURE_LEVELS) throw new CodecError("Pressure out of range");
    out[i * 3] = x / COORD_SCALE;
    out[i * 3 + 1] = y / COORD_SCALE;
    out[i * 3 + 2] = p / PRESSURE_LEVELS;
  }
  if (!r.done) throw new CodecError("Trailing data");
  return out;
}

/** Round a flat point array to exactly what survives an encode/decode round trip. */
export function quantizePoints(flat: readonly number[]): number[] {
  const out = new Array<number>(flat.length);
  for (let i = 0; i < flat.length; i += 3) {
    out[i] = quantizeCoord(flat[i]!) / COORD_SCALE;
    out[i + 1] = quantizeCoord(flat[i + 1]!) / COORD_SCALE;
    out[i + 2] = quantizePressure(flat[i + 2]!) / PRESSURE_LEVELS;
  }
  return out;
}
