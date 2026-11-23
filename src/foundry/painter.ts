import { MODULE_ID } from "../constants.ts";
import { freehandOutliner } from "../engine/freehand.ts";
import { Raster } from "../engine/raster.ts";
import { drawingExtent, paperExtent, sameExtent } from "../model/extent.ts";
import type { Extent } from "../model/extent.ts";
import { paperRectIn } from "../model/fit.ts";
import type { PaperRect } from "../model/fit.ts";
import { isPictureEmpty } from "../model/ops.ts";
import type { Op, Paper } from "../model/types.ts";
import { documentSize, isVideoTexture } from "./compat.ts";
import { isLayerHidden, isScribbleToken, readDrawing, touchesModuleFlags } from "./store.ts";

/**
 * Token render integration.
 *
 * Foundry draws a token's image with a PrimarySpriteMesh that lives in the
 * PrimaryCanvasGroup (not inside the Token container) and gets visibility,
 * occlusion, elevation sorting, hidden-state alpha, detection filters and the
 * dynamic ring shader from core. Core documents that this mesh must not have
 * renderable children (its depth/void passes skip them), so an overlay child
 * would leak or mis-sort.
 *
 * Instead we composite "original texture + drawing" into a RenderTexture of the
 * same frame size and assign it as the mesh texture. Every native code path —
 * fit, scale, mirroring, anchor, rotation, tint, visibility, vision, occlusion —
 * keeps operating on the mesh exactly as before; only pixels change. The
 * document's `texture.src` is never touched.
 *
 * Out-of-frame ink: the RenderTexture covers the frame plus the drawing's
 * extent, and the mesh gets a *trimmed* view of it whose `orig` is the frame.
 * Core sizes the token from `orig` (unchanged) while SpriteMesh vertices follow
 * `trim`, so ink beyond the image edge is drawn around it. Tokens with the
 * dynamic ring are clipped to the frame, because the ring shader maps its UVs
 * onto the whole quad.
 *
 * Tokens without a drawing are never touched and cost nothing.
 */

interface Entry {
  token: FoundryToken;
  /** The texture Foundry assigned to the mesh (image, ring subject, or video). */
  original: PIXI.Texture;
  rt: PIXI.RenderTexture;
  /** What the mesh shows: `rt` with `orig` = frame and `trim` = composite bounds. */
  view: PIXI.Texture;
  /** Composite bounds in frame units; (x, y) ≤ 0 is where `rt` pixel (0, 0) sits. */
  bounds: { x: number; y: number; w: number; h: number };
  /** Paper area covered by the drawing canvas. */
  extent: Extent;
  /** Wanted composite resolution (device px per frame unit), before the size cap. */
  perUnit: number;
  container: PIXI.Container;
  origSprite: PIXI.Sprite;
  drawSprite: PIXI.Sprite;
  drawTexture: PIXI.Texture | null;
  raster: Raster | null;
  /** Live sessions supply their own raster; idle entries own theirs. */
  live: LiveSource | null;
  paper: Paper;
  rect: PaperRect;
  frameW: number;
  frameH: number;
  animated: boolean;
  dropTimer: ReturnType<typeof setTimeout> | null;
}

export interface LiveSource {
  raster(): Raster;
  /** Returns true when the raster's display canvas changed since last call. */
  flush(): boolean;
  /** Desired raster long side (px); the painter only reads it. */
  readonly paper: Paper;
}

/** Keep an idle raster around this long after a remote update (incremental redraws). */
const RASTER_TTL_MS = 30_000;
const MAX_RT_PX = 4096;

function frameOf(texture: PIXI.Texture | undefined, token: FoundryToken): { w: number; h: number } {
  if (texture && texture !== PIXI.Texture.EMPTY && texture.valid !== false && texture.width > 1 && texture.height > 1) {
    return { w: Math.round(texture.width), h: Math.round(texture.height) };
  }
  // Missing/empty texture: use the token footprint so the drawing still has a sensible frame.
  const { width, height } = documentSize(token.document);
  return { w: Math.max(1, width), h: Math.max(1, height) };
}

