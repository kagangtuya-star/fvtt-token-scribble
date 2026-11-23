import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodecError, decodePoints, encodePoints, quantizePoints } from "../src/model/codec.ts";
import { COORD_SCALE } from "../src/constants.ts";

describe("point codec", () => {
  it("round-trips quantised points exactly", () => {
    const flat: number[] = [];
    for (let i = 0; i < 500; i++) flat.push(Math.random() * 1000, Math.random() * 1000, Math.random());
    const q = quantizePoints(flat);
    assert.deepEqual(decodePoints(encodePoints(flat)), q);
    assert.deepEqual(decodePoints(encodePoints(q)), q);
  });

  it("keeps sub-unit precision of 1/COORD_SCALE", () => {
    const back = decodePoints(encodePoints([12.34, 56.78, 0.5]));
    assert.ok(Math.abs(back[0]! - 12.34) <= 0.5 / COORD_SCALE);
    assert.ok(Math.abs(back[1]! - 56.78) <= 0.5 / COORD_SCALE);
    assert.ok(Math.abs(back[2]! - 0.5) < 0.01);
  });

  it("handles negative coordinates and big jumps", () => {
    const flat = [-50, -50, 0, 999.9, 999.9, 1, -0.1, 0.1, 0.2];
    assert.deepEqual(decodePoints(encodePoints(flat)), quantizePoints(flat));
  });

  it("is compact (≈3 bytes per smooth point)", () => {
    const flat: number[] = [];
    for (let i = 0; i < 1000; i++) flat.push(100 + i * 0.8, 300 + Math.sin(i / 20) * 40, 0.5 + Math.sin(i / 50) * 0.2);
    const encoded = encodePoints(flat);
    assert.ok(encoded.length < 1000 * 5, `encoded length ${encoded.length}`);
  });

  it("clamps pressure into range", () => {
    const back = decodePoints(encodePoints([1, 1, 7, 2, 2, -3]));
    assert.equal(back[2], 1);
    assert.equal(back[5], 0);
  });

  it("rejects malformed input", () => {
    assert.throws(() => encodePoints([1, 2]), CodecError);
    assert.throws(() => encodePoints([Number.NaN, 1, 1]), CodecError);
    assert.throws(() => decodePoints("@@@"), CodecError);
    const good = encodePoints([1, 2, 0.5, 3, 4, 0.5]);
    assert.throws(() => decodePoints(good.slice(0, -4)), CodecError);
    assert.throws(() => decodePoints(good + "AAAA"), CodecError);
    assert.throws(() => decodePoints(42 as unknown as string), CodecError);
  });

  it("encodes an empty stroke", () => {
    assert.deepEqual(decodePoints(encodePoints([])), []);
  });
});
