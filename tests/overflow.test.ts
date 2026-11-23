import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScribbleEditor } from "../src/editor/editor.ts";
import { defaultToolState } from "../src/editor/tool-state.ts";
import type { InputPoint, OutlineOptions, Outliner } from "../src/engine/geometry.ts";
import { MAX_CANVAS_PX, Raster } from "../src/engine/raster.ts";
import type { AnyCanvas, CanvasFactory } from "../src/engine/raster.ts";
import { drawingToSvg } from "../src/engine/svg-export.ts";
import {
  containsExtent,
  drawingExtent,
  EXTENT_STEP,
  growExtent,
  isPaperExtent,
  maxExtent,
  paperExtent,
  strokeBox,
} from "../src/model/extent.ts";
import type { Paper } from "../src/model/types.ts";
import { clear, stroke } from "./helpers.ts";

const PAPER: Paper = { w: 1000, h: 500 };

const outliner: Outliner = (points: InputPoint[], options: OutlineOptions) => {
  const half = options.size / 2;
  return [...points.map(([x, y]) => [x - half, y - half]), ...points.map(([x, y]) => [x + half, y + half]).reverse()];
};

/** A stroke through the given (x, y) pairs. */
function at(pairs: [number, number][], opts: Parameters<typeof stroke>[1] = {}) {
  return stroke(undefined, { ...opts, points: pairs.flatMap(([x, y]) => [x, y, 0.5]) });
}

/* ---------------- fake 2D canvas ---------------- */

interface Call {
  op: string;
  args: number[];
}

class FakeCtx {
  calls: Call[] = [];
  globalCompositeOperation = "source-over";
  globalAlpha = 1;
  fillStyle = "";
  strokeStyle = "";
  lineWidth = 1;
  shadowColor = "";
  shadowBlur = 0;
  save() {}
  restore() {}
  setTransform(...args: number[]) {
    this.calls.push({ op: "setTransform", args });
  }
  clearRect() {}
  fill() {
    this.calls.push({ op: "fill", args: [] });
  }
  drawImage() {}
  setLineDash() {}
  beginPath() {}
  roundRect() {}
  moveTo() {}
  lineTo() {}
  closePath() {}
  stroke() {}
}

const factory: CanvasFactory = (width, height) => {
  const ctx = new FakeCtx();
  return { width, height, getContext: () => ctx } as unknown as AnyCanvas;
};

const ctxOf = (c: AnyCanvas) => c.getContext("2d") as unknown as FakeCtx;

(globalThis as { Path2D?: unknown }).Path2D ??= class {
  constructor(_d?: string) {}
};

/* ---------------- tests ---------------- */

describe("drawing extent", () => {
  it("is the paper when all ink is inside", () => {
    const e = drawingExtent(
      [
        at([
          [100, 100],
          [200, 200],
        ]),
      ],
      PAPER,
    );
    assert.ok(isPaperExtent(e, PAPER));
  });

  it("grows outward in whole steps to cover ink beyond the frame", () => {
    const e = drawingExtent(
      [
        at(
          [
            [-30, 100],
            [1040, 520],
          ],
          { size: 10 },
        ),
      ],
      PAPER,
    );
    assert.deepEqual(e, { x: -100, y: 0, w: 1200, h: 600 });
    assert.equal(Math.abs(e.x % EXTENT_STEP), 0);
    assert.ok(containsExtent(e, paperExtent(PAPER)));
  });

  it("accounts for the mirrored copy", () => {
    const box = strokeBox(
      at(
        [
          [980, 100],
          [1050, 120],
        ],
        { mirror: true, size: 4 },
      ),
      PAPER,
    )!;
    assert.deepEqual(box, [-54, 96, 1054, 124]);
  });

  it("ignores erasers and strokes hidden by a clear", () => {
    const outside = at([
      [-300, -300],
      [-250, -250],
    ]);
    assert.ok(isPaperExtent(drawingExtent([outside, clear()], PAPER), PAPER));
    assert.ok(
      isPaperExtent(
        drawingExtent(
          [
            at(
              [
                [-300, 0],
                [-200, 0],
              ],
              { tool: "eraser" },
            ),
          ],
          PAPER,
        ),
        PAPER,
      ),
    );
  });

  it("is clamped to one paper long side around the paper", () => {
    const e = drawingExtent(
      [
        at([
          [-5000, -5000],
          [9000, 9000],
        ]),
      ],
      PAPER,
    );
    assert.deepEqual(e, maxExtent(PAPER));
    assert.deepEqual(e, { x: -1000, y: -1000, w: 3000, h: 2500 });
  });

  it("adds headroom only on the sides that grew", () => {
    const e = growExtent(paperExtent(PAPER), [-10, 50, 300, 300], PAPER, EXTENT_STEP);
    assert.deepEqual(e, { x: -200, y: 0, w: 1200, h: 500 });
  });
});

