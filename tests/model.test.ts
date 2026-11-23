import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { paperRectIn, paperToTexture, textureToPaper } from "../src/model/fit.ts";
import { mergeOps, mergeWithSummary } from "../src/model/merge.ts";
import {
  isPictureEmpty,
  paperForAspect,
  randomId,
  sameOpIds,
  transplantStrokes,
  visibleStart,
  visibleStrokes,
} from "../src/model/ops.ts";
import { ScribbleDocument } from "../src/model/document.ts";
import { clear, ids, stroke } from "./helpers.ts";

describe("ops helpers", () => {
  it("randomId uses the storage-safe alphabet", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const id = randomId();
      assert.match(id, /^[0-9a-z]{10}$/);
      seen.add(id);
    }
    assert.equal(seen.size, 2000);
  });

  it("paperForAspect keeps the long side at 1000", () => {
    assert.deepEqual(paperForAspect(400, 400), { w: 1000, h: 1000 });
    assert.deepEqual(paperForAspect(800, 400), { w: 1000, h: 500 });
    assert.deepEqual(paperForAspect(300, 600), { w: 500, h: 1000 });
    assert.deepEqual(paperForAspect(0, 0), { w: 1000, h: 1000 });
    assert.deepEqual(paperForAspect(100000, 1), { w: 1000, h: 1 });
  });

  it("clear hides everything before it", () => {
    const a = stroke("aaaa");
    const b = stroke("bbbb");
    const c = clear("cccc");
    const d = stroke("dddd");
    assert.equal(visibleStart([a, b, c, d]), 3);
    assert.deepEqual(ids(visibleStrokes([a, b, c, d])), ["dddd"]);
    assert.deepEqual(visibleStrokes([a, c]), []);
  });

  it("eraser-only pictures count as empty", () => {
    assert.equal(isPictureEmpty([]), true);
    assert.equal(isPictureEmpty([stroke("eeee", { tool: "eraser" })]), true);
    assert.equal(isPictureEmpty([stroke("pppp"), clear("cccc")]), true);
    assert.equal(isPictureEmpty([stroke("pppp")]), false);
  });

  it("transplantStrokes contain-fits onto another paper with fresh ids", () => {
    const s = stroke("ssss", { points: [0, 0, 0.5, 1000, 500, 0.5], size: 10 });
    const [t] = transplantStrokes([s], { w: 1000, h: 500 }, { w: 500, h: 1000 });
    assert.notEqual(t!.id, s.id);
    assert.deepEqual(t!.points, [0, 375, 0.5, 500, 625, 0.5]);
    assert.equal(t!.size, 5);
    assert.deepEqual(s.points, [0, 0, 0.5, 1000, 500, 0.5], "source untouched");
  });
});

describe("paper ↔ texture mapping", () => {
  it("centres a square paper in a wide texture", () => {
    const rect = paperRectIn({ w: 1000, h: 1000 }, 400, 200);
    assert.deepEqual(rect, { x: 100, y: 0, scale: 0.2, width: 200, height: 200 });
    assert.deepEqual(paperToTexture(rect, { x: 500, y: 500 }), { x: 200, y: 100 });
    const back = textureToPaper(rect, { x: 200, y: 100 });
    assert.deepEqual(back, { x: 500, y: 500 });
  });

  it("round-trips arbitrary points", () => {
    const rect = paperRectIn({ w: 1000, h: 618 }, 517, 333);
    for (let i = 0; i < 50; i++) {
      const p = { x: Math.random() * 1000, y: Math.random() * 618 };
      const q = textureToPaper(rect, paperToTexture(rect, p));
      assert.ok(Math.abs(q.x - p.x) < 1e-9 && Math.abs(q.y - p.y) < 1e-9);
    }
  });
});

describe("three-way merge", () => {
  const [a, b, c, d, e] = ["aaaa", "bbbb", "cccc", "dddd", "eeee"].map((id) => stroke(id));

  it("keeps additions from both sides", () => {
    const base = [a!];
    const merged = mergeOps(base, [a!, b!], [a!, c!]);
    assert.deepEqual(ids(merged), ["aaaa", "cccc", "bbbb"]);
  });

  it("honours an undo on our side", () => {
    assert.deepEqual(ids(mergeOps([a!, b!], [a!], [a!, b!, c!])), ["aaaa", "cccc"]);
  });

  it("honours an undo on their side", () => {
    assert.deepEqual(ids(mergeOps([a!, b!], [a!, b!, d!], [a!])), ["aaaa", "dddd"]);
  });

  it("keeps a clear and strokes added after it", () => {
    const cl = clear("clr1");
    const merged = mergeOps([a!], [a!, cl, e!], [a!, b!]);
    assert.deepEqual(ids(merged), ["aaaa", "bbbb", "clr1", "eeee"]);
    // Their concurrent stroke is hidden by our clear (it came before the clear in the merged order);
    // nothing is silently dropped from the log, so undoing the clear brings it back.
    assert.ok(merged.some((o) => o.id === "bbbb"));
  });

  it("is idempotent and stable", () => {
    const base = [a!];
    const ours = [a!, b!];
    const theirs = [a!, c!];
    const once = mergeOps(base, ours, theirs);
    assert.deepEqual(ids(mergeOps(theirs, once, once)), ids(once));
    assert.deepEqual(ids(mergeOps(base, once, theirs)), ids(once));
  });

  it("degenerates gracefully without a known base", () => {
    // Unknown ancestor: base = our last synced state (here: empty) → nothing is deleted.
    assert.deepEqual(ids(mergeOps([], [a!, b!], [c!])), ["cccc", "aaaa", "bbbb"]);
  });

  it("drops tombstoned ops from both sides", () => {
    // A third client deleted bbbb; theirs is a write-back from a client that never saw that.
    const merged = mergeOps([a!], [a!, c!], [a!, b!], new Set(["bbbb"]));
    assert.deepEqual(ids(merged), ["aaaa", "cccc"]);
    assert.deepEqual(ids(mergeOps([], [b!], [], new Set(["bbbb"]))), []);
  });

  it("reports what happened", () => {
    const s = mergeWithSummary([a!], [a!, b!], [a!, c!, d!]);
    assert.equal(s.remoteAdded, 2);
    assert.equal(s.localKept, 1);
  });
});

