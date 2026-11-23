import { MODULE_ID } from "../constants.ts";
import { DEFAULT_PALETTE } from "../engine/brushes.ts";
import { freehandOutliner } from "../engine/freehand.ts";
import { Raster } from "../engine/raster.ts";
import { drawingToSvg } from "../engine/svg-export.ts";
import { ScribbleEditor } from "../editor/editor.ts";
import { InputController } from "../editor/input.ts";
import type { Command } from "../editor/keymap.ts";
import { SyncEngine } from "../editor/sync.ts";
import type { SyncDetail, SyncStatus } from "../editor/sync.ts";
import { drawingExtent } from "../model/extent.ts";
import { mergeOps } from "../model/merge.ts";
import { isPictureEmpty, paperForAspect, sameOpIds, visibleStrokes } from "../model/ops.ts";
import { emptyState, encodeDrawing, storedSize } from "../model/serialize.ts";
import type { DrawingState, Op, Paper } from "../model/types.ts";
import { BrushCursor } from "../ui/cursor.ts";
import { Toolbar } from "../ui/toolbar.ts";
import type { MenuItem } from "../ui/toolbar.ts";
import { copyStrokes, readClipboard } from "./clipboard.ts";
import { boardElement, confirm, downloadBlob, notify, safeFilename, userColor } from "./compat.ts";
import { clearDraft, loadDraft, saveDraft } from "./drafts.ts";
import { esc, t } from "./i18n.ts";
import { painter } from "./painter.ts";
import { presence } from "./presence.ts";
import { replaceWindowOpen } from "./replace-window.ts";
import { getAutoFocus, getDockPosition, getMaxBytes, getPressureMode, getToolState, saveDockPosition, saveToolState } from "./settings.ts";
import {
  canEditToken,
  isLayerHidden,
  isScribbleToken,
  readDrawing,
  setLayerHidden,
  touchesModuleFlags,
  writeDrawing,
  writePrototypeDrawing,
} from "./store.ts";
import { TokenSurface } from "./surface.ts";

const measure = (paper: Paper) => (ops: readonly Op[]) =>
  storedSize(encodeDrawing(paper, ops, { rev: "0000000000", parent: "0000000000", seq: 0, by: "0000000000000000", at: Date.now() }));

/** Sync engines that keep watching a token for a short while after its session ended. */
const lingering = new Map<string, { sync: SyncEngine; timer: ReturnType<typeof setTimeout>; hook: number }>();
const LINGER_MS = 20_000;

/**
 * One editing session on one token: wires the editor core to Foundry
 * (rendering, input, persistence, presence, UI) and owns every resource it
 * creates, releasing all of them in {@link end}.
 */
export class EditSession {
  static #current: EditSession | null = null;
  static #starting = false;

  static get current(): EditSession | null {
    return EditSession.#current;
  }

  readonly token: FoundryToken;
  readonly doc: FoundryTokenDocument;
  readonly sceneId: string;
  readonly tokenId: string;
  readonly editor: ScribbleEditor;
  readonly #surface: TokenSurface;
  readonly #sync: SyncEngine;
  readonly #input: InputController;
  readonly #toolbar: Toolbar;
  readonly #cursor = new BrushCursor();
  readonly #outline = new PIXI.Graphics();
  readonly #hooks: [string, number][] = [];
  readonly #offs: (() => void)[] = [];
  #savedView: { x: number; y: number; scale: number } | null = null;
  #ending: Promise<void> | null = null;
  #draftTimer: ReturnType<typeof setTimeout> | null = null;
  #lastOutlineKey = "";
  #resTimer: ReturnType<typeof setTimeout> | null = null;
  #hover: { x: number; y: number; over: boolean } | null = null;

  /* -------------------------------------------- */
  /*  Entry points                                */
  /* -------------------------------------------- */

