import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FORMAT_VERSION } from "../src/constants.ts";
import { decodeDrawing, decodeOp, encodeDrawing, encodeOp, storedSize } from "../src/model/serialize.ts";
import type { StoredDrawing } from "../src/model/serialize.ts";
import { clear, ids, stroke } from "./helpers.ts";

const meta = { rev: "rev00001", parent: null, seq: 1, by: "user0001", at: 1700000000000 };

function roundTrip(stored: StoredDrawing) {
  return decodeDrawing(JSON.parse(JSON.stringify(stored)));
}

describe("drawing serialisation", () => {
  it("round-trips strokes and clears", () => {
    const ops = [
      stroke("aaaa", { color: "#ff0000", opacity: 0.5, size: 12.3, mirror: true, params: { thinning: 0.4, taperEnd: 2 } }),
      clear("bbbb"),
      stroke("cccc", { tool: "eraser" }),
      stroke("dddd", { tool: "fill" }),
    ];
    const stored = encodeDrawing({ w: 1000, h: 600 }, ops, meta);
    assert.equal(stored.v, FORMAT_VERSION);
    const res = roundTrip(stored);
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.deepEqual(res.state.paper, { w: 1000, h: 600 });
    assert.deepEqual(ids(res.state.ops), ["aaaa", "bbbb", "cccc", "dddd"]);
    assert.deepEqual(res.state.ops[0], ops[0]);
    assert.deepEqual(res.state.ops[2], ops[2]);
    assert.equal(res.state.rev, "rev00001");
    assert.equal(res.state.by, "user0001");
    assert.equal(res.state.seq, 1);
  });

  it("omits defaults to stay small", () => {
    const s = encodeOp(stroke("aaaa")) as unknown as Record<string, unknown>;
    assert.equal(s.a, undefined);
    assert.equal(s.m, undefined);
    assert.equal(s.x, undefined);
    assert.equal(s.z, 90);
  });

  it("reuses encoded strokes (cache) and decoding primes the cache", () => {
    const op = stroke("aaaa");
    assert.equal(encodeOp(op), encodeOp(op));
    const raw = JSON.parse(JSON.stringify(encodeOp(op)));
    const decoded = decodeOp(raw);
    const again = encodeOp(decoded);
    assert.deepEqual(again, raw);
    raw.c = "#00ff00"; // mutating the source must not leak into the cache
    assert.equal((encodeOp(decoded) as { c: string }).c, "#1f1b18");
  });

  it("reports missing, newer and corrupt data distinctly", () => {
    assert.deepEqual(decodeDrawing(undefined), { ok: false, reason: "missing" });
    assert.deepEqual(decodeDrawing(null), { ok: false, reason: "missing" });
    const stored = encodeDrawing({ w: 1000, h: 1000 }, [stroke("aaaa")], meta);
    assert.equal(decodeDrawing({ ...stored, v: FORMAT_VERSION + 1 }).ok, false);
    assert.equal((decodeDrawing({ ...stored, v: FORMAT_VERSION + 1 }) as { reason: string }).reason, "version");
    const corrupt = [
      "nope",
      { ...stored, v: "1" },
      { ...stored, w: 0 },
      { ...stored, h: 5000 },
      { ...stored, ops: {} },
      { ...stored, ops: [{ k: "s", id: "aaaa", t: "laser", c: "#000000", z: 10, p: "" }] },
      { ...stored, ops: [{ k: "s", id: "AA", t: "pen", c: "#000000", z: 10, p: "" }] },
      { ...stored, ops: [{ ...stored.ops[0], c: "red" }] },
      { ...stored, ops: [{ ...stored.ops[0], p: "!!" }] },
      { ...stored, ops: [{ ...stored.ops[0], a: 300 }] },
      { ...stored, ops: [{ k: "zz", id: "aaaa" }] },
    ];
    for (const c of corrupt) {
      const r = decodeDrawing(c);
      assert.equal(r.ok, false, JSON.stringify(c).slice(0, 80));
      if (!r.ok) assert.equal(r.reason, "corrupt");
    }
  });

  it("drops duplicated op ids", () => {
    const stored = encodeDrawing({ w: 1000, h: 1000 }, [stroke("aaaa"), stroke("aaaa")], meta);
    const r = roundTrip(stored);
    assert.ok(r.ok && r.state.ops.length === 1);
  });

  it("ignores out-of-range optional stroke params", () => {
    const stored = encodeDrawing({ w: 1000, h: 1000 }, [stroke("aaaa")], meta);
    (stored.ops[0] as { x?: unknown }).x = { th: 9, sm: 0.5 };
    const r = roundTrip(stored);
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual((r.state.ops[0] as { params?: unknown }).params, { smoothing: 0.5 });
  });

  it("persists tombstones, capped and validated", () => {
    const del = Array.from({ length: 300 }, (_, i) => `t${String(i).padStart(4, "0")}`);
    const stored = encodeDrawing({ w: 1000, h: 1000 }, [stroke("aaaa")], { ...meta, del });
    assert.equal(stored.del!.length, 200);
    assert.equal(stored.del![199], "t0299", "keeps the newest");
    const r = roundTrip(stored);
    assert.ok(r.ok && r.state.del.length === 200);
    const noisy = roundTrip({ ...stored, del: ["ok00", 5, "BAD!", null, "fine"] as unknown as string[] });
    assert.ok(noisy.ok);
    if (noisy.ok) assert.deepEqual(noisy.state.del, ["ok00", "fine"]);
    assert.equal(encodeDrawing({ w: 1, h: 1 }, [], meta).del, undefined, "omitted when empty");
    const legacy = roundTrip(encodeDrawing({ w: 1000, h: 1000 }, [], meta));
    assert.ok(legacy.ok && legacy.state.del.length === 0);
  });

  it("measures size as JSON length", () => {
    const stored = encodeDrawing({ w: 1000, h: 1000 }, [stroke("aaaa", { n: 300 })], meta);
    assert.equal(storedSize(stored), JSON.stringify(stored).length);
    assert.ok(storedSize(stored) < 3000, `300 points took ${storedSize(stored)} bytes`);
  });
});