describe("ScribbleDocument history", () => {
  const paper = { w: 1000, h: 1000 };

  it("undo/redo works per transaction", () => {
    const doc = new ScribbleDocument(paper, []);
    doc.add([stroke("aaaa")]);
    doc.add([stroke("bbbb"), stroke("cccc")]);
    assert.ok(doc.undo());
    assert.deepEqual(ids(doc.ops), ["aaaa"]);
    assert.ok(doc.redo());
    assert.equal(doc.ops.length, 3);
    assert.equal(doc.ops[0]!.id, "aaaa");
    assert.equal(doc.canRedo, false);
    assert.ok(doc.undo(), "the redone group undoes as one transaction");
    assert.deepEqual(ids(doc.ops), ["aaaa"]);
  });

  it("a new edit drops the redo stack", () => {
    const doc = new ScribbleDocument(paper, []);
    doc.add([stroke("aaaa")]);
    doc.undo();
    doc.add([stroke("bbbb")]);
    assert.equal(doc.canRedo, false);
    assert.equal(doc.redo(), false);
  });

  it("undo reaches strokes loaded from storage", () => {
    const doc = new ScribbleDocument(paper, [stroke("aaaa"), stroke("bbbb")]);
    assert.ok(doc.canUndo);
    doc.undo();
    assert.deepEqual(ids(doc.ops), ["aaaa"]);
    assert.ok(doc.sessionChanged);
  });

  it("clear is undoable and a no-op on an empty picture", () => {
    const doc = new ScribbleDocument(paper, []);
    assert.equal(doc.clear(), null);
    doc.add([stroke("aaaa")]);
    const cl = doc.clear();
    assert.ok(cl);
    assert.deepEqual(doc.visibleStrokes(), []);
    doc.undo();
    assert.deepEqual(ids(doc.visibleStrokes()), ["aaaa"]);
  });

  it("skips history entries whose ops were removed remotely", () => {
    const doc = new ScribbleDocument(paper, []);
    doc.add([stroke("aaaa")]);
    doc.add([stroke("bbbb")]);
    doc.replace([stroke("aaaa"), stroke("xxxx")]); // remote undid bbbb and added xxxx
    assert.ok(doc.undo());
    assert.deepEqual(ids(doc.ops), ["xxxx"], "undo skips the vanished stroke and undoes aaaa");
  });

  it("revertedOps restores the session start but keeps remote additions", () => {
    const doc = new ScribbleDocument(paper, [stroke("aaaa"), stroke("bbbb")]);
    doc.undo(); // remove bbbb
    doc.add([stroke("mine")]);
    doc.replace([...doc.ops, stroke("them")]); // remote stroke merged in
    const reverted = doc.revertedOps();
    assert.equal(reverted.length, 3);
    assert.equal(reverted[0]!.id, "aaaa");
    assert.notEqual(reverted[1]!.id, "bbbb", "restored op gets a fresh id");
    assert.equal(reverted[2]!.id, "them");
  });

  it("resetSessionTracking makes the current log the new baseline", () => {
    const doc = new ScribbleDocument(paper, [stroke("aaaa")]);
    doc.add([stroke("bbbb")]);
    doc.resetSessionTracking();
    assert.equal(doc.sessionChanged, false);
    assert.deepEqual(ids(doc.revertedOps()), ["aaaa", "bbbb"]);
  });

  it("redo re-adds undone ops under fresh ids (deleted ids are never reused)", () => {
    const doc = new ScribbleDocument(paper, [stroke("aaaa")]);
    doc.undo();
    doc.redo();
    assert.equal(doc.ops.length, 1);
    assert.notEqual(doc.ops[0]!.id, "aaaa");
    assert.equal((doc.ops[0] as { color: string }).color, "#1f1b18");
    // The fresh copy can itself be undone and redone again.
    assert.ok(doc.undo());
    assert.equal(doc.ops.length, 0);
    assert.ok(doc.redo());
    assert.equal(doc.ops.length, 1);
    // Reverting brings the original back (again under a fresh id) and drops the copies.
    const reverted = doc.revertedOps();
    assert.equal(reverted.length, 1);
    assert.ok(!sameOpIds(reverted, doc.ops));
  });
});