  /** Start editing `token`, ending any other session first. */
  static async start(token: FoundryToken | null | undefined, options: { autoFocus?: boolean } = {}): Promise<EditSession | null> {
    if (!token || !canvas.ready || EditSession.#starting) return null;
    // Both editors capture pointer and keyboard input: never run them together.
    if (replaceWindowOpen()) {
      notify("info", t("Replace.CloseFirst"));
      return null;
    }
    const current = EditSession.#current;
    if (current?.token === token) return current;
    EditSession.#starting = true;
    try {
      if (current) await current.end();
      return await EditSession.#create(token, options);
    } catch (err) {
      console.error(`${MODULE_ID} | could not start editing`, err);
      notify("error", t("Notify.StartFailed"));
      return null;
    } finally {
      EditSession.#starting = false;
    }
  }

  static async #create(token: FoundryToken, options: { autoFocus?: boolean }): Promise<EditSession | null> {
    const doc = token.document;
    if (token.isPreview || !doc?.id || !doc.parent?.id) return null;
    if (!token.mesh || token.mesh.destroyed) {
      notify("warn", t("Notify.NotReady"));
      return null;
    }
    if (!canEditToken(doc)) {
      notify("warn", t("Notify.NoPermission"));
      return null;
    }
    const read = readDrawing(doc);
    if (!read.ok && read.reason === "version") {
      notify("error", t("Notify.NewerFormat"));
      return null;
    }
    if (!read.ok && read.reason === "corrupt") {
      console.error(`${MODULE_ID} | drawing data on ${doc.uuid} is corrupt: ${read.detail ?? ""}`);
      const fresh = await confirm(t("Corrupt.Title"), `<p>${esc(t("Corrupt.Content"))}</p>`, t("Corrupt.Confirm"));
      if (!fresh) return null;
    }
    // A pending linger on this token hands over to the new session.
    const linger = lingering.get(doc.uuid);
    if (linger) {
      clearTimeout(linger.timer);
      Hooks.off("updateToken", linger.hook);
      await linger.sync.flush();
      linger.sync.dispose();
      lingering.delete(doc.uuid);
    }
    let initial: DrawingState;
    if (read.ok) initial = read.state;
    else {
      const tex = token.mesh.texture;
      const valid = tex && tex !== PIXI.Texture.EMPTY && tex.width > 1;
      initial = emptyState(valid ? paperForAspect(tex.width, tex.height) : paperForAspect(token.w, token.h));
    }
    const restored = await EditSession.#offerDraft(doc, initial);
    const session = new EditSession(token, initial, restored);
    EditSession.#current = session;
    session.#afterStart(options.autoFocus ?? getAutoFocus());
    return session;
  }