/** Raster resolution for a token that is not being edited. */
export function idleRasterPx(token: FoundryToken, paper: Paper, frame: { w: number; h: number }): number {
  const { width, height } = documentSize(token.document);
  const tex = token.document.texture;
  const scale = Math.max(Math.abs(tex?.scaleX ?? 1), Math.abs(tex?.scaleY ?? 1));
  // Footprint on the canvas at zoom 1, times headroom for zooming in and HiDPI.
  const onCanvas = Math.max(width, height) * scale;
  const rect = paperRectIn(paper, frame.w, frame.h);
  const paperShare = Math.max(rect.width / frame.w, rect.height / frame.h);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  return Math.round(Math.min(2048, Math.max(192, onCanvas * paperShare * 2 * dpr)));
}

/** A view of `rt` whose logical size is the frame and whose pixels may extend beyond it. */
function viewOf(rt: PIXI.RenderTexture, b: { x: number; y: number; w: number; h: number }, frameW: number, frameH: number): PIXI.Texture {
  // The base size is rounded to whole device pixels; the frame must fit inside it.
  const base = rt.baseTexture;
  return new PIXI.Texture(
    base,
    new PIXI.Rectangle(0, 0, Math.min(b.w, base.width), Math.min(b.h, base.height)),
    new PIXI.Rectangle(0, 0, frameW, frameH),
    new PIXI.Rectangle(b.x, b.y, b.w, b.h),
  );
}

export class TokenPainter {
  readonly #entries = new Map<FoundryToken, Entry>();
  #ticking = false;

  /* -------------------------------------------- */
  /*  Hooks                                       */
  /* -------------------------------------------- */

  init(): void {
    const guard =
      <A extends unknown[]>(name: string, fn: (...args: A) => void) =>
      (...args: A) => {
        try {
          fn(...args);
        } catch (err) {
          console.error(`${MODULE_ID} | ${name} failed`, err);
        }
      };
    Hooks.on("drawToken", guard("drawToken", (token: FoundryToken) => this.refresh(token)));
    Hooks.on(
      "refreshToken",
      guard("refreshToken", (token: FoundryToken) => {
        const entry = this.#entries.get(token);
        // Core replaced the mesh texture (redraw, ring subject, transition): adopt the new one.
        if (entry && token.mesh && !token.mesh.destroyed && token.mesh.texture !== entry.view) this.#adopt(entry);
      }),
    );
    // Flag-only updates (another user's strokes, hide/show) do not redraw the token in core.
    Hooks.on(
      "updateToken",
      guard("updateToken", (doc: FoundryTokenDocument, changes: object) => {
        if (touchesModuleFlags(changes) && doc.object) this.refresh(doc.object);
      }),
    );
    Hooks.on("destroyToken", guard("destroyToken", (token: FoundryToken) => this.release(token, false)));
    Hooks.on("canvasTearDown", guard("canvasTearDown", () => this.releaseAll()));
  }

  /* -------------------------------------------- */
  /*  Public API                                  */
  /* -------------------------------------------- */

  has(token: FoundryToken): boolean {
    return this.#entries.has(token);
  }

  /** Re-evaluate a token from its document (draw, remote update, flag toggles). */
  refresh(token: FoundryToken | null | undefined): void {
    if (!token?.mesh || token.mesh.destroyed) return;
    const existing = this.#entries.get(token);
    if (existing?.live) {
      this.#compose(existing);
      return;
    }
    // Drag/config previews share the original token's composite texture.
    if (token.isPreview && token._original) {
      const src = this.#entries.get(token._original);
      if (src && token.mesh.texture !== src.view) token.mesh.texture = src.view;
      return;
    }
    const doc = token.document;
    const result = readDrawing(doc);
    if (!result.ok) {
      if (result.reason !== "missing") console.warn(`${MODULE_ID} | unreadable drawing on ${doc.uuid}: ${result.detail ?? result.reason}`);
      this.release(token);
      return;
    }
    const created = isScribbleToken(doc);
    const { paper, ops } = result.state;
    if (isLayerHidden(doc) || (isPictureEmpty(ops) && !created)) {
      this.release(token);
      return;
    }
    this.#show(token, paper, ops, created && isPictureEmpty(ops));
  }

