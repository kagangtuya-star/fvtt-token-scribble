/**
 * TokenPainter against a minimal PIXI stand-in: checks the composite layout
 * for out-of-frame ink (RenderTexture bounds, trimmed view texture, sprite
 * placement) using the same vertex formula as Foundry's SpriteMesh. This is
 * not a rendering test; real-Foundry verification is listed in
 * docs/DEVELOPMENT.md.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { before, describe, it } from "node:test";
import { MODULE_ID } from "../src/constants.ts";
import { encodeDrawing } from "../src/model/serialize.ts";
import type { StrokeOp } from "../src/model/types.ts";
import { stroke } from "./helpers.ts";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "perfect-freehand") {
      return { url: "data:text/javascript,export function getStroke(){return []}", shortCircuit: true };
    }
    return next(specifier, context);
  },
});

class Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
  constructor(x = 0, y = 0, width = 0, height = 0) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }
}
class Point {
  x = 0;
  y = 0;
  set(x: number, y = x) {
    this.x = x;
    this.y = y;
  }
}
class BaseTexture {
  valid = true;
  resolution = 1;
  width = 0;
  height = 0;
  destroyed = false;
  resource: unknown;
  constructor(resource: unknown = null) {
    this.resource = resource;
    if (resource && typeof resource === "object" && "width" in resource) {
      const canvasLike = resource as { width: number; height: number };
      this.width = canvasLike.width;
      this.height = canvasLike.height;
      this.resource = { source: resource };
    }
  }
  update() {}
  destroy() {
    this.destroyed = true;
  }
}
class Texture {
  static EMPTY: Texture;
  valid = true;
  destroyed = false;
  frame: Rectangle;
  orig: Rectangle;
  trim?: Rectangle;
  baseTexture: BaseTexture;
  constructor(baseTexture: BaseTexture, frame?: Rectangle, orig?: Rectangle, trim?: Rectangle) {
    this.baseTexture = baseTexture;
    this.frame = frame ?? new Rectangle(0, 0, baseTexture.width, baseTexture.height);
    if (
      this.frame.x + this.frame.width > baseTexture.width + 1e-9 ||
      this.frame.y + this.frame.height > baseTexture.height + 1e-9
    ) {
      throw new Error("Texture Error: frame does not fit inside the base Texture dimensions");
    }
    this.orig = orig ?? this.frame;
    this.trim = trim;
  }
  get width() {
    return this.orig.width;
  }
  get height() {
    return this.orig.height;
  }
  destroy(destroyBase = false) {
    this.destroyed = true;
    if (destroyBase) this.baseTexture.destroy();
  }
}
Texture.EMPTY = new Texture(Object.assign(new BaseTexture(), { width: 1, height: 1 }));
class RenderTexture extends Texture {
  static create({ width, height, resolution = 1 }: { width: number; height: number; resolution?: number }) {
    const base = new BaseTexture();
    base.resolution = resolution;
    // PIXI rounds the backing store to whole device pixels.
    base.width = Math.round(width * resolution) / resolution;
    base.height = Math.round(height * resolution) / resolution;
    const rt = new RenderTexture(base, new Rectangle(0, 0, Math.min(width, base.width), Math.min(height, base.height)));
    return rt;
  }
}
class Container {
  children: unknown[] = [];
  addChild<T>(c: T): T {
    this.children.push(c);
    return c;
  }
  destroy() {}
}
class Sprite {
  position = new Point();
  width = 0;
  height = 0;
  visible = true;
  texture: Texture;
  constructor(texture: Texture) {
    this.texture = texture;
  }
}

class FakeCtx {
  save() {}
  restore() {}
  setTransform() {}
  clearRect() {}
  fill() {}
  drawImage() {}
  setLineDash() {}
  beginPath() {}
  roundRect() {}
  moveTo() {}
  lineTo() {}
  closePath() {}
  stroke() {}
}

const renders: { target: RenderTexture }[] = [];
const g = globalThis as Record<string, unknown>;
g.PIXI = {
  Rectangle,
  BaseTexture,
  Texture,
  RenderTexture,
  Container,
  Sprite,
  VideoResource: class {},
  UPDATE_PRIORITY: { NORMAL: 0 },
};
g.window = { devicePixelRatio: 1 };
g.document = {
  createElement: () => {
    const ctx = new FakeCtx();
    return { width: 0, height: 0, getContext: () => ctx };
  },
};
g.Path2D ??= class {};
g.canvas = {
  grid: { size: 100 },
  app: {
    renderer: {
      render: (_c: unknown, o: { renderTexture: RenderTexture }) => renders.push({ target: o.renderTexture }),
    },
    ticker: { add() {}, remove() {} },
  },
};
g.Hooks = { on() {} };

let TokenPainter: typeof import("../src/foundry/painter.ts").TokenPainter;
before(async () => {
  ({ TokenPainter } = await import("../src/foundry/painter.ts"));
});

/** A 200×100 token image (paper 1000×500, 0.2 frame units per paper unit). */
function token(strokes: StrokeOp[], ring = false) {
  const original = new Texture(Object.assign(new BaseTexture(), { width: 200, height: 100 }));
  const stored = encodeDrawing({ w: 1000, h: 500 }, strokes, { rev: "r1", parent: null, seq: 1, by: null, at: 0 });
  return {
    original,
    token: {
      document: {
        uuid: "Scene.s.Token.t",
        width: 2,
        height: 1,
        texture: { scaleX: 1, scaleY: 1 },
        flags: { [MODULE_ID]: { drawing: stored } },
      },
      mesh: { texture: original as Texture, destroyed: false, anchor: { x: 0.5, y: 0.5 } },
      hasDynamicRing: ring,
      isPreview: false,
      renderFlags: { set() {} },
    },
  };
}

