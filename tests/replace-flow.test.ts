/**
 * Replace-mode document flow (backup → upload → update → restore) against an
 * in-memory stand-in of Foundry's FilePicker and document updates. Verifies
 * what this module asks the server to do, not the server itself.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MODULE_ID } from "../src/constants.ts";
import { applyReplacement, BackupError, restoreOriginal, tokenTarget, portraitTarget, prototypeTarget } from "../src/foundry/replace.ts";

/* ---------------- fake server ---------------- */

const dirs = new Set<string>();
const files = new Map<string, Blob>();
const calls: string[] = [];

const filePicker: FilePickerStatic = {
  async browse(_source, target) {
    calls.push(`browse ${target}`);
    if (!dirs.has(target)) throw new Error(`Directory ${target} does not exist`);
    return { target, dirs: [], files: [] };
  },
  async createDirectory(_source, target) {
    calls.push(`mkdir ${target}`);
    if (dirs.has(target)) throw new Error("EEXIST");
    dirs.add(target);
    return {};
  },
  async upload(_source, path, file) {
    calls.push(`upload ${path}/${file.name}`);
    if (!dirs.has(path)) return false;
    files.set(`${path}/${file.name}`, file);
    return { path: `${path}/${file.name}` };
  },
};

const g = globalThis as Record<string, unknown>;
g.game = { world: { id: "w" }, user: { id: "u1", can: () => true } };
g.CONFIG = { ux: { FilePicker: filePicker } };
g.foundry = { applications: { api: {}, apps: {} } };
g.fetch = async (url: string, init?: { method?: string }) => {
  const blob = files.get(url);
  if (!blob) return new Response(null, { status: 404, statusText: "Not Found" });
  return init?.method === "HEAD"
    ? new Response(null, { status: 200 })
    : new Response(blob, { status: 200, headers: { "content-type": blob.type } });
};

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = (o[k] ??= {}) as Record<string, unknown>;
  o[keys.at(-1)!] = value;
}

function makeDoc<T extends Record<string, unknown>>(data: T) {
  const updates: Record<string, unknown>[] = [];
  const doc = {
    ...data,
    updates,
    canUserModify: () => true,
    async update(change: Record<string, unknown>) {
      updates.push(change);
      for (const [k, v] of Object.entries(change)) setPath(doc as unknown as Record<string, unknown>, k, v);
    },
  };
  return doc;
}

const replacedOf = (d: { flags: Record<string, Record<string, unknown> | undefined> }) =>
  d.flags[MODULE_ID]?.replaced as Record<string, unknown> | null | undefined;

function setup(src = "tokens/goblin.webp") {
  const actor = makeDoc({
    id: "a1",
    name: "Goblin",
    img: "portraits/goblin.png",
    flags: {} as Record<string, Record<string, unknown> | undefined>,
    prototypeToken: { flags: {} as Record<string, Record<string, unknown> | undefined>, texture: { src } },
  });
  const token = makeDoc({
    id: "t1",
    name: "Goblin Scout",
    texture: { src },
    flags: {} as Record<string, Record<string, unknown> | undefined>,
    actorLink: true,
    actor,
    baseActor: actor,
  });
  return { actor, token };
}

beforeEach(() => {
  dirs.clear();
  files.clear();
  calls.length = 0;
  dirs.add("worlds/w");
  files.set("tokens/goblin.webp", new Blob(["ORIGINAL"], { type: "image/webp" }));
  files.set("portraits/goblin.png", new Blob(["PORTRAIT"], { type: "image/png" }));
});

const png = () => new Blob(["NEW"], { type: "image/png" });

