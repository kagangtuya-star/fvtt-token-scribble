import { MODULE_ID } from "./constants.ts";
import { generation, isSupported, notify } from "./foundry/compat.ts";
import { createScribbleToken, placement } from "./foundry/create.ts";
import { pruneDrafts } from "./foundry/drafts.ts";
import { t } from "./foundry/i18n.ts";
import { openReplace, registerControls, registerHud, registerKeybindings, registerPortraitReplace } from "./foundry/integration.ts";
import { painter } from "./foundry/painter.ts";
import { presence } from "./foundry/presence.ts";
import { portraitTarget, tokenTarget } from "./foundry/replace.ts";
import type { ReplaceTarget } from "./foundry/replace.ts";
import { restoreTarget } from "./foundry/replace-window.ts";
import { EditSession } from "./foundry/session.ts";
import { registerSettings } from "./foundry/settings.ts";
import { canEditToken, readDrawing } from "./foundry/store.ts";

/** Token / TokenDocument → its image; Actor → its portrait. */
function replaceTargetOf(target: FoundryToken | FoundryTokenDocument | FoundryActor): ReplaceTarget {
  if ("document" in target) return tokenTarget(target.document);
  if ("texture" in target) return tokenTarget(target as FoundryTokenDocument);
  return portraitTarget(target as FoundryActor);
}

/** Public API: `game.modules.get("token-scribble").api`. */
const api = {
  /** Start editing a token (Token placeable or TokenDocument). */
  edit(target: FoundryToken | FoundryTokenDocument): Promise<EditSession | null> {
    const token = "document" in target ? target : target.object;
    return EditSession.start(token);
  },
  /** Create a blank scribble token at canvas coordinates (defaults to the mouse) and edit it. */
  create(at?: { x: number; y: number }) {
    return createScribbleToken(at);
  },
  /** Finish the current session (saving). */
  finish(): Promise<void> {
    return EditSession.current?.end() ?? Promise.resolve();
  },
  get editing(): FoundryToken | null {
    return EditSession.current?.token ?? null;
  },
  /** Can the current user edit this token's drawing (native document permission)? */
  canEdit(doc: FoundryTokenDocument): boolean {
    return canEditToken(doc);
  },
  /** Decoded drawing data (read-only view) for macros and other modules. */
  read(doc: FoundryTokenDocument) {
    return readDrawing(doc);
  },
  /**
   * Replace mode: open the window editor that bakes the drawing into a new
   * image file. A Token/TokenDocument replaces its image, an Actor its portrait.
   */
  replace(target: FoundryToken | FoundryTokenDocument | FoundryActor) {
    return openReplace(replaceTargetOf(target));
  },
  /** Undo replace mode: put the original image back (asks for confirmation). */
  restore(target: FoundryToken | FoundryTokenDocument | FoundryActor): Promise<boolean> {
    return restoreTarget(replaceTargetOf(target));
  },
};

Hooks.once("init", () => {
  // Older cores have a different scene-control/HUD API: stay inert there.
  if (!isSupported()) return;
  registerSettings();
  registerKeybindings();
  registerHud();
  registerPortraitReplace();
  registerControls();
  painter.init();
});

Hooks.once("ready", () => {
  if (!isSupported()) {
    notify("warn", t("Notify.Unsupported"));
    console.warn(`${MODULE_ID} | Foundry generation ${generation()} is not supported`);
    return;
  }
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = api;
  presence.init();
  pruneDrafts();
  Hooks.callAll(`${MODULE_ID}.ready`, api);
});

// A scene switch while placing should not leave the placement mode armed.
Hooks.on("canvasTearDown", () => placement.stop());