/** Foundry SpriteMesh.calculateVertices, x/y extents in mesh-local units. */
function meshQuad(t: Texture, anchor = { x: 0.5, y: 0.5 }) {
  const { orig, trim } = t;
  const x0 = trim ? trim.x - anchor.x * orig.width : -anchor.x * orig.width;
  const y0 = trim ? trim.y - anchor.y * orig.height : -anchor.y * orig.height;
  return { x0, y0, x1: x0 + (trim ?? orig).width, y1: y0 + (trim ?? orig).height };
}

const outside = (x: number, y: number) =>
  stroke(undefined, { size: 8, points: [x, y, 0.5, x + 20, y + 10, 0.5, 300, 250, 0.5] });

describe("TokenPainter composite", () => {
  it("keeps tokens without overflow at exactly the frame", () => {
    const { token: tk } = token([stroke()]);
    const p = new TokenPainter();
    p.refresh(tk as unknown as FoundryToken);
    const view = tk.mesh.texture;
    assert.equal(view.width, 200);
    assert.equal(view.height, 100);
    assert.deepEqual(meshQuad(view), { x0: -100, y0: -50, x1: 100, y1: 50 });
  });

  it("extends the mesh quad around out-of-frame ink while the logical size stays the frame", () => {
    const { token: tk, original } = token([outside(-150, -120)]);
    const p = new TokenPainter();
    p.refresh(tk as unknown as FoundryToken);
    const view = tk.mesh.texture;
    assert.notEqual(view, original);
    // Core sizes the token from these: unchanged.
    assert.equal(view.width, 200);
    assert.equal(view.height, 100);
    // Ink at paper (-158, -128) → frame (-31.6, -25.6) must be inside the quad.
    const q = meshQuad(view);
    assert.equal(q.x0, -100 - 40, "extent starts at paper x = -200 → frame x = -40");
    assert.equal(q.y0, -50 - 40);
    assert.equal(q.x1, 100);
    assert.equal(q.y1, 50);
    // The composite target holds exactly the quad's area.
    const rt = renders.at(-1)!.target;
    assert.equal(rt.frame.width, 240);
    assert.equal(rt.frame.height, 140);
    assert.equal(view.baseTexture, rt.baseTexture);
  });

  it("clips to the frame for tokens with a dynamic ring", () => {
    const { token: tk } = token([outside(-150, -120)], true);
    const p = new TokenPainter();
    p.refresh(tk as unknown as FoundryToken);
    assert.deepEqual(meshQuad(tk.mesh.texture), { x0: -100, y0: -50, x1: 100, y1: 50 });
  });

  it("restores the original texture on release", () => {
    const { token: tk, original } = token([outside(1100, 600)]);
    const p = new TokenPainter();
    p.refresh(tk as unknown as FoundryToken);
    assert.deepEqual(meshQuad(tk.mesh.texture), { x0: -100, y0: -50, x1: 140, y1: 90 });
    p.release(tk as unknown as FoundryToken);
    assert.equal(tk.mesh.texture, original);
  });
});