describe("applyReplacement", () => {
  it("backs the original up, uploads the result and points the token at it", async () => {
    const { token } = setup();
    const target = tokenTarget(token as unknown as FoundryTokenDocument);
    const path = await applyReplacement(target, png(), { prototype: false, bakedOverlay: false, now: 1000 });
    assert.equal(path, "worlds/w/token-scribble/tokens/goblin-scout-t1-rs.png");
    assert.equal(token.texture.src, path);
    const backup = "worlds/w/token-scribble/backups/goblin-t1-rs.webp";
    assert.equal(await files.get(backup)?.text(), "ORIGINAL", "byte-identical backup in the world folder");
    assert.deepEqual(replacedOf(token), {
      v: 1,
      kind: "token",
      original: "tokens/goblin.webp",
      backup,
      current: path,
      at: 1000,
      by: "u1",
    });
    assert.ok(
      calls.indexOf(`upload worlds/w/token-scribble/backups/goblin-t1-rs.webp`) < calls.indexOf(`upload ${path}`),
      "backup first",
    );
    assert.equal(token.updates.length, 1, "one document update");
  });

  it("keeps the first backup when the image is replaced again", async () => {
    const { token } = setup();
    const target = tokenTarget(token as unknown as FoundryTokenDocument);
    await applyReplacement(target, png(), { prototype: false, bakedOverlay: false, now: 1000 });
    const first = replacedOf(token)!;
    const second = await applyReplacement(target, png(), { prototype: false, bakedOverlay: false, now: 2000 });
    const rec = replacedOf(token)!;
    assert.equal(rec.original, "tokens/goblin.webp");
    assert.equal(rec.backup, first.backup);
    assert.equal(rec.current, second);
    assert.equal([...files.keys()].filter((k) => k.includes("/backups/")).length, 1);
  });

  it("takes a new backup when the image was changed by hand since", async () => {
    const { token } = setup();
    const target = tokenTarget(token as unknown as FoundryTokenDocument);
    await applyReplacement(target, png(), { prototype: false, bakedOverlay: false, now: 1000 });
    files.set("tokens/hobgoblin.png", new Blob(["HOB"], { type: "image/png" }));
    token.texture.src = "tokens/hobgoblin.png";
    await applyReplacement(target, png(), { prototype: false, bakedOverlay: false, now: 2000 });
    assert.equal(replacedOf(token)!.original, "tokens/hobgoblin.png");
  });

  it("changes nothing when the original cannot be backed up", async () => {
    const { token } = setup("tokens/missing.webp");
    const target = tokenTarget(token as unknown as FoundryTokenDocument);
    await assert.rejects(applyReplacement(target, png(), { prototype: false, bakedOverlay: false }), BackupError);
    assert.equal(token.updates.length, 0);
    assert.equal(token.texture.src, "tokens/missing.webp");
    assert.ok(!calls.some((c) => c.startsWith("upload")), "no generated image uploaded either");
  });

  it("bakes the in-place drawing and gives it back on restore", async () => {
    const { token } = setup();
    const drawing = { v: 1, w: 1000, h: 1000, ops: [], rev: "r", par: null, seq: 1, by: null, at: 0 };
    token.flags[MODULE_ID] = { drawing };
    const target = tokenTarget(token as unknown as FoundryTokenDocument);
    await applyReplacement(target, png(), { prototype: false, bakedOverlay: true, now: 1000 });
    assert.equal(token.flags[MODULE_ID]!.drawing, null, "overlay cleared: it is in the image now");
    assert.deepEqual(replacedOf(token)!.drawing, drawing);
    await restoreOriginal(target);
    assert.deepEqual(token.flags[MODULE_ID]!.drawing, drawing);
    assert.equal(token.texture.src, "tokens/goblin.webp");
    assert.equal(replacedOf(token), null);
  });

  it("updates and restores the prototype token together with a linked token", async () => {
    const { token, actor } = setup();
    const target = tokenTarget(token as unknown as FoundryTokenDocument);
    const path = await applyReplacement(target, png(), { prototype: true, bakedOverlay: false, now: 1000 });
    assert.equal(actor.prototypeToken.texture.src, path);
    assert.equal((actor.prototypeToken.flags[MODULE_ID] as Record<string, unknown>).replaced !== undefined, true);
    assert.equal(replacedOf(token)!.proto, true);
    await restoreOriginal(target);
    assert.equal(actor.prototypeToken.texture.src, "tokens/goblin.webp");
  });

  it("leaves a prototype alone that was changed to something else since", async () => {
    const { token, actor } = setup();
    const target = tokenTarget(token as unknown as FoundryTokenDocument);
    await applyReplacement(target, png(), { prototype: true, bakedOverlay: false, now: 1000 });
    actor.prototypeToken.texture.src = "tokens/elsewhere.png";
    await restoreOriginal(target);
    assert.equal(actor.prototypeToken.texture.src, "tokens/elsewhere.png");
  });

  it("backs up and restores a different prototype original independently", async () => {
    const { token, actor } = setup();
    files.set("tokens/default.webp", new Blob(["PROTOTYPE"], { type: "image/webp" }));
    actor.prototypeToken.texture.src = "tokens/default.webp";
    const target = tokenTarget(token as unknown as FoundryTokenDocument);
    await applyReplacement(target, png(), { prototype: true, bakedOverlay: false, now: 1000 });
    const proto = prototypeTarget(actor as unknown as FoundryActor);
    assert.equal(proto.record()!.original, "tokens/default.webp");
    assert.equal(await files.get(proto.record()!.backup!)?.text(), "PROTOTYPE");
    await restoreOriginal(target);
    assert.equal(token.texture.src, "tokens/goblin.webp");
    assert.equal(actor.prototypeToken.texture.src, "tokens/default.webp");
    assert.equal(actor.img, "portraits/goblin.png");
  });

  it("changes neither document when the prototype backup fails", async () => {
    const { token, actor } = setup();
    actor.prototypeToken.texture.src = "tokens/missing.webp";
    await assert.rejects(applyReplacement(tokenTarget(token as unknown as FoundryTokenDocument), png(), {
      prototype: true, bakedOverlay: false, now: 1000,
    }), BackupError);
    assert.equal(token.updates.length, 0);
    assert.equal(actor.updates.length, 0);
    assert.ok(!calls.some((c) => c.startsWith("upload worlds/w/token-scribble/tokens/")));
  });

  it("keeps portrait, prototype and scene token replacement records separate", async () => {
    const { token, actor } = setup();
    const portrait = portraitTarget(actor as unknown as FoundryActor);
    const proto = prototypeTarget(actor as unknown as FoundryActor);
    const portraitPath = await applyReplacement(portrait, png(), { prototype: false, bakedOverlay: false, now: 1000 });
    const protoPath = await applyReplacement(proto, png(), { prototype: false, bakedOverlay: false, now: 1001 });
    assert.equal(actor.img, portraitPath);
    assert.equal(actor.prototypeToken.texture.src, protoPath);
    assert.equal(token.texture.src, "tokens/goblin.webp");
    assert.equal(portrait.record()!.kind, "portrait");
    assert.equal(proto.record()!.kind, "token");
    await restoreOriginal(proto);
    assert.equal(actor.prototypeToken.texture.src, "tokens/goblin.webp");
    assert.equal(actor.img, portraitPath);
    await restoreOriginal(portrait);
    assert.equal(actor.img, "portraits/goblin.png");
  });
});

