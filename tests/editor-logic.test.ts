import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandForKey, isPassThroughKey } from "../src/editor/keymap.ts";
import type { KeyLike } from "../src/editor/keymap.ts";
import { defaultToolState, normalizeColor, rememberColor, sanitizeToolState } from "../src/editor/tool-state.ts";
import { BRUSHES, DEFAULT_PALETTE } from "../src/engine/brushes.ts";

const key = (code: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  code,
  key: "",
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe("keymap", () => {
  it("maps tools, toggles, sizes and colours by physical key", () => {
    assert.deepEqual(commandForKey(key("KeyP")), { type: "tool", tool: "pen" });
    assert.deepEqual(commandForKey(key("KeyE")), { type: "tool", tool: "eraser" });
    assert.deepEqual(commandForKey(key("KeyV")), { type: "mirror" });
    assert.deepEqual(commandForKey(key("BracketRight")), { type: "size", direction: 1 });
    assert.deepEqual(commandForKey(key("Digit1")), { type: "color", index: 0 });
    assert.deepEqual(commandForKey(key("Digit0")), { type: "color", index: 9 });
  });

  it("maps history with Ctrl and Cmd", () => {
    assert.deepEqual(commandForKey(key("KeyZ", { ctrlKey: true })), { type: "undo" });
    assert.deepEqual(commandForKey(key("KeyZ", { metaKey: true, shiftKey: true })), { type: "redo" });
    assert.deepEqual(commandForKey(key("KeyY", { ctrlKey: true })), { type: "redo" });
    assert.equal(commandForKey(key("KeyZ", { ctrlKey: true, altKey: true })), null);
  });

  it("finishes with Enter/Escape and opens help with ?", () => {
    assert.deepEqual(commandForKey(key("Escape")), { type: "done" });
    assert.deepEqual(commandForKey(key("NumpadEnter")), { type: "done" });
    assert.deepEqual(commandForKey(key("Slash", { shiftKey: true })), { type: "help" });
  });

  it("ignores Shift/Alt chords so they cannot trigger tools", () => {
    assert.equal(commandForKey(key("KeyP", { shiftKey: true })), null);
    assert.equal(commandForKey(key("KeyP", { altKey: true })), null);
    assert.equal(commandForKey(key("KeyC", { ctrlKey: true })), null);
  });

  it("lets modifiers and function keys through to Foundry", () => {
    for (const c of ["ShiftLeft", "ControlRight", "AltLeft", "MetaLeft", "F5", "F12"]) assert.ok(isPassThroughKey(key(c)), c);
    for (const c of ["KeyW", "Space", "Delete", "Tab", "ArrowUp"]) assert.equal(isPassThroughKey(key(c)), false, c);
  });
});

describe("tool state", () => {
  it("sanitises garbage to defaults", () => {
    for (const raw of [null, 42, "x", [], { tool: "laser", color: "red", sizes: { pen: "big" }, opacity: { pen: 7 } }]) {
      assert.deepEqual(sanitizeToolState(raw), defaultToolState());
    }
  });

  it("keeps valid values and clamps sizes", () => {
    const s = sanitizeToolState({
      tool: "brush",
      color: "#123456",
      recent: ["#abcdef", "bad", "#000000", "#111111", "#222222", "#333333", "#444444"],
      sizes: { pen: 9999, eraser: 12 },
      opacity: { marker: 0.5 },
      thinning: { pen: 0.2, marker: 0.7 },
      mirror: true,
    });
    assert.equal(s.tool, "brush");
    assert.equal(s.color, "#123456");
    assert.equal(s.recent.length, 5);
    assert.equal(s.sizes.pen, BRUSHES.pen.maxSize);
    assert.equal(s.sizes.eraser, 12);
    assert.equal(s.opacity.marker, 0.5);
    assert.equal(s.thinning.pen, 0.2);
    assert.equal(s.thinning.marker, BRUSHES.marker.thinning, "tools without pressure keep their thinning");
    assert.equal(s.mirror, true);
  });

  it("remembers custom colours most-recent-first without palette duplicates", () => {
    const s = defaultToolState();
    rememberColor(s, DEFAULT_PALETTE[2]!);
    assert.deepEqual(s.recent, []);
    for (const c of ["#000001", "#000002", "#000001"]) rememberColor(s, c);
    assert.deepEqual(s.recent, ["#000001", "#000002"]);
  });

  it("normalises colour input", () => {
    assert.equal(normalizeColor(" #ABCDEF "), "#abcdef");
    assert.equal(normalizeColor("#fA0"), "#ffaa00");
    assert.equal(normalizeColor("red"), null);
    assert.equal(normalizeColor("#12345"), null);
  });
});
