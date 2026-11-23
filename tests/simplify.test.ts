import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { simplifyStroke } from "../src/model/simplify.ts";

describe("simplifyStroke", () => {
  it("collapses collinear points with constant pressure", () => {
    const flat: number[] = [];
    for (let i = 0; i <= 100; i++) flat.push(i, i * 2, 0.5);
    assert.deepEqual(simplifyStroke(flat, 0.5), [0, 0, 0.5, 100, 200, 0.5]);
  });

  it("keeps corners", () => {
    const flat: number[] = [];
    for (let i = 0; i <= 50; i++) flat.push(i, 0, 0.5);
    for (let i = 1; i <= 50; i++) flat.push(50, i, 0.5);
    const out = simplifyStroke(flat, 0.5);
    assert.equal(out.length / 3, 3);
    assert.deepEqual(out.slice(3, 6), [50, 0, 0.5]);
  });

  it("keeps pressure changes on a straight line", () => {
    const flat: number[] = [];
    for (let i = 0; i <= 100; i++) flat.push(i, 0, i < 50 ? 0.2 : 0.9);
    const out = simplifyStroke(flat, 0.5);
    assert.ok(out.length / 3 >= 3, "pressure step must survive");
  });

  it("stays within tolerance of the original curve", () => {
    const flat: number[] = [];
    for (let i = 0; i <= 400; i++) flat.push(i, Math.sin(i / 30) * 60, 0.5);
    const tol = 0.5;
    const out = simplifyStroke(flat, tol);
    assert.ok(out.length < flat.length / 4);
    // Every original point is near the simplified polyline.
    for (let i = 0; i < flat.length; i += 3) {
      let best = Infinity;
      for (let j = 0; j + 5 < out.length; j += 3) {
        const [ax, ay, bx, by] = [out[j]!, out[j + 1]!, out[j + 3]!, out[j + 4]!];
        const dx = bx - ax;
        const dy = by - ay;
        const t = Math.max(0, Math.min(1, ((flat[i]! - ax) * dx + (flat[i + 1]! - ay) * dy) / (dx * dx + dy * dy)));
        best = Math.min(best, Math.hypot(flat[i]! - (ax + dx * t), flat[i + 1]! - (ay + dy * t)));
      }
      assert.ok(best <= tol + 1e-9, `point ${i / 3} is ${best} away`);
    }
  });

  it("handles tiny and very long inputs", () => {
    assert.deepEqual(simplifyStroke([], 1), []);
    assert.deepEqual(simplifyStroke([1, 2, 0.5], 1), [1, 2, 0.5]);
    const flat: number[] = [];
    for (let i = 0; i < 20_000; i++) flat.push(i % 1000, Math.floor(i / 1000), 0.5); // 3× MAX_SAMPLES_PER_STROKE, worst-case zigzag
    assert.doesNotThrow(() => simplifyStroke(flat, 0.3));
  });
});