describe("replace target switching", () => {
  it("resolves a scene token's world portrait and an actor's prototype", () => {
    const { token, actor } = setup();
    const target = tokenTarget(token as unknown as FoundryTokenDocument);
    assert.equal(target.related("token")!.key, target.key);
    assert.equal(target.related("portrait")!.key, portraitTarget(actor as unknown as FoundryActor).key);
    assert.equal(target.related("portrait")!.related("token")!.key, prototypeTarget(actor as unknown as FoundryActor).key);
    assert.notEqual(target.key, prototypeTarget(actor as unknown as FoundryActor).key);
  });

  it("uses the base actor for unlinked tokens and has no portrait for actorless tokens", () => {
    const { token, actor } = setup();
    token.actorLink = false;
    token.actor = { ...actor, img: "synthetic.png" };
    const target = tokenTarget(token as unknown as FoundryTokenDocument);
    assert.equal(target.related("portrait")!.src(), actor.img);
    const standalone = { ...token, baseActor: null, actor: null };
    assert.equal(tokenTarget(standalone as unknown as FoundryTokenDocument).related("portrait"), null);
  });

  it("checks portrait permission independently from scene-token permission", () => {
    const { token, actor } = setup();
    actor.canUserModify = () => false;
    const target = tokenTarget(token as unknown as FoundryTokenDocument);
    assert.equal(target.canModify(), true);
    assert.equal(target.related("portrait")!.canModify(), false);
    assert.equal(target.prototypeActor(), null);
  });

  it("distinguishes token ids shared by different scenes", () => {
    const { token } = setup();
    const a = tokenTarget({ ...token, parent: { id: "s1" } } as unknown as FoundryTokenDocument);
    const b = tokenTarget({ ...token, parent: { id: "s2" } } as unknown as FoundryTokenDocument);
    assert.notEqual(a.key, b.key);
  });
});

describe("restoreOriginal", () => {
  it("falls back to the world-folder backup when the original file is gone", async () => {
    const { actor } = setup();
    const target = portraitTarget(actor as unknown as FoundryActor);
    await applyReplacement(target, png(), { prototype: false, bakedOverlay: false, now: 1000 });
    const backup = replacedOf(actor)!.backup as string;
    assert.ok(backup.startsWith("worlds/w/token-scribble/backups/"));
    assert.equal(actor.img, "worlds/w/token-scribble/portraits/goblin-a1-rs.png");
    files.delete("portraits/goblin.png");
    const restored = await restoreOriginal(target);
    assert.equal(restored, backup);
    assert.equal(actor.img, backup);
  });

  it("does nothing without an active record", async () => {
    const { token } = setup();
    assert.equal(await restoreOriginal(tokenTarget(token as unknown as FoundryTokenDocument)), null);
    assert.equal(token.updates.length, 0);
  });
});