  static async #offerDraft(doc: FoundryTokenDocument, initial: DrawingState): Promise<Op[] | null> {
    const draft = loadDraft(doc.parent!.id!, doc.id!);
    if (!draft) return null;
    if (draft.paper.w !== initial.paper.w || draft.paper.h !== initial.paper.h || sameOpIds(draft.ops, initial.ops)) {
      clearDraft(doc.parent!.id!, doc.id!);
      return null;
    }
    const when = new Date(draft.at).toLocaleString(game.i18n.lang);
    const ok = await confirm(t("Draft.Title"), `<p>${esc(t("Draft.Content", { time: when }))}</p>`, t("Draft.Restore"));
    if (!ok) {
      clearDraft(doc.parent!.id!, doc.id!);
      return null;
    }
    if (draft.base === initial.rev) return draft.ops;
    // The document moved on since the draft was taken: keep both sides.
    const storedIds = new Set(initial.ops.map((o) => o.id));
    const common = draft.ops.filter((o) => storedIds.has(o.id));
    return mergeOps(common, draft.ops, initial.ops, new Set(initial.del));
  }

  /* -------------------------------------------- */
  /*  Construction                                */
  /* -------------------------------------------- */

  private constructor(token: FoundryToken, initial: DrawingState, restored: Op[] | null) {
    this.token = token;
    this.doc = token.document;
    this.sceneId = this.doc.parent!.id!;
    this.tokenId = this.doc.id!;
    const paper = initial.paper;
    this.#surface = new TokenSurface(token);

    this.editor = new ScribbleEditor({
      paper,
      ops: initial.ops,
      outliner: freehandOutliner,
      rasterPx: 512,
      tools: getToolState(),
      pressureMode: getPressureMode(),
      maxBytes: getMaxBytes(),
      measure: measure(paper),
      placeholder: isScribbleToken(this.doc),
    });

    // Rendering: the painter composites the live raster into the token mesh.
    painter.beginLive(token, {
      paper,
      raster: () => this.editor.raster,
      flush: () => this.editor.flush(),
    });
    this.editor.resizeRaster(this.#desiredRasterPx());

    this.#sync = new SyncEngine(
      paper,
      initial,
      {
        read: () => readDrawing(this.doc),
        write: (stored) => writeDrawing(this.doc, stored),
        canWrite: () => canEditToken(this.doc),
        userId: game.user.id,
        maxBytes: getMaxBytes(),
      },
      {
        localOps: () => this.editor.doc.ops,
        applyMerged: (ops) => this.editor.applyMerged(ops),
        status: (s, d) => this.#onSyncStatus(s, d),
        merged: ({ by }) => {
          const name = (by && game.users.get(by)?.name) || t("Toolbar.Someone");
          notify("info", t("Notify.Merged", { name }));
        },
      },
    );

    this.#toolbar = new Toolbar(
      this.editor,
      {
        t,
        palette: DEFAULT_PALETTE,
        screenPxPerUnit: () => this.#surface.screenPxPerUnit(),
        command: (cmd) => this.#command(cmd),
        done: () => void this.end(),
        menu: () => this.#menu(),
        initialPosition: getDockPosition(),
        savePosition: saveDockPosition,
      },
      this.doc.name || t("Toolbar.Untitled"),
    );

    this.#input = new InputController(this.editor, {
      isDrawTarget: (target) => target !== null && target === boardElement(),
      clientToPaper: (x, y) => this.#surface.clientToPaper(x, y),
      hover: (x, y, over) => this.#onHover(x, y, over),
      command: (cmd) => this.#command(cmd),
    });

    this.#offs.push(
      this.editor.on((e) => {
        if (e.type === "ops") this.#onOpsChanged();
        if (e.type === "budget") notify("warn", t("Notify.Budget", { max: Math.round(getMaxBytes() / 1024) }));
        if (e.type === "change") this.#refreshCursor();
      }),
    );

    if (restored) {
      this.editor.applyMerged(restored);
      this.#sync.touch();
    }
  }

  #afterStart(autoFocus: boolean): void {
    boardElement()?.classList.add("ts-board-drawing");
    this.#input.attach();
    canvas.controls.addChild(this.#outline);
    canvas.app.ticker.add(this.#tick, this);
    canvas.tokens.hud?.close();
    this.#on("updateToken", (doc: FoundryTokenDocument, changes: object) => {
      if (doc === this.doc && touchesModuleFlags(changes)) this.#sync.receive(readDrawing(doc));
      if (doc === this.doc && "name" in changes) this.#toolbar.setTitle(doc.name);
    });
    this.#on("deleteToken", (doc: FoundryTokenDocument) => {
      if (doc !== this.doc) return;
      notify("warn", t("Notify.Deleted"));
      void this.end({ save: false });
    });
    this.#on("canvasTearDown", () => void this.end({ restoreView: false }));
    this.#on("renderTokenHUD", () => canvas.tokens.hud?.close());
    this.#on("canvasPan", () => this.#onPan());
    const recheck = () => {
      if (!canEditToken(this.doc)) {
        notify("warn", t("Notify.PermissionLost"));
        void this.end({ save: false });
      }
    };
    this.#on("updateUser", recheck);
    this.#on("updateActor", recheck);
    this.#on("updateScene", recheck);
    this.#offs.push(presence.onChange(() => this.#refreshPeers()));
    presence.announce(this.sceneId, this.tokenId, this.doc.hidden);
    this.#refreshPeers();
    this.#onSyncStatus(this.#sync.dirty ? "dirty" : "saved");
    const others = presence.editorsOf(this.sceneId, this.tokenId);
    if (others.length) notify("info", t("Notify.AlsoEditing", { names: others.map((u) => u.name).join(", ") }));
    if (autoFocus) {
      const corners = this.#surface.corners();
      if (corners) {
        const screen = corners.map((c) => canvas.clientCoordinatesFromCanvas(c));
        const span = Math.max(...screen.map((p) => p.x)) - Math.min(...screen.map((p) => p.x));
        if (span < 220) void this.#toggleFocus();
      }
    }
  }

  #on(hook: string, fn: (...args: any[]) => void): void {
    this.#hooks.push([
      hook,
      Hooks.on(hook, (...args: unknown[]) => {
        try {
          fn(...args);
        } catch (err) {
          console.error(`${MODULE_ID} | session hook ${hook} failed`, err);
        }
      }),
    ]);
  }

  /* -------------------------------------------- */
  /*  Event handling                              */
  /* -------------------------------------------- */

  #onOpsChanged(): void {
    this.#sync.touch();
    if (this.#draftTimer) clearTimeout(this.#draftTimer);
    this.#draftTimer = setTimeout(() => {
      this.#draftTimer = null;
      if (this.#sync.dirty) saveDraft(this.sceneId, this.tokenId, this.editor.paper, this.#sync.synced.rev, this.editor.doc.ops);
    }, 150);
  }

  #onSyncStatus(status: SyncStatus, detail?: SyncDetail): void {
    let tip: string | undefined;
    if (detail?.kind === "permission") tip = t("Notify.NoPermission");
    else if (detail?.kind === "budget") tip = t("Notify.Budget", { max: Math.round(getMaxBytes() / 1024) });
    else if (detail?.kind === "timeout") tip = t("Status.offlineHint");
    else if (detail?.kind === "network") tip = t("Status.errorHint");
    this.#toolbar?.setStatus(status, tip);
    if (status === "saved") clearDraft(this.sceneId, this.tokenId);
    if (detail?.kind === "permission") {
      notify("error", t("Notify.PermissionLost"));
      void this.end({ save: false });
    }
  }

  #onHover(x: number, y: number, over: boolean): void {
    this.#hover = { x, y, over };
    this.#refreshCursor();
  }

  #refreshCursor(): void {
    const h = this.#hover;
    if (!h?.over) {
      this.#cursor.hide();
      return;
    }
    const tools = this.editor.tools;
    const mode = tools.tool === "eraser" ? "erase" : tools.tool === "fill" ? "fill" : "ink";
    const d = tools.tool === "fill" ? 10 : tools.sizes[tools.tool] * this.#surface.screenPxPerUnit();
    this.#cursor.update(h.x, h.y, d, mode, tools.color);
  }

  #refreshPeers(): void {
    const users = presence.editorsOf(this.sceneId, this.tokenId);
    this.#toolbar.setPeers(users.map((u) => ({ name: u.name, color: userColor(u) })));
  }

  #onPan(): void {
    this.#toolbar.refreshScale();
    this.#refreshCursor();
    if (this.#resTimer) clearTimeout(this.#resTimer);
    this.#resTimer = setTimeout(() => {
      this.#resTimer = null;
      const want = this.#desiredRasterPx();
      const have = this.editor.raster.requestedPx;
      if (!this.editor.isDrawing && (want > have * 1.35 || want < have / 2)) this.editor.resizeRaster(want);
    }, 300);
  }

  /** Raster size matching the paper's current on-screen size (with HiDPI and zoom headroom). */
  #desiredRasterPx(): number {
    const ppu = this.#surface.screenPxPerUnit();
    const paper = this.editor.paper;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const px = Math.max(paper.w, paper.h) * ppu * dpr * 1.25;
    return Math.round(Math.min(2048, Math.max(384, px)));
  }

  /** Per frame: keep the paper outline glued to the token while it moves/rotates. */
  readonly #tick = (): void => {
    const corners = this.#surface.corners();
    if (!corners) return;
    const key = corners.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(";") + `|${canvas.stage.scale.x.toFixed(3)}`;
    if (key === this.#lastOutlineKey) return;
    this.#lastOutlineKey = key;
    const g = this.#outline;
    const zoom = canvas.stage.scale.x || 1;
    g.clear();
    for (const [width, color, alpha] of [
      [3.5 / zoom, 0x000000, 0.45],
      [1.5 / zoom, 0xffffff, 0.9],
    ] as const) {
      g.lineStyle({ width, color, alpha, alignment: 0.5 });
      g.moveTo(corners[0]!.x, corners[0]!.y);
      for (let i = 1; i <= 4; i++) g.lineTo(corners[i % 4]!.x, corners[i % 4]!.y);
    }
  };

  /* -------------------------------------------- */
  /*  Commands                                    */
  /* -------------------------------------------- */

  #command(cmd: Command): void {
    const ed = this.editor;
    switch (cmd.type) {
      case "tool":
        ed.setTool(cmd.tool);
        break;
      case "color": {
        const c = DEFAULT_PALETTE[cmd.index];
        if (c) ed.setColor(c);
        break;
      }
      case "undo":
        ed.undo();
        break;
      case "redo":
        ed.redo();
        break;
      case "size":
        ed.stepSize(cmd.direction);
        break;
      case "mirror":
        ed.toggleMirror();
        break;
      case "focus":
        void this.#toggleFocus();
        break;
      case "help":
        this.#toolbar.showHelp();
        break;
      case "done":
        // A first Escape/Enter only closes an open popover (e.g. the shortcut help).
        if (!this.#toolbar.closePopover()) void this.end();
        break;
    }
  }

  async #toggleFocus(): Promise<void> {
    if (this.#savedView) {
      const v = this.#savedView;
      this.#savedView = null;
      this.#toolbar.setFocusActive(false);
      await canvas.animatePan({ ...v, duration: 350 });
      return;
    }
    const corners = this.#surface.corners();
    if (!corners) return;
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    const { min, max } = canvas.dimensions.scale;
    // Fit the paper into ~60% of the viewport (the dock sits below it).
    const target = Math.min((window.innerWidth * 0.6) / w, (window.innerHeight * 0.6) / h);
    const scale = Math.min(max, Math.max(min, target));
    this.#savedView = { x: canvas.stage.pivot.x, y: canvas.stage.pivot.y, scale: canvas.stage.scale.x };
    this.#toolbar.setFocusActive(true);
    await canvas.animatePan({ x: cx, y: cy + (h * 0.08), scale, duration: 400 });
  }

  #menu(): MenuItem[] {
    const doc = this.doc;
    const ed = this.editor;
    const clip = readClipboard();
    const empty = isPictureEmpty(ed.doc.ops);
    const hidden = isLayerHidden(doc);
    const actor = doc.actor;
    const canProto = !!actor && actor.canUserModify(game.user, "update");
    return [
      {
        id: "copy",
        label: t("Menu.Copy"),
        icon: "fa-solid fa-copy",
        disabled: empty,
        run: () => {
          const strokes = visibleStrokes(ed.doc.ops);
          copyStrokes(ed.paper, strokes);
          notify("info", t("Notify.Copied", { count: strokes.length }));
        },
      },
      {
        id: "paste",
        label: t("Menu.Paste"),
        icon: "fa-solid fa-paste",
        disabled: !clip?.strokes.length,
        run: () => {
          if (clip && ed.paste(clip.strokes, clip.paper)) notify("info", t("Notify.Pasted", { count: clip.strokes.length }));
        },
      },
      {
        id: "png",
        label: t("Menu.ExportPng"),
        icon: "fa-solid fa-image",
        divider: true,
        disabled: empty,
        run: () => this.#exportPng(false),
      },
      {
        id: "png-full",
        label: t("Menu.ExportPngFull"),
        icon: "fa-solid fa-chess-pawn",
        disabled: empty,
        run: () => this.#exportPng(true),
      },
      {
        id: "svg",
        label: t("Menu.ExportSvg"),
        icon: "fa-solid fa-bezier-curve",
        disabled: empty,
        run: () => {
          const svg = drawingToSvg(ed.paper, ed.doc.ops, freehandOutliner);
          downloadBlob(new Blob([svg], { type: "image/svg+xml" }), `${safeFilename(doc.name)}-scribble.svg`);
        },
      },
      {
        id: "layer",
        label: t(hidden ? "Menu.ShowLayer" : "Menu.HideLayer"),
        icon: hidden ? "fa-solid fa-eye" : "fa-solid fa-eye-slash",
        divider: true,
        run: () => {
          void setLayerHidden(doc, !hidden)
            .then(() => notify("info", t(hidden ? "Notify.LayerShown" : "Notify.LayerHidden")))
            .catch((err: unknown) => {
              console.error(err);
              notify("error", t("Notify.SaveFailed"));
            });
        },
      },
      ...(actor
        ? [
            {
              id: "prototype",
              label: t("Menu.Prototype"),
              icon: "fa-solid fa-user-pen",
              disabled: !canProto || empty,
              run: () => void this.#applyToPrototype(),
            },
          ]
        : []),
      {
        id: "clear",
        label: t("Menu.Clear"),
        icon: "fa-solid fa-broom",
        divider: true,
        disabled: empty,
        run: () => {
          if (ed.clear()) notify("info", t("Notify.Cleared"));
        },
      },
      {
        id: "revert",
        label: t("Menu.Revert"),
        icon: "fa-solid fa-clock-rotate-left",
        danger: true,
        disabled: !ed.doc.sessionChanged,
        run: () => void this.#revert(),
      },
      {
        id: "help",
        label: t("Menu.Help"),
        icon: "fa-solid fa-keyboard",
        divider: true,
        run: () => this.#toolbar.showHelp(),
      },
    ];
  }

  #exportPng(full: boolean): void {
    const ed = this.editor;
    let source: HTMLCanvasElement | OffscreenCanvas | null;
    if (full) source = painter.extractComposite(this.token);
    else source = Raster.renderStandalone(ed.paper, ed.doc.ops, 1024, freehandOutliner, undefined, drawingExtent(ed.doc.ops, ed.paper));
    if (!source) return;
    const name = `${safeFilename(this.doc.name)}-${full ? "token" : "scribble"}.png`;
    if (source instanceof HTMLCanvasElement) {
      source.toBlob((blob) => blob && downloadBlob(blob, name), "image/png");
    } else {
      void source.convertToBlob({ type: "image/png" }).then((blob) => downloadBlob(blob, name));
    }
  }

  async #applyToPrototype(): Promise<void> {
    const actor = this.doc.actor;
    if (!actor) return;
    const ok = await confirm(t("Prototype.Title"), `<p>${esc(t("Prototype.Content", { name: actor.name }))}</p>`);
    if (!ok) return;
    try {
      const stored = encodeDrawing(this.editor.paper, this.editor.doc.ops, {
        rev: "proto" + Date.now().toString(36),
        parent: null,
        seq: 0,
        by: game.user.id,
        at: Date.now(),
      });
      await writePrototypeDrawing(actor, stored);
      notify("info", t("Notify.PrototypeSaved", { name: actor.name }));
    } catch (err) {
      console.error(`${MODULE_ID} |`, err);
      notify("error", t("Notify.SaveFailed"));
    }
  }

  async #revert(): Promise<void> {
    const ok = await confirm(t("Revert.Title"), `<p>${esc(t("Revert.Content"))}</p>`, t("Revert.Confirm"));
    if (!ok || this.#ending) return;
    this.editor.applyRevert(this.editor.doc.revertedOps());
    this.editor.doc.resetSessionTracking();
    await this.#sync.flush();
    notify("info", t("Notify.Reverted"));
  }

  /* -------------------------------------------- */
  /*  Teardown                                    */
  /* -------------------------------------------- */

  /** End the session, saving by default. Safe to call repeatedly. */
  end(options: { save?: boolean; restoreView?: boolean } = {}): Promise<void> {
    this.#ending ??= this.#teardown(options.save !== false, options.restoreView !== false);
    return this.#ending;
  }

  async #teardown(save: boolean, restoreView: boolean): Promise<void> {
    this.editor.endStroke(); // keep a stroke that was in progress
    this.#input.detach();
    for (const [hook, id] of this.#hooks) Hooks.off(hook, id);
    for (const off of this.#offs) off();
    if (this.#draftTimer) clearTimeout(this.#draftTimer);
    if (this.#resTimer) clearTimeout(this.#resTimer);
    canvas.app?.ticker?.remove(this.#tick, this);
    this.#outline.destroy();
    this.#cursor.destroy();
    this.#toolbar.destroy();
    boardElement()?.classList.remove("ts-board-drawing");
    presence.end();
    saveToolState(this.editor.tools);
    if (EditSession.#current === this) EditSession.#current = null;
    if (restoreView && this.#savedView && canvas.ready) void canvas.animatePan({ ...this.#savedView, duration: 300 });

    if (save && this.#sync.dirty) {
      saveDraft(this.sceneId, this.tokenId, this.editor.paper, this.#sync.synced.rev, this.editor.doc.ops);
      const ok = await this.#sync.flush();
      if (!ok) notify("warn", t("Notify.SavedLocally"));
    }
    if (!this.#sync.dirty) clearDraft(this.sceneId, this.tokenId);
    // Hand the token back to the persisted state.
    if (!this.token.destroyed) painter.endLive(this.token);
    this.#linger(save);
  }

  /**
   * Keep watching the document briefly so a write that raced ours (and dropped
   * our strokes) is detected and merged back even after the dock closed.
   */
  #linger(save: boolean): void {
    if (!save) {
      this.#sync.dispose();
      return;
    }
    const uuid = this.doc.uuid;
    const frozen = { ops: this.editor.doc.ops.slice() as readonly Op[] };
    const sync = new SyncEngine(
      this.editor.paper,
      this.#sync.synced,
      {
        read: () => readDrawing(this.doc),
        write: (stored) => writeDrawing(this.doc, stored),
        canWrite: () => canEditToken(this.doc),
        userId: game.user.id,
        maxBytes: getMaxBytes(),
      },
      {
        localOps: () => frozen.ops,
        applyMerged: (ops) => {
          frozen.ops = ops.slice();
        },
        status: (s) => {
          if (s === "error" || s === "offline") saveDraft(this.sceneId, this.tokenId, this.editor.paper, sync.synced.rev, frozen.ops);
          if (s === "saved") clearDraft(this.sceneId, this.tokenId);
        },
      },
    );
    if (this.#sync.dirty) sync.touch();
    this.#sync.dispose();
    const hookId = Hooks.on("updateToken", (doc: FoundryTokenDocument, changes: object) => {
      if (doc === this.doc && touchesModuleFlags(changes)) sync.receive(readDrawing(doc));
    });
    const timer = setTimeout(() => {
      Hooks.off("updateToken", hookId);
      lingering.delete(uuid);
      if (sync.dirty) void sync.flush().finally(() => sync.dispose());
      else sync.dispose();
    }, LINGER_MS);
    lingering.set(uuid, { sync, timer, hook: hookId });
  }
}