  /** Hand rendering of `token` to a live editing session. */
  beginLive(token: FoundryToken, source: LiveSource): void {
    const entry = this.#ensure(token, source.paper);
    if (!entry) return;
    this.#clearDropTimer(entry);
    entry.raster = null;
    entry.live = source;
    this.#bindDrawTexture(entry, source.raster());
    this.#compose(entry);
    this.#updateTicker();
  }

  /** End a live session; the token falls back to its persisted drawing. */
  endLive(token: FoundryToken): void {
    const entry = this.#entries.get(token);
    if (!entry) return;
    entry.live = null;
    this.#destroyDrawTexture(entry);
    this.#updateTicker();
    this.refresh(token);
  }

  /** Paper rect + frame for pointer mapping (null when the token is not composited). */
  layout(token: FoundryToken): { rect: PaperRect; frameW: number; frameH: number } | null {
    const e = this.#entries.get(token);
    return e ? { rect: e.rect, frameW: e.frameW, frameH: e.frameH } : null;
  }

  /** Pixels of the composite (drawing + original image, out-of-frame ink included), for PNG export. */
  extractComposite(token: FoundryToken): HTMLCanvasElement | null {
    const e = this.#entries.get(token);
    if (!e) return null;
    this.#compose(e);
    return canvas.app.renderer.extract.canvas(e.rt);
  }

  release(token: FoundryToken, restore = true): void {
    const entry = this.#entries.get(token);
    if (!entry) return;
    this.#entries.delete(token);
    this.#clearDropTimer(entry);
    const mesh = token.mesh;
    if (restore && mesh && !mesh.destroyed && mesh.texture === entry.view) mesh.texture = entry.original;
    else if (mesh && !mesh.destroyed && mesh.texture === entry.view) mesh.texture = PIXI.Texture.EMPTY;
    this.#destroyDrawTexture(entry);
    entry.container.destroy({ children: true, texture: false, baseTexture: false });
    entry.view.destroy(false);
    entry.rt.destroy(true);
    this.#updateTicker();
  }

  releaseAll(): void {
    for (const token of [...this.#entries.keys()]) this.release(token, false);
  }

  /* -------------------------------------------- */
  /*  Internals                                   */
  /* -------------------------------------------- */

  #ensure(token: FoundryToken, paper: Paper): Entry | null {
    const mesh = token.mesh;
    if (!mesh || mesh.destroyed) return null;
    let entry = this.#entries.get(token);
    if (entry && (entry.paper.w !== paper.w || entry.paper.h !== paper.h)) {
      entry.paper = paper;
      entry.rect = paperRectIn(paper, entry.frameW, entry.frameH);
    }
    if (entry) return entry;
    const original = mesh.texture;
    const frame = frameOf(original, token);
    const container = new PIXI.Container();
    const origSprite = container.addChild(new PIXI.Sprite(original));
    const drawSprite = container.addChild(new PIXI.Sprite(PIXI.Texture.EMPTY));
    const rt = PIXI.RenderTexture.create({ width: frame.w, height: frame.h, resolution: 1 });
    const bounds = { x: 0, y: 0, w: frame.w, h: frame.h };
    entry = {
      token,
      original,
      rt,
      view: viewOf(rt, bounds, frame.w, frame.h),
      bounds,
      extent: paperExtent(paper),
      perUnit: 1,
      container,
      origSprite,
      drawSprite,
      drawTexture: null,
      raster: null,
      live: null,
      paper,
      rect: paperRectIn(paper, frame.w, frame.h),
      frameW: frame.w,
      frameH: frame.h,
      animated: isVideoTexture(original),
      dropTimer: null,
    };
    this.#layoutSprites(entry);
    this.#entries.set(token, entry);
    return entry;
  }

  /** The mesh got a new base texture from core: rebuild around it. */
  #adopt(entry: Entry): void {
    const mesh = entry.token.mesh!;
    entry.original = mesh.texture;
    entry.animated = isVideoTexture(entry.original);
    const frame = frameOf(entry.original, entry.token);
    entry.frameW = frame.w;
    entry.frameH = frame.h;
    entry.rect = paperRectIn(entry.paper, frame.w, frame.h);
    entry.origSprite.texture = entry.original;
    this.#layoutSprites(entry);
    if (entry.live || entry.drawTexture) {
      this.#compose(entry);
      this.#updateTicker();
    } else {
      // The idle canvas was already freed: re-rasterise from the document.
      this.refresh(entry.token);
    }
  }

