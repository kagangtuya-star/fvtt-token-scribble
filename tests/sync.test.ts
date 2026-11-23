import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SyncEngine } from "../src/editor/sync.ts";
import type { SyncDetail, SyncStatus } from "../src/editor/sync.ts";
import { randomId } from "../src/model/ops.ts";
import { decodeDrawing, encodeDrawing } from "../src/model/serialize.ts";
import type { StoredDrawing } from "../src/model/serialize.ts";
import type { Op } from "../src/model/types.ts";
import { clear, FakeTimers, ids, stroke } from "./helpers.ts";

const PAPER = { w: 1000, h: 1000 };

/**
 * A simulated Foundry world: one server copy of the token flag and N clients,
 * each with its own local document copy. Like Foundry, every accepted update
 * is broadcast to all clients (the writer included) in order, and the writer's
 * `update()` promise resolves right after its own copy was updated.
 */
class World {
  readonly timers = new FakeTimers();
  stored: StoredDrawing;
  readonly clients: Client[] = [];
  writes = 0;

  constructor() {
    this.stored = encodeDrawing(PAPER, [], { rev: "init0001", parent: null, seq: 0, by: null, at: 0 });
  }

  addClient(name: string, opts: Partial<ClientOptions> = {}): Client {
    const c = new Client(this, name, { up: 30, down: 30, ...opts });
    this.clients.push(c);
    return c;
  }

  apply(stored: StoredDrawing, from: Client, resolve: () => void): void {
    this.writes++;
    this.stored = structuredClone(stored);
    for (const c of this.clients) c.deliver(structuredClone(stored), c === from ? resolve : null);
  }

  /** Someone unsets the flag (e.g. a macro): clients see a missing drawing. */
  removeFlag(): void {
    this.stored = null as unknown as StoredDrawing;
    for (const c of this.clients) c.deliver(null as unknown as StoredDrawing, null);
  }

  async run(ms: number): Promise<void> {
    await this.timers.advance(ms);
  }

  /** Flush everyone and run until no timers are left (bounded). */
  async quiesce(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      for (const c of this.clients) void c.engine.flush();
      await this.timers.advance(60_000);
      const settled = this.clients.every((c) => !c.engine.dirty && !c.engine.saving);
      if (settled && this.timers.pending === 0) return;
    }
    throw new Error("world did not settle");
  }
}

interface ClientOptions {
  up: number;
  down: number;
  /** Make the next writes fail: "reject" (server error) or "drop" (no answer). */
  fail?: "reject" | "drop" | null;
  canWrite?: boolean;
  maxBytes?: number;
}

class Client {
  readonly world: World;
  readonly name: string;
  readonly opts: ClientOptions;
  doc: StoredDrawing;
  ops: Op[];
  readonly engine: SyncEngine;
  readonly statuses: { status: SyncStatus; detail?: SyncDetail }[] = [];
  merges = 0;
  #lastDelivery = 0;

  constructor(world: World, name: string, opts: ClientOptions) {
    this.world = world;
    this.name = name;
    this.opts = opts;
    this.doc = structuredClone(world.stored);
    const initial = decodeDrawing(this.doc);
    if (!initial.ok) throw new Error("bad initial state");
    this.ops = initial.state.ops.slice();
    this.engine = new SyncEngine(
      PAPER,
      initial.state,
      {
        read: () => decodeDrawing(this.doc),
        write: (stored) => this.#write(stored),
        canWrite: () => this.opts.canWrite !== false,
        userId: name,
        maxBytes: opts.maxBytes ?? 384 * 1024,
      },
      {
        localOps: () => this.ops,
        applyMerged: (ops) => {
          this.ops = ops.slice();
        },
        status: (status, detail) => this.statuses.push({ status, detail }),
        merged: () => this.merges++,
      },
      { debounceMs: 1200, maxWaitMs: 5000, writeTimeoutMs: 15000, timers: world.timers },
    );
  }

  get status(): SyncStatus {
    return this.engine.status;
  }

  #write(stored: StoredDrawing): Promise<void> {
    const t = this.world.timers;
    return new Promise((resolve, reject) => {
      const fail = this.opts.fail;
      if (fail === "drop") return; // never answers
      t.setTimeout(() => {
        if (fail === "reject") reject(new Error("server said no"));
        else this.world.apply(stored, this, resolve);
      }, this.opts.up);
    });
  }

  deliver(stored: StoredDrawing, resolve: (() => void) | null): void {
    const t = this.world.timers;
    // Sockets are ordered: never deliver before an earlier message.
    const at = Math.max(this.#lastDelivery, t.now + this.opts.down);
    this.#lastDelivery = at;
    t.setTimeout(() => {
      this.doc = stored;
      this.engine.receive(decodeDrawing(stored));
      resolve?.();
    }, at - t.now);
  }

  draw(id: string = randomId()): string {
    this.ops = [...this.ops, stroke(id)];
    this.engine.touch();
    return id;
  }

  clearAll(): string {
    const op = clear();
    this.ops = [...this.ops, op];
    this.engine.touch();
    return op.id;
  }

  undo(id: string): void {
    this.ops = this.ops.filter((o) => o.id !== id);
    this.engine.touch();
  }
}

