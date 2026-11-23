import { BLANK_TEXTURE, FLAG_CREATED, FLAG_DRAWING, MODULE_ID, PAPER_LONG_SIDE } from "../constants.ts";
import { randomId } from "../model/ops.ts";
import { encodeDrawing } from "../model/serialize.ts";
import { boardElement, notify } from "./compat.ts";
import { t } from "./i18n.ts";
import { painter } from "./painter.ts";
import { EditSession } from "./session.ts";
import { getCreateHidden, getTokenSize } from "./settings.ts";
import { h } from "../ui/dom.ts";

/** Whether the current user may create tokens at all (decides UI visibility only). */
export function mayCreateTokens(): boolean {
  return game.user.isGM || game.user.can("TOKEN_CREATE");
}

function viewCenter(): { x: number; y: number } {
  return canvas.canvasCoordinatesFromClient({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
}

async function waitForToken(doc: FoundryTokenDocument, timeoutMs = 4000): Promise<FoundryToken | null> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const obj = doc.object;
    if (obj && !obj.destroyed && obj.mesh && painter.has(obj)) return obj;
    await new Promise((r) => setTimeout(r, 40));
  }
  return doc.object ?? null;
}

/**
 * Create a transparent "paper" token centred on `at` (canvas coordinates,
 * defaults to the mouse position) and start drawing on it. Permission is
 * checked with Foundry's own document rules before anything is sent.
 */
export async function createScribbleToken(at?: { x: number; y: number }, options: { snap?: boolean } = {}): Promise<FoundryToken | null> {
  if (!canvas.ready || !canvas.scene) {
    notify("warn", t("Notify.NoScene"));
    return null;
  }
  if (EditSession.current) await EditSession.current.end();
  const scene = canvas.scene;
  const units = getTokenSize();
  const gridPx = canvas.grid.size;
  const size = units * gridPx;
  const pos = at ?? canvas.mousePosition ?? viewCenter();
  let x = pos.x - size / 2;
  let y = pos.y - size / 2;
  if (options.snap !== false && canvas.grid.type !== CONST.GRID_TYPES.GRIDLESS) {
    const snapped = canvas.grid.getSnappedPoint({ x, y }, { mode: CONST.GRID_SNAPPING_MODES.TOP_LEFT_CORNER, resolution: units < 1 ? 2 : 1 });
    x = snapped.x;
    y = snapped.y;
  }
  const paper = { w: PAPER_LONG_SIDE, h: PAPER_LONG_SIDE };
  const data = {
    name: t("Token.DefaultName"),
    x: Math.round(x),
    y: Math.round(y),
    width: units,
    height: units,
    hidden: game.user.isGM && getCreateHidden(),
    actorLink: false,
    texture: { src: BLANK_TEXTURE, fit: "contain" },
    flags: {
      [MODULE_ID]: {
        [FLAG_CREATED]: true,
        [FLAG_DRAWING]: encodeDrawing(paper, [], { rev: randomId(), parent: null, seq: 0, by: game.user.id, at: Date.now() }),
      },
    },
  };
  const TokenDocument = CONFIG.Token.documentClass;
  const probe = new TokenDocument(data, { parent: scene });
  if (!probe.canUserModify(game.user, "create")) {
    notify("warn", t("Notify.NoCreatePermission"));
    return null;
  }
  let created: FoundryTokenDocument | undefined;
  try {
    [created] = await scene.createEmbeddedDocuments("Token", [data]);
  } catch (err) {
    console.error(`${MODULE_ID} | token creation failed`, err);
    notify("error", t("Notify.CreateFailed"));
    return null;
  }
  if (!created) return null;
  const token = await waitForToken(created);
  if (!token) return null;
  token.control({ releaseOthers: true });
  await EditSession.start(token, { autoFocus: true });
  return token;
}

/**
 * "Click to place" mode used by the scene-control button: the next left click
 * on the map creates the token there; Esc or right click cancels.
 */
class PlacementMode {
  #abort: AbortController | null = null;
  #hint: HTMLElement | null = null;

  get active(): boolean {
    return this.#abort !== null;
  }

  start(): void {
    if (this.#abort || !canvas.ready) return;
    const board = boardElement();
    if (!board) return;
    this.#abort = new AbortController();
    const opts = { capture: true, signal: this.#abort.signal };
    board.classList.add("ts-board-placing");
    this.#hint = h("div", { class: "ts-hint", role: "status", "data-ts-ui": true }, t("Placement.Hint"));
    document.body.append(this.#hint);
    window.addEventListener(
      "pointerdown",
      (e) => {
        if (e.target !== board) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.button !== 0) {
          this.stop();
          return;
        }
        const point = canvas.canvasCoordinatesFromClient({ x: e.clientX, y: e.clientY });
        const snap = !e.shiftKey;
        this.stop();
        void createScribbleToken(point, { snap });
      },
      opts,
    );
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.code !== "Escape") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.stop();
      },
      opts,
    );
    window.addEventListener("contextmenu", (e) => e.target === board && e.preventDefault(), opts);
  }

  stop(): void {
    this.#abort?.abort();
    this.#abort = null;
    this.#hint?.remove();
    this.#hint = null;
    boardElement()?.classList.remove("ts-board-placing");
  }
}

export const placement = new PlacementMode();
