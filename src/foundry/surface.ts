import { paperToTexture, textureToPaper } from "../model/fit.ts";
import type { Point } from "../model/types.ts";
import { painter } from "./painter.ts";

/**
 * Coordinate mapping between the viewport and a token's paper space.
 *
 * Paper → texture frame (contain fit) → mesh local (anchor offset) → canvas
 * (the mesh's own `canvasTransform`, which already contains position, rotation,
 * fit scale, texture scale and mirroring) → client (stage transform).
 * Because the real mesh transform is used, input stays aligned whatever the
 * token's size, rotation, anchor, mirroring or the map zoom.
 */
export class TokenSurface {
  readonly token: FoundryToken;

  constructor(token: FoundryToken) {
    this.token = token;
  }

  #parts() {
    const mesh = this.token.mesh;
    const layout = painter.layout(this.token);
    if (!mesh || mesh.destroyed || !layout) return null;
    mesh.updateCanvasTransform?.();
    return { mesh, layout };
  }

  clientToPaper(clientX: number, clientY: number): Point | null {
    const parts = this.#parts();
    if (!parts) return null;
    const { mesh, layout } = parts;
    const world = canvas.canvasCoordinatesFromClient({ x: clientX, y: clientY });
    const local = mesh.canvasTransform.applyInverse(world, { x: 0, y: 0 });
    const tex = { x: local.x + mesh.anchor.x * layout.frameW, y: local.y + mesh.anchor.y * layout.frameH };
    const p = textureToPaper(layout.rect, tex);
    return Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
  }

  paperToCanvas(p: Point): Point | null {
    const parts = this.#parts();
    if (!parts) return null;
    const { mesh, layout } = parts;
    const tex = paperToTexture(layout.rect, p);
    return mesh.canvasTransform.apply({ x: tex.x - mesh.anchor.x * layout.frameW, y: tex.y - mesh.anchor.y * layout.frameH }, { x: 0, y: 0 });
  }

  paperToClient(p: Point): Point | null {
    const c = this.paperToCanvas(p);
    return c ? canvas.clientCoordinatesFromCanvas(c) : null;
  }

  /** Paper corners in canvas space (TL, TR, BR, BL). */
  corners(): Point[] | null {
    const layout = painter.layout(this.token);
    if (!layout) return null;
    const w = layout.rect.width / layout.rect.scale;
    const h = layout.rect.height / layout.rect.scale;
    const pts = [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ].map((p) => this.paperToCanvas(p));
    return pts.every((p) => p) ? (pts as Point[]) : null;
  }

  /** Average screen (CSS) pixels per paper unit. */
  screenPxPerUnit(): number {
    const a = this.paperToClient({ x: 0, y: 0 });
    const b = this.paperToClient({ x: 100, y: 0 });
    const c = this.paperToClient({ x: 0, y: 100 });
    if (!a || !b || !c) return 1;
    return (Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - a.x, c.y - a.y)) / 200;
  }
}