  /** Frame ∪ drawing extent, in frame units (snapped to whole units). */
  #boundsOf(entry: Entry): Entry["bounds"] {
    const { frameW, frameH, rect, extent } = entry;
    if (entry.token.hasDynamicRing) return { x: 0, y: 0, w: frameW, h: frameH };
    const x0 = Math.floor(Math.min(0, rect.x + extent.x * rect.scale));
    const y0 = Math.floor(Math.min(0, rect.y + extent.y * rect.scale));
    const x1 = Math.ceil(Math.max(frameW, rect.x + (extent.x + extent.w) * rect.scale));
    const y1 = Math.ceil(Math.max(frameH, rect.y + (extent.y + extent.h) * rect.scale));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  #layoutSprites(entry: Entry): void {
    entry.bounds = this.#boundsOf(entry);
    const { x: bx, y: by } = entry.bounds;
    const { rect, extent } = entry;
    const hasImage = entry.original !== PIXI.Texture.EMPTY && entry.original.valid !== false;
    entry.origSprite.visible = hasImage;
    entry.origSprite.position.set(-bx, -by);
    entry.origSprite.width = entry.frameW;
    entry.origSprite.height = entry.frameH;
    entry.drawSprite.position.set(rect.x + extent.x * rect.scale - bx, rect.y + extent.y * rect.scale - by);
    entry.drawSprite.width = extent.w * rect.scale;
    entry.drawSprite.height = extent.h * rect.scale;
  }

  #show(token: FoundryToken, paper: Paper, ops: readonly Op[], placeholder: boolean): void {
    const entry = this.#ensure(token, paper);
    if (!entry) return;
    const frame = { w: entry.frameW, h: entry.frameH };
    const px = idleRasterPx(token, paper, frame);
    const extent = drawingExtent(ops, paper);
    let raster = entry.raster;
    if (
      !raster ||
      raster.paper.w !== paper.w ||
      raster.paper.h !== paper.h ||
      !sameExtent(raster.extent, extent) ||
      Math.abs(raster.requestedPx - px) > 4
    ) {
      raster = new Raster(paper, px, freehandOutliner, undefined, extent);
      raster.renderAll(ops, placeholder);
    } else {
      raster.sync(ops, placeholder);
    }
    entry.raster = raster;
    this.#bindDrawTexture(entry, raster);
    entry.drawTexture?.baseTexture.update();
    this.#compose(entry);
    // Keep the canvas briefly for cheap incremental redraws, then free it.
    this.#clearDropTimer(entry);
    entry.dropTimer = setTimeout(() => {
      entry.dropTimer = null;
      // Video tokens recomposite every frame and need the drawing canvas.
      if (entry.live || entry.animated || !this.#entries.has(token)) return;
      entry.raster = null;
      this.#destroyDrawTexture(entry);
    }, RASTER_TTL_MS);
    this.#updateTicker();
  }

  #bindDrawTexture(entry: Entry, raster: Raster): void {
    const source = raster.display;
    const current = entry.drawTexture?.baseTexture.resource as { source?: unknown } | undefined;
    if (entry.drawTexture && current?.source === source) return;
    this.#destroyDrawTexture(entry);
    const base = new PIXI.BaseTexture(source, { scaleMode: 1 /* LINEAR */ });
    entry.drawTexture = new PIXI.Texture(base);
    entry.drawSprite.texture = entry.drawTexture;
    entry.extent = raster.extent;
    this.#layoutSprites(entry);
    this.#resizeTarget(entry, raster.paperPx);
  }

  #destroyDrawTexture(entry: Entry): void {
    if (!entry.drawTexture) return;
    // The composite RT keeps the pixels; only the canvas upload is freed.
    entry.drawSprite.texture = PIXI.Texture.EMPTY;
    entry.drawTexture.destroy(true);
    entry.drawTexture = null;
  }

  /** Give the composite enough pixels for the drawing (independent of the image's own size). */
  #resizeTarget(entry: Entry, paperPx: number): void {
    entry.perUnit = paperPx / Math.max(entry.rect.width, entry.rect.height); // device px per frame unit
    this.#ensureTarget(entry);
  }

  /** (Re)create the RenderTexture and its trimmed view when bounds or resolution changed. */
  #ensureTarget(entry: Entry): void {
    const b = entry.bounds;
    const res = Math.max(0.05, Math.min(entry.perUnit, MAX_RT_PX / Math.max(b.w, b.h)));
    const sameSize = entry.rt.width === b.w && entry.rt.height === b.h;
    if (sameSize && Math.abs(entry.rt.baseTexture.resolution - res) < 0.01) {
      const t = entry.view.trim;
      const o = entry.view.orig;
      if (t?.x === b.x && t.y === b.y && o?.width === entry.frameW && o.height === entry.frameH) return;
    }
    const oldRt = entry.rt;
    const oldView = entry.view;
    entry.rt = sameSize && Math.abs(oldRt.baseTexture.resolution - res) < 0.01 ? oldRt : PIXI.RenderTexture.create({ width: b.w, height: b.h, resolution: res });
    entry.view = viewOf(entry.rt, b, entry.frameW, entry.frameH);
    const mesh = entry.token.mesh;
    if (mesh && !mesh.destroyed && mesh.texture === oldView) mesh.texture = entry.view;
    oldView.destroy(false);
    if (entry.rt !== oldRt) oldRt.destroy(true);
  }

  #compose(entry: Entry): void {
    const mesh = entry.token.mesh;
    if (!mesh || mesh.destroyed) return;
    this.#ensureTarget(entry);
    canvas.app.renderer.render(entry.container, { renderTexture: entry.rt, clear: true });
    if (mesh.texture !== entry.view) {
      const prev = mesh.texture;
      mesh.texture = entry.view;
      // Mesh scale is derived from texture size (`orig`, i.e. the frame); re-run
      // core sizing if it changed (only when the original was empty or failed to load).
      if (!prev || prev.width !== entry.view.width || prev.height !== entry.view.height) {
        entry.token.renderFlags?.set({ refreshSize: true });
      }
    }
  }

  #clearDropTimer(entry: Entry): void {
    if (entry.dropTimer) clearTimeout(entry.dropTimer);
    entry.dropTimer = null;
  }

  /** The ticker only runs while a live session or a video token needs per-frame work. */
  #updateTicker(): void {
    const need = [...this.#entries.values()].some((e) => e.live || e.animated);
    const ticker = canvas?.app?.ticker;
    if (!ticker) return;
    if (need && !this.#ticking) {
      ticker.add(this.#tick, this, PIXI.UPDATE_PRIORITY.NORMAL);
      this.#ticking = true;
    } else if (!need && this.#ticking) {
      ticker.remove(this.#tick, this);
      this.#ticking = false;
    }
  }

  readonly #tick = (): void => {
    for (const entry of this.#entries.values()) {
      try {
        if (entry.live) {
          const raster = entry.live.raster();
          this.#bindDrawTexture(entry, raster);
          if (entry.live.flush()) {
            entry.drawTexture?.baseTexture.update();
            this.#compose(entry);
          }
        } else if (entry.animated && entry.token.visible) {
          this.#compose(entry);
        }
      } catch (err) {
        console.error(`${MODULE_ID} | render tick failed`, err);
      }
    }
  };
}

export const painter = new TokenPainter();