describe("Raster with an extent", () => {
  it("offsets every stroke by the extent origin, mirror included", () => {
    const extent = { x: -100, y: -200, w: 1300, h: 800 };
    const r = new Raster(PAPER, 1000, outliner, factory, extent);
    assert.equal(r.scale, 1);
    assert.equal(r.width, 1300);
    assert.equal(r.height, 800);
    assert.equal(r.paperPx, 1000);
    r.renderAll([
      at(
        [
          [10, 10],
          [20, 20],
        ],
        { mirror: true },
      ),
    ]);
    // The first setTransform is the identity used to clear the canvas.
    const strokeTransforms = ctxOf(r.committed)
      .calls.filter((c) => c.op === "setTransform")
      .slice(1);
    assert.deepEqual(strokeTransforms[0]!.args, [1, 0, 0, 1, 100, 200]);
    assert.deepEqual(strokeTransforms[1]!.args, [-1, 0, 0, 1, 1100, 200], "mirror axis stays at the paper centre");
  });

  it("lowers the resolution instead of exceeding the canvas cap", () => {
    const r = new Raster(PAPER, 2048, outliner, factory, maxExtent(PAPER));
    assert.ok(r.width <= MAX_CANVAS_PX && r.height <= MAX_CANVAS_PX);
    assert.equal(r.requestedPx, 2048);
    assert.ok(r.paperPx < 2048);
  });
});

describe("editor raster growth", () => {
  const make = (ops = [] as ReturnType<typeof at>[]) =>
    new ScribbleEditor({
      paper: PAPER,
      ops,
      outliner,
      rasterPx: 500,
      canvasFactory: factory,
      tools: defaultToolState(),
      pressureMode: "off",
      maxBytes: 1e9,
      measure: () => 0,
      placeholder: false,
    });

  it("starts with an extent covering saved out-of-frame ink", () => {
    const ed = make([
      at([
        [-150, 100],
        [100, 100],
      ]),
    ]);
    assert.equal(ed.raster.extent.x, -200);
  });

  it("grows while a stroke leaves the frame and keeps the strokes", () => {
    const ed = make();
    const before = ed.raster;
    ed.beginStroke(1, { x: 500, y: 250, time: 0, pressure: 0.5, pointerType: "mouse" });
    for (let i = 1; i <= 20; i++)
      ed.addSamples([{ x: 500 + i * 40, y: 250, time: i * 16, pressure: 0.5, pointerType: "mouse" }]);
    ed.flush();
    assert.notEqual(ed.raster, before, "raster rebuilt for the live stroke");
    assert.ok(ed.raster.extent.x + ed.raster.extent.w >= 1100, "right edge grew past the paper plus headroom");
    const grown = ed.raster;
    ed.endStroke();
    assert.equal(ed.doc.ops.length, 1);
    assert.equal(ed.raster, grown, "committing inside the grown extent does not rebuild again");
  });

  it("shrinks back to the paper when the overflow is undone", () => {
    const ed = make();
    ed.paste(
      [
        at([
          [-250, 100],
          [100, 100],
        ]),
      ],
      PAPER,
    );
    assert.ok(ed.raster.extent.x <= -300);
    ed.undo();
    assert.ok(isPaperExtent(ed.raster.extent, PAPER));
  });

  it("keeps the extent when the resolution changes", () => {
    const ed = make([
      at([
        [-150, 100],
        [100, 100],
      ]),
    ]);
    const e = ed.raster.extent;
    ed.resizeRaster(1200);
    assert.equal(ed.raster.requestedPx, 1200);
    assert.deepEqual(ed.raster.extent, e);
  });
});

describe("SVG export with overflow", () => {
  it("uses a view box that covers the out-of-frame ink", () => {
    const svg = drawingToSvg(
      PAPER,
      [
        at(
          [
            [-30, 100],
            [1040, 520],
          ],
          { size: 10 },
        ),
      ],
      outliner,
    );
    assert.match(svg, /viewBox="-100 0 1200 600"/);
  });
});
