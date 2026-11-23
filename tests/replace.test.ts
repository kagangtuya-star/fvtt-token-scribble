import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activeRecord,
  backupFileName,
  decodeReplaceRecord,
  extensionOf,
  extForMime,
  folderFor,
  imageFileName,
  isVectorSrc,
  isVideoSrc,
  MAX_OUTPUT_PX,
  outputSize,
  restoreSource,
  slug,
} from "../src/model/replace.ts";
import type { ReplaceRecord } from "../src/model/replace.ts";

const rec = (over: Partial<ReplaceRecord> = {}): ReplaceRecord => ({
  v: 1,
  kind: "token",
  original: "tokens/goblin.webp",
  backup: "worlds/w/token-scribble/backups/goblin-t1-abc.webp",
  current: "worlds/w/token-scribble/tokens/goblin-t1-abd.png",
  at: 1,
  by: "u1",
  ...over,
});

describe("replace record", () => {
  it("round-trips and rejects malformed data", () => {
    assert.deepEqual(
      decodeReplaceRecord(JSON.parse(JSON.stringify(rec({ proto: true, drawing: { v: 1 } })))),
      rec({ proto: true, drawing: { v: 1 } }),
    );
    assert.equal(decodeReplaceRecord(null), null);
    assert.equal(decodeReplaceRecord({ ...rec(), v: 2 }), null);
    assert.equal(decodeReplaceRecord({ ...rec(), kind: "tile" }), null);
    assert.equal(decodeReplaceRecord({ ...rec(), current: "" }), null);
    assert.equal(decodeReplaceRecord({ ...rec(), backup: 3 }), null);
    assert.deepEqual(decodeReplaceRecord({ ...rec(), backup: null })?.backup, null);
  });

  it("only applies while the document still shows the generated image", () => {
    const r = rec();
    assert.deepEqual(activeRecord(r, r.current), r);
    assert.equal(activeRecord(r, "tokens/other.png"), null, "image changed by hand since: stale");
    assert.equal(activeRecord(undefined, r.current), null);
  });
});

describe("replace paths", () => {
  it("keeps everything inside the world folder", () => {
    assert.equal(folderFor("my-world", "token"), "worlds/my-world/token-scribble/tokens");
    assert.equal(folderFor("my-world", "portrait"), "worlds/my-world/token-scribble/portraits");
    assert.equal(folderFor("my-world", "backup"), "worlds/my-world/token-scribble/backups");
  });

  it("builds portable file names", () => {
    assert.equal(slug("Goblin Scout #2", "x"), "goblin-scout-2");
    assert.equal(slug("Élan", "x"), "elan");
    assert.equal(slug("哥布林", "token"), "token", "non-Latin names fall back");
    assert.equal(imageFileName("Goblin Scout", "AbC123", 36 ** 3), "goblin-scout-abc123-1000.png");
    assert.equal(backupFileName("tokens/My%20Goblin.WEBP?v=3", "t1", 35), "my-goblin-t1-z.webp");
    assert.equal(backupFileName("https://example.com/img/avatar", "t1", 0, "png"), "avatar-t1-0.png");
    assert.equal(backupFileName("icons/x", "t1", 0), "x-t1-0.img");
  });

  it("recognises extensions and media types", () => {
    assert.equal(extensionOf("a/b.c/d.PNG#x"), "png");
    assert.equal(extensionOf("a/b.c/noext"), "");
    assert.ok(isVideoSrc("tokens/fire.webm"));
    assert.ok(!isVideoSrc("tokens/fire.webp"));
    assert.ok(isVectorSrc("icons/svg/mystery-man.svg"));
    assert.equal(extForMime("image/jpeg"), "jpg");
    assert.equal(extForMime("image/svg+xml"), "svg");
    assert.equal(extForMime("text/html"), "");
  });
});

describe("output size", () => {
  it("keeps the original pixel size of ordinary images", () => {
    assert.deepEqual(outputSize(400, 300, false), { w: 400, h: 300 });
  });

  it("upscales vector and tiny images, caps huge ones", () => {
    assert.deepEqual(outputSize(100, 100, true), { w: 512, h: 512 });
    assert.deepEqual(outputSize(64, 32, false), { w: 512, h: 256 });
    assert.deepEqual(outputSize(8000, 4000, false), { w: MAX_OUTPUT_PX, h: 2048 });
    assert.deepEqual(outputSize(0, 0, false), { w: 512, h: 512 }, "no image");
  });
});

describe("restore source", () => {
  it("prefers the original while it exists, then the backup", () => {
    assert.equal(restoreSource(rec(), true), "tokens/goblin.webp");
    assert.equal(restoreSource(rec(), false), rec().backup);
    assert.equal(restoreSource(rec({ backup: null }), false), "tokens/goblin.webp");
    assert.equal(restoreSource(rec({ original: "", backup: null }), false), "");
  });
});
