import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BRUSHES, clampSize, DEFAULT_PALETTE, resolveStroke } from "../src/engine/brushes.ts";
import { outlineToPath, polygonToPath, resample, strokeGeometry } from "../src/engine/geometry.ts";
import type { InputPoint, OutlineOptions, Outliner } from "../src/engine/geometry.ts";
import { hasRealPressure, PressureModel } from "../src/engine/pressure.ts";
import { StrokeRecorder } from "../src/engine/recorder.ts";
import { drawingToSvg } from "../src/engine/svg-export.ts";
import { quantizePoints } from "../src/model/codec.ts";
import { TOOL_IDS } from "../src/model/types.ts";
import { clear, stroke } from "./helpers.ts";

/** Stand-in for perfect-freehand: offsets each point by ±size/2 (a valid closed outline). */
const stubOutliner: Outliner & { calls: OutlineOptions[] } = Object.assign(
  (points: InputPoint[], options: OutlineOptions) => {
    stubOutliner.calls.push(options);
    const half = options.size / 2;
    const left = points.map(([x, y]) => [x - half, y - half]);
    const right = points.map(([x, y]) => [x + half, y + half]).reverse();
    return [...left, ...right];
  },
  { calls: [] as OutlineOptions[] },
);

describe("brush presets", () => {
  it("are internally consistent", () => {
    for (const t of TOOL_IDS) {
      const b = BRUSHES[t];
      assert.equal(b.tool, t);
      assert.ok(b.minSize <= b.defaultSize && b.defaultSize <= b.maxSize, t);
      assert.ok(b.thinning >= -1 && b.thinning <= 1, t);
      assert.ok(b.streamline >= 0 && b.streamline < 1, t);
    }
    assert.ok(BRUSHES.eraser.erase && !BRUSHES.eraser.usesPressure);
    assert.ok(BRUSHES.fill.fill);
  });

  it("clamps sizes to the preset range", () => {
    assert.equal(clampSize("pen", 0), BRUSHES.pen.minSize);
    assert.equal(clampSize("pen", 1e6), BRUSHES.pen.maxSize);
    assert.equal(clampSize("pen", 12.34), 12.3);
  });

  it("per-stroke params override the preset", () => {
    const r = resolveStroke({ tool: "pen", size: 5, params: { thinning: 0.1 } });
    assert.equal(r.thinning, 0.1);
    assert.equal(r.taperEnd, BRUSHES.pen.taperEnd);
  });

  it("palette colours are valid and unique", () => {
    assert.equal(DEFAULT_PALETTE.length, 10);
    assert.equal(new Set(DEFAULT_PALETTE).size, 10);
    for (const c of DEFAULT_PALETTE) assert.match(c, /^#[0-9a-f]{6}$/);
  });
});

describe("pressure", () => {
  const sample = (x: number, time: number, pressure = 0, pointerType = "mouse") => ({ x, y: 0, time, pressure, pointerType });

  it("detects real pen pressure only", () => {
    assert.equal(hasRealPressure({ pointerType: "pen", pressure: 0.31 }), true);
    assert.equal(hasRealPressure({ pointerType: "pen", pressure: 0.5 }), false);
    assert.equal(hasRealPressure({ pointerType: "mouse", pressure: 0.31 }), false);
  });

  it("simulated pressure: slow strokes are bolder than fast ones and stay in range", () => {
    const slow = new PressureModel("simulate", 10);
    const fast = new PressureModel("simulate", 10);
    let ps = 0;
    let pf = 0;
    for (let i = 0; i < 80; i++) {
      ps = slow.next(sample(i * 0.5, i * 16));
      pf = fast.next(sample(i * 40, i * 16));
      for (const p of [ps, pf]) assert.ok(p >= 0.3 && p <= 0.9);
    }
    assert.ok(ps > pf + 0.15, `slow ${ps} vs fast ${pf}`);
  });

  it("simulated pressure changes smoothly (no jumps when the mouse stalls)", () => {
    const m = new PressureModel("simulate", 10);
    let prev = m.next(sample(0, 0));
    for (let i = 1; i < 120; i++) {
      const x = i < 60 ? i * 30 : 60 * 30; // fast, then a sudden stop
      const p = m.next(sample(x, i * 16));
      assert.ok(Math.abs(p - prev) < 0.08, `jump ${prev} → ${p} at ${i}`);
      prev = p;
    }
  });

  it("uses (filtered) real pressure in auto mode and constant pressure when off", () => {
    const m = new PressureModel("auto", 10);
    assert.equal(m.next(sample(0, 0, 0.8, "pen")), 0.8);
    const p = m.next(sample(1, 16, 0.2, "pen"));
    assert.ok(p < 0.8 && p > 0.2);
    assert.ok(m.usesRealPressure);
    const off = new PressureModel("off", 10);
    assert.equal(off.next(sample(0, 0, 0.9, "pen")), 0.5);
  });
});

describe("StrokeRecorder", () => {
  const opts = { streamline: 0.5, size: 10, pressureMode: "simulate" as const, usesPressure: true, minDistance: 0.5 };

  it("produces quantised, simplified points that end at the release point", () => {
    const r = new StrokeRecorder(opts);
    for (let i = 0; i <= 100; i++) r.add({ x: i * 3, y: Math.sin(i / 10) * 50 + 500, time: i * 8, pressure: 0, pointerType: "mouse" });
    const pts = r.finish();
    assert.equal(pts.length % 3, 0);
    assert.deepEqual(pts, quantizePoints(pts), "already quantised");
    assert.ok(pts.length / 3 < 101, "simplified");
    const n = pts.length;
    assert.ok(Math.abs(pts[n - 3]! - 300) < 0.1 && Math.abs(pts[n - 2]! - (Math.sin(10) * 50 + 500)) < 0.1);
    assert.deepEqual(pts.slice(0, 2), [0, 500]);
  });

  it("drops jitter below minDistance", () => {
    const r = new StrokeRecorder({ ...opts, minDistance: 2 });
    for (let i = 0; i < 50; i++) r.add({ x: 100 + (i % 2) * 0.3, y: 100, time: i * 8, pressure: 0, pointerType: "mouse" });
    assert.ok(r.preview().length / 3 <= 2);
    assert.equal(r.sampleCount, 50);
  });

  it("line mode draws a straight segment from the anchor to the pointer", () => {
    const r = new StrokeRecorder(opts);
    r.add({ x: 0, y: 0, time: 0, pressure: 0, pointerType: "mouse" });
    r.add({ x: 37, y: 91, time: 16, pressure: 0, pointerType: "mouse" });
    r.lineMode = true;
    r.add({ x: 100, y: 0, time: 32, pressure: 0, pointerType: "mouse" });
    const pts = r.finish();
    for (let i = 0; i < pts.length; i += 3) assert.equal(pts[i + 1], 0);
    assert.equal(pts[pts.length - 3], 100);
  });

  it("a single tap still yields a dot", () => {
    const r = new StrokeRecorder(opts);
    r.add({ x: 5, y: 5, time: 0, pressure: 0, pointerType: "mouse" });
    assert.equal(r.finish().length, 3);
  });
});

describe("geometry", () => {
  it("resample passes through every control point and keeps the ends", () => {
    const flat = [0, 0, 0.2, 100, 0, 0.8, 100, 100, 0.4];
    const pts = resample(flat, 5);
    assert.deepEqual(pts[0], [0, 0, 0.2]);
    assert.deepEqual(pts[pts.length - 1], [100, 100, 0.4]);
    assert.ok(pts.some(([x, y, p]) => x === 100 && y === 0 && p === 0.8));
    assert.ok(pts.length > 30);
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
      assert.ok(d < 10, `gap ${d}`);
    }
  });

  it("resample handles degenerate input", () => {
    assert.deepEqual(resample([], 1), []);
    assert.deepEqual(resample([3, 4, 0.5], 1), [[3, 4, 0.5]]);
  });

  it("outlineToPath builds closed quadratic paths", () => {
    const d = outlineToPath([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]);
    assert.match(d, /^M0 0Q10 0 10 5T5 10Z$/);
    assert.equal(outlineToPath([]), "");
    assert.match(outlineToPath([[5, 5]]), /^M4\.5 4\.5h1v1h-1Z$/);
    assert.equal(polygonToPath([[0, 0, 1], [1, 0, 1], [1, 1, 1]]), "M0 0L1 0L1 1Z");
  });

  it("strokeGeometry renders deterministically with streamline 0 and no live end taper", () => {
    stubOutliner.calls.length = 0;
    const op = stroke("aaaa", { size: 10 });
    const a = strokeGeometry(op, stubOutliner);
    const b = strokeGeometry(op, stubOutliner);
    assert.equal(a.path, b.path);
    strokeGeometry(op, stubOutliner, true);
    const [done, , live] = stubOutliner.calls;
    assert.equal(done!.streamline, 0);
    assert.equal(done!.simulatePressure, false);
    assert.equal(done!.last, true);
    assert.equal(done!.end.taper, BRUSHES.pen.taperEnd * 10);
    assert.equal(live!.last, false);
    assert.equal(live!.end.taper, 0);
    const [x0, y0, x1, y1] = a.bounds;
    assert.ok(x0 < 100 && y0 < 200 && x1 > 160 && y1 > 200);
  });

  it("fill strokes become polygons without calling the outliner", () => {
    stubOutliner.calls.length = 0;
    const g = strokeGeometry(stroke("ffff", { tool: "fill" }), stubOutliner);
    assert.equal(stubOutliner.calls.length, 0);
    assert.match(g.path, /^M.*L.*Z$/);
  });
});

describe("SVG export", () => {
  it("nests eraser masks so erasers only affect earlier ink", () => {
    const svg = drawingToSvg(
      { w: 1000, h: 500 },
      [stroke("old1"), clear("clr1"), stroke("aaaa", { color: "#ff0000", opacity: 0.5 }), stroke("eeee", { tool: "eraser" }), stroke("bbbb", { mirror: true })],
      stubOutliner,
    );
    assert.match(svg, /^<\?xml/);
    assert.match(svg, /viewBox="0 0 1000 500"/);
    assert.equal((svg.match(/<mask /g) ?? []).length, 1);
    assert.match(svg, /<g mask="url\(#ts-erase-0\)"><path d="[^"]+" fill="#ff0000" fill-opacity="0.5"\/><\/g>/);
    assert.match(svg, /matrix\(-1 0 0 1 1000 0\)/, "mirrored copy");
    assert.equal((svg.match(/fill="#1f1b18"/g) ?? []).length, 2, "cleared stroke is not exported, mirrored one twice");
  });

  it("exports an empty drawing as a valid empty SVG", () => {
    const svg = drawingToSvg({ w: 10, h: 10 }, [], stubOutliner);
    assert.match(svg, /<svg [^>]+><\/svg>/);
  });
});
