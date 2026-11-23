import { MODULE_ID } from "../constants.ts";
import { generation, rootElement, tokenToolRecord, notify } from "./compat.ts";
import { createScribbleToken, mayCreateTokens, placement } from "./create.ts";
import { canUseFiles } from "./files.ts";
import { esc, t } from "./i18n.ts";
import { presence } from "./presence.ts";
import { portraitTarget, tokenTarget } from "./replace.ts";
import type { ReplaceTarget } from "./replace.ts";
import { openReplaceEditor, restoreTarget } from "./replace-window.ts";
import type { ReplaceWindow } from "./replace-window.ts";
import { EditSession } from "./session.ts";
import { canEditToken, hasDrawingFlag } from "./store.ts";

/**
 * Entry points into the editors: Token HUD buttons, scene control tool,
 * keybindings, and (replace mode) the actor directory and actor sheets.
 */

/** Open replace mode, finishing an in-place session first (the two never run together). */
export async function openReplace(target: ReplaceTarget): Promise<ReplaceWindow | null> {
  if (EditSession.current) await EditSession.current.end();
  return openReplaceEditor(target);
}

/** Replace mode is offered where the user could actually use it. */
const offersReplace = (target: ReplaceTarget): boolean => target.canModify() && canUseFiles();

export function registerHud(): void {
  Hooks.on("renderTokenHUD", (hud: { object?: FoundryToken | null; close(): unknown }, html: unknown) => {
    try {
      const root = rootElement(html);
      const token = hud.object;
      if (!root || !token || EditSession.current) return;
      if (!canEditToken(token.document)) return;
      root.querySelectorAll(".ts-hud-btn").forEach((el) => el.remove()); // partial re-renders
      const doc = token.document;
      const editors = doc.parent?.id && doc.id ? presence.editorsOf(doc.parent.id, doc.id) : [];
      const label = t(hasDrawingFlag(doc) ? "Hud.Edit" : "Hud.Draw");
      const tip = editors.length ? `${esc(label)}<br>${esc(t("Hud.Busy", { names: editors.map((u) => u.name).join(", ") }))}` : esc(label);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `control-icon ts-hud-btn${editors.length ? " ts-busy" : ""}`;
      btn.setAttribute("aria-label", label);
      btn.dataset.tooltipHtml = tip;
      btn.innerHTML = `<i class="fa-solid fa-pen-nib" inert></i>`;
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void hud.close();
        void EditSession.start(token);
      });
      const column = root.querySelector(".col.left") ?? root;
      column.append(btn);

      // Replace mode: bake into a new image file (right-click restores the original).
      const target = tokenTarget(doc);
      if (offersReplace(target)) {
        const restorable = !!target.record();
        const rLabel = t("Hud.Replace");
        const rep = document.createElement("button");
        rep.type = "button";
        rep.className = "control-icon ts-hud-btn ts-hud-replace";
        rep.setAttribute("aria-label", rLabel);
        rep.dataset.tooltipHtml = restorable ? `${esc(rLabel)}<br>${esc(t("Hud.ReplaceRestore"))}` : esc(rLabel);
        rep.innerHTML = `<i class="fa-solid fa-image" inert></i>`;
        rep.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          void hud.close();
          void openReplace(target);
        });
        rep.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!restorable) return;
          void hud.close();
          void restoreTarget(target);
        });
        column.append(rep);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | Token HUD integration failed`, err);
    }
  });
}

/** A context-menu entry in the shape of the running core (v14 renamed the keys). */
function contextEntry(
  label: string,
  iconClass: string,
  visible: (li: HTMLElement) => boolean,
  run: (li: HTMLElement) => void,
): Record<string, unknown> {
  const iconHtml = `<i class="${iconClass}"></i>`;
  if (generation() >= 14) {
    return { label, icon: iconHtml, visible, onClick: (_event: Event, li: HTMLElement) => run(li) };
  }
  return { name: label, icon: iconHtml, condition: visible, callback: (li: HTMLElement) => run(li) };
}

function actorOf(li: HTMLElement): FoundryActor | null {
  const id = li.closest<HTMLElement>("[data-entry-id]")?.dataset.entryId;
  return (id && game.actors?.get(id)) || null;
}

/** Replace-mode entries for actor portraits: directory context menu and sheet headers. */
export function registerPortraitReplace(): void {
  Hooks.on("getActorContextOptions", (_app: unknown, options: unknown) => {
    if (!Array.isArray(options)) return;
    options.push(
      contextEntry(
        t("Replace.MenuPortrait"),
        "fa-solid fa-image-portrait",
        (li) => {
          const actor = actorOf(li);
          return !!actor && offersReplace(portraitTarget(actor));
        },
        (li) => {
          const actor = actorOf(li);
          if (actor) void openReplace(portraitTarget(actor));
        },
      ),
      contextEntry(
        t("Replace.MenuRestorePortrait"),
        "fa-solid fa-clock-rotate-left",
        (li) => {
          const actor = actorOf(li);
          return !!actor && !!portraitTarget(actor).record() && actor.canUserModify(game.user, "update");
        },
        (li) => {
          const actor = actorOf(li);
          if (actor) void restoreTarget(portraitTarget(actor));
        },
      ),
    );
  });

  // ApplicationV2 actor sheets (core and most v13+ systems).
  Hooks.on("getHeaderControlsActorSheetV2", (app: { document?: FoundryActor }, controls: unknown) => {
    const actor = app.document;
    if (!actor || !Array.isArray(controls) || !offersReplace(portraitTarget(actor))) return;
    controls.push({
      icon: "fa-solid fa-image-portrait",
      label: "TOKEN_SCRIBBLE.Replace.MenuPortrait",
      action: `${MODULE_ID}-replace`,
      onClick: () => void openReplace(portraitTarget(actor)),
    });
  });

  // Legacy (ApplicationV1) actor sheets that some systems still use.
  Hooks.on("getActorSheetHeaderButtons", (app: { actor?: FoundryActor; object?: FoundryActor }, buttons: unknown) => {
    const actor = app.actor ?? app.object;
    if (!actor || !Array.isArray(buttons) || !offersReplace(portraitTarget(actor))) return;
    buttons.unshift({
      label: t("Replace.SheetButton"),
      class: `${MODULE_ID}-replace`,
      icon: "fa-solid fa-image-portrait",
      onclick: () => void openReplace(portraitTarget(actor)),
    });
  });
}

export function registerControls(): void {
  Hooks.on("getSceneControlButtons", (controls: unknown) => {
    const tools = tokenToolRecord(controls);
    if (!tools) return;
    tools[MODULE_ID] = {
      name: MODULE_ID,
      title: "TOKEN_SCRIBBLE.Controls.Create",
      icon: "fa-solid fa-pen-nib",
      order: Object.keys(tools).length + 1,
      button: true,
      visible: mayCreateTokens(),
      onChange: () => {
        if (placement.active) placement.stop();
        else placement.start();
      },
    };
  });
}

function targetToken(): FoundryToken | null {
  const controlled = canvas.tokens?.controlled ?? [];
  if (controlled.length === 1) return controlled[0]!;
  const hovered = (canvas.tokens as unknown as { hover?: FoundryToken | null }).hover;
  return hovered ?? null;
}

export function registerKeybindings(): void {
  game.keybindings.register(MODULE_ID, "create", {
    name: "TOKEN_SCRIBBLE.Keys.Create.Name",
    hint: "TOKEN_SCRIBBLE.Keys.Create.Hint",
    editable: [{ key: "KeyN" }],
    restricted: false,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL,
    onDown: () => {
      if (!canvas.ready || EditSession.current) return false;
      if (!mayCreateTokens()) {
        notify("warn", t("Notify.NoCreatePermission"));
        return true;
      }
      void createScribbleToken();
      return true;
    },
  });
  game.keybindings.register(MODULE_ID, "replace", {
    name: "TOKEN_SCRIBBLE.Keys.Replace.Name",
    hint: "TOKEN_SCRIBBLE.Keys.Replace.Hint",
    editable: [{ key: "KeyB", modifiers: ["Shift"] }],
    restricted: false,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL,
    onDown: () => {
      if (!canvas.ready || EditSession.current) return false;
      const token = targetToken();
      if (!token) {
        notify("info", t("Notify.SelectFirst"));
        return true;
      }
      void openReplace(tokenTarget(token.document));
      return true;
    },
  });
  game.keybindings.register(MODULE_ID, "edit", {
    name: "TOKEN_SCRIBBLE.Keys.Edit.Name",
    hint: "TOKEN_SCRIBBLE.Keys.Edit.Hint",
    editable: [{ key: "KeyB" }],
    restricted: false,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL,
    onDown: () => {
      if (!canvas.ready || EditSession.current) return false;
      const token = targetToken();
      if (!token) {
        notify("info", t("Notify.SelectFirst"));
        return true;
      }
      void EditSession.start(token);
      return true;
    },
  });
}