const serverIds = (w: World): string[] => {
  const r = decodeDrawing(w.stored);
  assert.ok(r.ok);
  return r.ok ? ids(r.state.ops) : [];
};

describe("SyncEngine", () => {
  it("debounces: many strokes, one write", async () => {
    const w = new World();
    const a = w.addClient("alice");
    for (let i = 0; i < 10; i++) {
      a.draw();
      await w.run(100);
    }
    assert.equal(w.writes, 0, "nothing written while drawing quickly");
    assert.equal(a.status, "dirty");
    await w.run(1300);
    await w.run(200);
    assert.equal(w.writes, 1);
    assert.equal(a.status, "saved");
    assert.equal(serverIds(w).length, 10);
  });

  it("writes at least every maxWait while the user keeps drawing", async () => {
    const w = new World();
    const a = w.addClient("alice");
    const realNow = Date.now;
    let fake = realNow();
    Date.now = () => fake; // the engine measures maxWait with Date.now
    try {
      for (let i = 0; i < 80; i++) {
        a.draw();
        fake += 100;
        await w.run(100);
      }
    } finally {
      Date.now = realNow;
    }
    assert.ok(w.writes >= 1, "a save happened during continuous drawing");
  });

  it("flush() saves immediately and resolves true once persisted", async () => {
    const w = new World();
    const a = w.addClient("alice");
    a.draw("aaaa");
    const p = a.engine.flush();
    await w.run(100);
    assert.equal(await p, true);
    assert.deepEqual(serverIds(w), ["aaaa"]);
    assert.equal(a.engine.dirty, false);
  });

  it("does not write when nothing changed (undo back to the saved state)", async () => {
    const w = new World();
    const a = w.addClient("alice");
    a.draw("aaaa");
    await w.quiesce();
    const writes = w.writes;
    a.draw("bbbb");
    a.undo("bbbb");
    await w.quiesce();
    assert.equal(w.writes, writes);
    assert.equal(a.status, "saved");
  });

  it("two users drawing at the same time both keep their strokes", async () => {
    const w = new World();
    const a = w.addClient("alice", { up: 40, down: 40 });
    const b = w.addClient("bob", { up: 45, down: 35 });
    a.draw("aaaa");
    b.draw("bbbb");
    // Force crossing writes: both flush before either sees the other.
    void a.engine.flush();
    void b.engine.flush();
    await w.quiesce();
    assert.deepEqual(new Set(serverIds(w)), new Set(["aaaa", "bbbb"]));
    assert.deepEqual(new Set(ids(a.ops)), new Set(["aaaa", "bbbb"]));
    assert.deepEqual(ids(a.ops), ids(b.ops), "same stacking order everywhere");
    assert.deepEqual(ids(a.ops), serverIds(w));
    assert.ok(a.merges + b.merges >= 1);
  });

  it("an undo on one client survives a concurrent stroke from another", async () => {
    const w = new World();
    const a = w.addClient("alice");
    const b = w.addClient("bob");
    a.draw("aaaa");
    await w.quiesce();
    assert.deepEqual(ids(b.ops), ["aaaa"]);
    a.undo("aaaa");
    b.draw("bbbb");
    void a.engine.flush();
    void b.engine.flush();
    await w.quiesce();
    assert.deepEqual(serverIds(w), ["bbbb"]);
    assert.deepEqual(ids(a.ops), ["bbbb"]);
    assert.deepEqual(ids(b.ops), ["bbbb"]);
  });

  it("heals a blind overwrite by a client that never saw our write", async () => {
    const w = new World();
    const a = w.addClient("alice");
    a.draw("aaaa");
    await w.quiesce();
    // Someone else (e.g. an older module version or a macro) overwrites the flag from stale data.
    const blind = encodeDrawing(PAPER, [stroke("zzzz")], { rev: "blind001", parent: "init0001", seq: 1, by: "mallory", at: 0 });
    w.apply(blind, a, () => {});
    await w.quiesce();
    assert.deepEqual(new Set(serverIds(w)), new Set(["aaaa", "zzzz"]));
  });

  it("goes offline on timeout, keeps the strokes and retries", async () => {
    const w = new World();
    const a = w.addClient("alice", { fail: "drop" });
    a.draw("aaaa");
    await w.run(1300);
    await w.run(15_100);
    assert.equal(a.status, "offline");
    assert.deepEqual(a.statuses.at(-1)?.detail, { kind: "timeout" });
    assert.deepEqual(ids(a.ops), ["aaaa"], "nothing lost locally");
    a.opts.fail = null;
    await w.run(40_000);
    assert.equal(a.status, "saved");
    assert.deepEqual(serverIds(w), ["aaaa"]);
  });

  it("reports server errors and retries with backoff", async () => {
    const w = new World();
    const a = w.addClient("alice", { fail: "reject" });
    a.draw("aaaa");
    await w.run(1300);
    await w.run(100);
    assert.equal(a.status, "error");
    assert.equal(a.statuses.at(-1)?.detail?.kind, "network");
    const before = w.writes;
    a.opts.fail = null;
    await w.run(2100);
    await w.run(200);
    assert.equal(w.writes, before + 1);
    assert.equal(a.status, "saved");
  });

  it("refuses to write without permission (re-checked at save time)", async () => {
    const w = new World();
    const a = w.addClient("alice");
    a.draw("aaaa");
    a.opts.canWrite = false;
    assert.equal(await flushAndRun(w, a), false);
    assert.equal(a.status, "error");
    assert.deepEqual(a.statuses.at(-1)?.detail, { kind: "permission" });
    assert.equal(w.writes, 0);
  });

  it("refuses to exceed the storage budget", async () => {
    const w = new World();
    const a = w.addClient("alice", { maxBytes: 600 });
    for (let i = 0; i < 20; i++) a.draw();
    assert.equal(await flushAndRun(w, a), false);
    assert.deepEqual(a.statuses.at(-1)?.detail, { kind: "budget" });
    assert.equal(w.writes, 0);
  });

  it("ignores unreadable incoming data instead of merging garbage", async () => {
    const w = new World();
    const a = w.addClient("alice");
    a.draw("aaaa");
    a.engine.receive({ ok: false, reason: "corrupt" });
    a.engine.receive({ ok: false, reason: "version" });
    assert.deepEqual(ids(a.ops), ["aaaa"]);
  });

  it("a removed flag deletes saved strokes but keeps unsaved local ones", async () => {
    const w = new World();
    const a = w.addClient("alice");
    a.draw("aaaa");
    await w.quiesce();
    a.draw("bbbb"); // not saved yet
    w.removeFlag();
    await w.quiesce();
    assert.deepEqual(serverIds(w), ["bbbb"]);
    assert.deepEqual(ids(a.ops), ["bbbb"]);
  });

  it("a stroke undone by one user is not resurrected by another user's merge write-back", async () => {
    const w = new World();
    const a = w.addClient("alice", { up: 20, down: 20 });
    const b = w.addClient("bob", { up: 20, down: 300 }); // bob hears about changes late
    a.draw("xxxx");
    await w.quiesce();
    b.draw("yyyy");
    void b.engine.flush(); // bob writes from the state that still contains xxxx…
    a.undo("xxxx");
    void a.engine.flush(); // …while alice deletes it
    await w.quiesce();
    assert.deepEqual(serverIds(w), ["yyyy"]);
    assert.deepEqual(ids(a.ops), ["yyyy"]);
    assert.deepEqual(ids(b.ops), ["yyyy"]);
  });

  it("does nothing after dispose", async () => {
    const w = new World();
    const a = w.addClient("alice");
    a.engine.dispose();
    a.draw("aaaa");
    await w.run(10_000);
    assert.equal(w.writes, 0);
  });

  it("randomised: three clients converge without losing any stroke", async () => {
    for (let seed = 1; seed <= 80; seed++) {
      const rnd = mulberry32(seed);
      const w = new World();
      const clients = ["a", "b", "c"].map((n) => w.addClient(n, { up: 10 + rnd() * 200, down: 10 + rnd() * 200 }));
      const drawn = new Map<string, Client>();
      const undone = new Set<string>();
      for (let step = 0; step < 120; step++) {
        const c = clients[Math.floor(rnd() * clients.length)]!;
        const r = rnd();
        if (r < 0.55) drawn.set(c.draw(), c);
        else if (r < 0.6) drawn.set(c.clearAll(), c);
        else if (r < 0.7) {
          // Undo one of this client's own visible strokes.
          const own = c.ops.filter((o) => drawn.get(o.id) === c);
          const victim = own.at(-1);
          if (victim) {
            c.undo(victim.id);
            undone.add(victim.id);
          }
        } else if (r < 0.8) void c.engine.flush();
        await w.run(Math.floor(rnd() * 900));
      }
      await w.quiesce();
      const expected = [...drawn.keys()].filter((id) => !undone.has(id)).sort();
      const onServer = serverIds(w);
      assert.deepEqual([...onServer].sort(), expected, `seed ${seed}: server content`);
      for (const c of clients) {
        assert.deepEqual(ids(c.ops), onServer, `seed ${seed}: client ${c.name} matches server order`);
        assert.equal(c.status, "saved", `seed ${seed}: client ${c.name} status`);
      }
    }
  });
});

async function flushAndRun(w: World, c: Client): Promise<boolean> {
  const p = c.engine.flush();
  await w.run(1000);
  return p;
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
