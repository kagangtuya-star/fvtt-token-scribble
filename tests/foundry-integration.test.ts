/**
 * Loads the real module entry point (src/main.ts) against a recorded, minimal
 * stand-in of the Foundry client API and checks what the module registers.
 *
 * This is NOT a substitute for running inside Foundry VTT: it verifies the
 * module's side of the contract (hook names, setting/keybinding definitions,
 * scene-control shape for v13+, socket payload validation, permission calls),
 * not Foundry's behaviour. perfect-freehand is replaced by a stub here so the
 * test runs without node_modules.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { before, describe, it } from "node:test";
import { encodeDrawing } from "../src/model/serialize.ts";
import { stroke } from "./helpers.ts";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "perfect-freehand") {
      return { url: "data:text/javascript,export function getStroke(){return []}", shortCircuit: true };
    }
    return next(specifier, context);
  },
});

type Fn = (...args: unknown[]) => unknown;
const hooks = new Map<string, Fn[]>();
const settings = new Map<string, Record<string, unknown>>();
const keybindings = new Map<string, Record<string, unknown>>();
const socketHandlers = new Map<string, Fn>();
const emitted: unknown[] = [];
const called: string[] = [];
const notifications: [string, string][] = [];
const mod: { api?: Record<string, unknown> } = {};
const ME = "userAAAAAAAAAAAA";
const OTHER = "userBBBBBBBBBBBB";

function on(name: string, fn: Fn): number {
  const list = hooks.get(name) ?? [];
  list.push(fn);
  hooks.set(name, list);
  return list.length;
}

function fire(name: string, ...args: unknown[]): void {
  for (const fn of hooks.get(name) ?? []) fn(...args);
}

const g = globalThis as Record<string, unknown>;
g.Hooks = {
  on,
  once: on,
  off: () => {},
  callAll: (name: string) => called.push(name),
};
g.CONST = { KEYBINDING_PRECEDENCE: { PRIORITY: 0, NORMAL: 1, DEFERRED: 2 } };
const users = new Map([
  [ME, { id: ME, name: "Me", isGM: false, active: true, can: () => true }],
  [OTHER, { id: OTHER, name: "Other", isGM: false, active: true, can: () => true }],
]);
g.game = {
  release: { generation: 13 },
  version: "13.351",
  user: users.get(ME),
  users,
  modules: new Map([["token-scribble", mod]]),
  i18n: { lang: "en", localize: (k: string) => k, format: (k: string) => k },
  settings: {
    register: (ns: string, key: string, def: Record<string, unknown>) => settings.set(`${ns}.${key}`, def),
    get: (ns: string, key: string) => settings.get(`${ns}.${key}`)?.default,
    set: async () => {},
  },
  keybindings: { register: (ns: string, key: string, def: Record<string, unknown>) => keybindings.set(`${ns}.${key}`, def) },
  socket: { on: (ev: string, fn: Fn) => socketHandlers.set(ev, fn), emit: (_ev: string, msg: unknown) => emitted.push(msg) },
};
g.canvas = { ready: false };
g.ui = {
  notifications: {
    info: (m: string) => notifications.push(["info", m]),
    warn: (m: string) => notifications.push(["warn", m]),
    error: (m: string) => notifications.push(["error", m]),
  },
};
g.window = globalThis;
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  },
});
// Presence keeps a sweep interval; don't let it hold the test process open.
const realSetInterval = globalThis.setInterval;
g.setInterval = ((fn: () => void, ms: number) => realSetInterval(fn, ms).unref()) as typeof setInterval;

describe("Foundry integration (mocked API)", () => {
  before(async () => {
    await import("../src/main.ts");
    fire("init");
    fire("ready");
  });

  it("registers its hooks", () => {
    for (const name of [
      "init",
      "ready",
      "renderTokenHUD",
      "getSceneControlButtons",
      "drawToken",
      "refreshToken",
      "updateToken",
      "destroyToken",
      "canvasTearDown",
      "userConnected",
      "getActorContextOptions",
      "getHeaderControlsActorSheetV2",
      "getActorSheetHeaderButtons",
    ]) {
      assert.ok(hooks.has(name), `hook ${name}`);
    }
    assert.ok(called.includes("token-scribble.ready"));
  });

  it("adds replace-mode entries to the actor directory in the running core's shape", () => {
    const options: Record<string, unknown>[] = [];
    fire("getActorContextOptions", {}, options);
    assert.equal(options.length, 2);
    // v13 (the mocked generation) uses name/condition/callback; v14 label/visible/onClick.
    for (const o of options) {
      assert.equal(typeof o.name, "string");
      assert.equal(typeof o.condition, "function");
      assert.equal(typeof o.callback, "function");
      assert.match(String(o.icon), /^<i class="fa-solid /);
    }
  });

  it("only offers replace mode on sheets when files may be uploaded", () => {
    const actor = { id: "a1", name: "A", img: "a.png", flags: {}, canUserModify: () => true };
    const controls: Record<string, unknown>[] = [];
    const g2 = globalThis as Record<string, unknown>;
    g2.foundry ??= { applications: { api: {} } };
    const saved = g2.CONFIG ?? {};
    g2.CONFIG = { ux: { FilePicker: { browse() {}, createDirectory() {}, upload() {} } } };
    try {
      fire("getHeaderControlsActorSheetV2", { document: actor }, controls);
      assert.equal(controls.length, 1);
      assert.equal(controls[0]!.label, "TOKEN_SCRIBBLE.Replace.MenuPortrait");
      assert.equal(typeof controls[0]!.onClick, "function");
      const denied: unknown[] = [];
      fire("getHeaderControlsActorSheetV2", { document: { ...actor, canUserModify: () => false } }, denied);
      assert.equal(denied.length, 0, "no permission → no button");
    } finally {
      g2.CONFIG = saved;
    }
    const none: unknown[] = [];
    fire("getHeaderControlsActorSheetV2", { document: actor }, none);
    assert.equal(none.length, 0, "no FilePicker → no button");
  });

  it("registers settings with sensible scopes", () => {
    const max = settings.get("token-scribble.maxStorageKB")!;
    assert.equal(max.scope, "world");
    assert.equal(max.restricted, true);
    assert.equal(max.default, 384);
    assert.equal(settings.get("token-scribble.createHidden")!.scope, "world");
    for (const key of ["pressureMode", "autoFocus", "toolState", "dockPosition"]) {
      assert.equal(settings.get(`token-scribble.${key}`)!.scope, "client", key);
    }
    assert.equal(settings.get("token-scribble.toolState")!.config, false);
    for (const [key, def] of settings) {
      if (def.config !== false) {
        assert.match(String(def.name), /^TOKEN_SCRIBBLE\.Settings\./, key);
        assert.match(String(def.hint), /^TOKEN_SCRIBBLE\.Settings\./, key);
      }
    }
  });

  it("registers rebindable keys that do not collide with core defaults", () => {
    const create = keybindings.get("token-scribble.create")!;
    const edit = keybindings.get("token-scribble.edit")!;
    const replace = keybindings.get("token-scribble.replace")!;
    assert.deepEqual(create.editable, [{ key: "KeyN" }]);
    assert.deepEqual(edit.editable, [{ key: "KeyB" }]);
    assert.deepEqual(replace.editable, [{ key: "KeyB", modifiers: ["Shift"] }]);
    assert.equal((replace.onDown as Fn)(), false);
    // Keys bound by Foundry core v13 by default (no modifiers).
    const core = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "KeyT", "KeyR", "KeyU", "KeyC", "KeyF", "Space", "Tab", "Delete", "Backspace", "Escape", "BracketLeft", "BracketRight", "Backquote"]);
    for (const kb of [create, edit]) {
      for (const { key } of kb.editable as { key: string }[]) assert.ok(!core.has(key), key);
      assert.equal(typeof kb.onDown, "function");
    }
    // Without a ready canvas the handlers decline (return false) so others may act.
    assert.equal((create.onDown as Fn)(), false);
    assert.equal((edit.onDown as Fn)(), false);
  });

  it("adds a button tool to the v13+ token scene controls", () => {
    const controls = { tokens: { name: "tokens", tools: { select: { name: "select", order: 1 }, target: { name: "target", order: 2 } } } };
    fire("getSceneControlButtons", controls);
    const tool = (controls.tokens.tools as Record<string, Record<string, unknown>>)["token-scribble"]!;
    assert.equal(tool.name, "token-scribble");
    assert.equal(tool.button, true);
    assert.equal(tool.order, 3);
    assert.equal(typeof tool.onChange, "function");
    assert.equal(tool.title, "TOKEN_SCRIBBLE.Controls.Create");
    assert.doesNotThrow(() => fire("getSceneControlButtons", {}));
  });

  it("exposes a small public API", () => {
    const api = mod.api!;
    for (const k of ["edit", "create", "finish", "canEdit", "read", "replace", "restore"]) assert.equal(typeof api[k], "function", k);
    assert.equal(api.editing, null);
  });

  it("checks permissions through TokenDocument#canUserModify with a flag-only change", () => {
    const calls: unknown[][] = [];
    const doc = {
      id: "tokenAAAAAAAAAAA",
      parent: { id: "sceneAAAAAAAAAAA" },
      flags: {},
      canUserModify: (...args: unknown[]) => (calls.push(args), true),
    };
    assert.equal((mod.api!.canEdit as Fn)(doc), true);
    assert.equal(calls[0]![0], users.get(ME));
    assert.equal(calls[0]![1], "update");
    assert.deepEqual(calls[0]![2], { flags: { "token-scribble": { drawing: null } } });
    assert.equal((mod.api!.canEdit as Fn)({ ...doc, canUserModify: () => false }), false);
    assert.equal((mod.api!.canEdit as Fn)({ ...doc, parent: null }), false, "tokens outside a scene are not editable");
  });

  it("reads drawings from token flags", () => {
    const stored = encodeDrawing({ w: 1000, h: 1000 }, [stroke("aaaa")], { rev: "r0000001", parent: null, seq: 1, by: ME, at: 0 });
    const res = (mod.api!.read as Fn)({ flags: { "token-scribble": { drawing: JSON.parse(JSON.stringify(stored)) } } }) as { ok: boolean };
    assert.equal(res.ok, true);
    assert.deepEqual((mod.api!.read as Fn)({ flags: {} }), { ok: false, reason: "missing" });
  });

  it("validates presence messages on the module socket", async () => {
    const { presence } = await import("../src/foundry/presence.ts");
    const handler = socketHandlers.get("module.token-scribble");
    assert.ok(handler);
    const scene = "sceneAAAAAAAAAAA";
    const token = "tokenAAAAAAAAAAA";
    handler!({ type: "presence", scene, token, user: OTHER, state: "start" });
    assert.deepEqual(presence.editorsOf(scene, token).map((u) => u.id), [OTHER]);
    // Ignored: own echo, unknown users, malformed ids, unknown states.
    handler!({ type: "presence", scene, token: "tokenBBBBBBBBBBB", user: ME, state: "start" });
    handler!({ type: "presence", scene, token: "tokenBBBBBBBBBBB", user: "userCCCCCCCCCCCC", state: "start" });
    handler!({ type: "presence", scene: "<img>", token, user: OTHER, state: "start" });
    handler!({ type: "presence", scene, token: "tokenBBBBBBBBBBB", user: OTHER, state: "draw" });
    handler!(null);
    assert.deepEqual(presence.editorsOf(scene, "tokenBBBBBBBBBBB"), []);
    fire("userConnected", users.get(OTHER), false);
    assert.deepEqual(presence.editorsOf(scene, token), [], "disconnecting users are dropped");
    // Hidden tokens are never announced, visible ones carry ids only.
    presence.announce(scene, token, true);
    assert.equal(emitted.length, 0);
    presence.announce(scene, token, false);
    assert.deepEqual(emitted.at(-1), { type: "presence", scene, token, user: ME, state: "start" });
    presence.end();
    assert.equal((emitted.at(-1) as { state: string }).state, "end");
  });
});
