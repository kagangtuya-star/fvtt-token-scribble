import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fitReplacementView, replacementExtent } from "../src/model/replace-view.ts";
import { containsExtent, drawingExtent, paperExtent } from "../src/model/extent.ts";
import { stroke } from "./helpers.ts";

describe("replace-mode export extent", () => {
  const paper = { w: 1000, h: 500 };
  const outside = stroke(undefined, { size: 10, points: [-20, 250, 0.5, -50, 250, 0.5] });

  it("keeps the original dimensions without out-of-frame ink", () => {
    assert.deepEqual(replacementExtent(paper, [], "token"), paperExtent(paper));
    assert.deepEqual(replacementExtent(paper, [], "portrait"), paperExtent(paper));
  });

  it("keeps token centre and aspect while including single-sided ink", () => {
    const e = replacementExtent(paper, [outside], "token");
    assert.ok(containsExtent(e, drawingExtent([outside], paper)));
    assert.equal(e.x + e.w / 2, paper.w / 2);
    assert.equal(e.y + e.h / 2, paper.h / 2);
    assert.equal(e.w / e.h, paper.w / paper.h);
    assert.deepEqual(e, { x: -100, y: -50, w: 1200, h: 600 });
  });

  it("uses the content union for portraits, including negative coordinates", () => {
    assert.deepEqual(replacementExtent(paper, [outside], "portrait"), { x: -100, y: 0, w: 1100, h: 500 });
  });

  it("handles ink on every edge and mirrored strokes", () => {
    const ops = [stroke(undefined, { size: 10, mirror: true, points: [-30, -50, 0.5, 1020, 560, 0.5] })];
    for (const kind of ["token", "portrait"] as const) {
      assert.ok(containsExtent(replacementExtent(paper, ops, kind), drawingExtent(ops, paper)));
    }
  });

  it("does not expand for erasers and returns to the paper after undo", () => {
    assert.deepEqual(replacementExtent(paper, [{ ...outside, tool: "eraser" }], "token"), paperExtent(paper));
    assert.deepEqual(replacementExtent(paper, [], "token"), paperExtent(paper));
  });
});

describe("replace-mode fit", () => {
  it("centres a negative-origin export with drawing margins", () => {
    const e = { x: -100, y: -50, w: 1200, h: 600 };
    const view = fitReplacementView(800, 600, e);
    assert.ok(Math.abs(view.x + (e.x + e.w / 2) * view.zoom - 400) < 1e-9);
    assert.ok(Math.abs(view.y + (e.y + e.h / 2) * view.zoom - 300) < 1e-9);
    assert.ok(e.w * view.zoom <= 736);
    assert.ok(e.h * view.zoom <= 536);
  });

  it("fits landscape and portrait images after a window resize", () => {
    for (const [w, h] of [[800, 300], [300, 800]]) {
      const e = { x: 0, y: 0, w: 500, h: 1000 };
      const v = fitReplacementView(w!, h!, e);
      assert.equal(v.x + e.w * v.zoom / 2, w! / 2);
      assert.equal(v.y + e.h * v.zoom / 2, h! / 2);
      assert.ok(e.w * v.zoom <= w! - 64);
      assert.ok(e.h * v.zoom <= h! - 64);
    }
  });
});
