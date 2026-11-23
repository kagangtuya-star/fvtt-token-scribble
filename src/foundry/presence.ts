import { SOCKET_EVENT } from "../constants.ts";

/**
 * Edit presence ("who else is drawing on this token"). Purely informational:
 * messages carry ids only — never drawing content — and nothing received here
 * ever writes a document, so a forged message can at worst show a wrong badge.
 * Hidden tokens are never announced.
 */

interface PresenceMessage {
  type: "presence";
  scene: string;
  token: string;
  user: string;
  state: "start" | "beat" | "end";
}

const HEARTBEAT_MS = 15_000;
const EXPIRE_MS = 40_000;
const ID_RE = /^[A-Za-z0-9]{16}$/;

type Listener = () => void;

class PresenceTracker {
  /** `${scene}.${token}` → user id → last seen */
  readonly #editors = new Map<string, Map<string, number>>();
  readonly #listeners = new Set<Listener>();
  #mine: { scene: string; token: string } | null = null;
  #beat: ReturnType<typeof setInterval> | null = null;
  #sweep: ReturnType<typeof setInterval> | null = null;

  init(): void {
    game.socket.on(SOCKET_EVENT, (msg: unknown) => this.#receive(msg));
    Hooks.on("userConnected", (user: FoundryUser, connected: boolean) => {
      if (!connected) this.#dropUser(user.id);
    });
    this.#sweep = setInterval(() => this.#expire(), EXPIRE_MS / 2);
  }

  onChange(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emitChange(): void {
    for (const fn of this.#listeners) fn();
  }

  #receive(raw: unknown): void {
    const msg = raw as Partial<PresenceMessage> | null;
    if (!msg || msg.type !== "presence") return;
    if (![msg.scene, msg.token, msg.user].every((v) => typeof v === "string" && ID_RE.test(v))) return;
    if (msg.user === game.user.id || !game.users.get(msg.user!)) return;
    const key = `${msg.scene}.${msg.token}`;
    let users = this.#editors.get(key);
    if (msg.state === "end") {
      users?.delete(msg.user!);
      if (users?.size === 0) this.#editors.delete(key);
    } else if (msg.state === "start" || msg.state === "beat") {
      if (!users) this.#editors.set(key, (users = new Map()));
      users.set(msg.user!, Date.now());
    } else {
      return;
    }
    this.#emitChange();
  }

  #dropUser(userId: string): void {
    let changed = false;
    for (const [key, users] of this.#editors) {
      if (users.delete(userId)) changed = true;
      if (users.size === 0) this.#editors.delete(key);
    }
    if (changed) this.#emitChange();
  }

  #expire(): void {
    const now = Date.now();
    let changed = false;
    for (const [key, users] of this.#editors) {
      for (const [user, at] of users) {
        if (now - at > EXPIRE_MS) {
          users.delete(user);
          changed = true;
        }
      }
      if (users.size === 0) this.#editors.delete(key);
    }
    if (changed) this.#emitChange();
  }

  /** Other users currently editing the token. */
  editorsOf(sceneId: string, tokenId: string): FoundryUser[] {
    const users = this.#editors.get(`${sceneId}.${tokenId}`);
    if (!users) return [];
    return [...users.keys()].map((id) => game.users.get(id)).filter((u): u is FoundryUser => !!u && u.active !== false);
  }

  #send(state: PresenceMessage["state"]): void {
    if (!this.#mine) return;
    const msg: PresenceMessage = { type: "presence", scene: this.#mine.scene, token: this.#mine.token, user: game.user.id, state };
    game.socket.emit(SOCKET_EVENT, msg);
  }

  announce(sceneId: string, tokenId: string, hidden: boolean): void {
    this.end();
    if (hidden) return;
    this.#mine = { scene: sceneId, token: tokenId };
    this.#send("start");
    this.#beat = setInterval(() => this.#send("beat"), HEARTBEAT_MS);
  }

  end(): void {
    if (this.#beat) clearInterval(this.#beat);
    this.#beat = null;
    if (this.#mine) this.#send("end");
    this.#mine = null;
  }

  destroy(): void {
    this.end();
    if (this.#sweep) clearInterval(this.#sweep);
  }
}

export const presence = new PresenceTracker();
