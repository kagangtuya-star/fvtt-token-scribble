/**
 * Minimal ambient declarations for the parts of Foundry VTT v13/v14 and PIXI v7
 * that TokenScribble touches. Keeping them narrow documents the exact API
 * surface the module depends on (see docs/COMPATIBILITY.md) and keeps type
 * checking cheap. Members are typed as optional where they differ between
 * versions or may be absent during the canvas lifecycle.
 */

declare namespace PIXI {
  class Matrix {
    a: number;
    b: number;
    c: number;
    d: number;
    tx: number;
    ty: number;
    apply<P extends { x: number; y: number }>(pos: { x: number; y: number }, newPos?: P): P;
    applyInverse<P extends { x: number; y: number }>(pos: { x: number; y: number }, newPos?: P): P;
  }
  class ObservablePoint {
    x: number;
    y: number;
    set(x: number, y?: number): void;
  }
  class Rectangle {
    constructor(x?: number, y?: number, width?: number, height?: number);
    x: number;
    y: number;
    width: number;
    height: number;
  }
  class BaseTexture {
    constructor(resource?: unknown, options?: Record<string, unknown>);
    resource: unknown;
    valid: boolean;
    resolution: number;
    width: number;
    height: number;
    update(): void;
    destroy(): void;
  }
  class Texture {
    /** `trim` places the frame inside (or, for overflow, around) the logical `orig` rectangle. */
    constructor(baseTexture: BaseTexture, frame?: Rectangle, orig?: Rectangle, trim?: Rectangle);
    static EMPTY: Texture;
    baseTexture: BaseTexture;
    width: number;
    height: number;
    orig?: Rectangle;
    trim?: Rectangle;
    valid: boolean;
    destroyed?: boolean;
    destroy(destroyBase?: boolean): void;
  }
  class RenderTexture extends Texture {
    static create(options: { width: number; height: number; resolution?: number }): RenderTexture;
    resize(width: number, height: number, resizeBaseTexture?: boolean): void;
  }
  class VideoResource {}
  class DisplayObject {
    position: ObservablePoint;
    scale: ObservablePoint;
    visible: boolean;
    renderable: boolean;
    destroyed: boolean;
    alpha: number;
    parent: Container | null;
    destroy(options?: unknown): void;
  }
  class Container extends DisplayObject {
    addChild<T extends DisplayObject>(child: T): T;
    removeChild<T extends DisplayObject>(child: T): T;
  }
  class Sprite extends Container {
    constructor(texture?: Texture);
    texture: Texture;
    width: number;
    height: number;
  }
  class Graphics extends Container {
    clear(): this;
    lineStyle(options: { width: number; color: number; alpha?: number; alignment?: number }): this;
    moveTo(x: number, y: number): this;
    lineTo(x: number, y: number): this;
    closePath(): this;
  }
  interface Renderer {
    render(object: DisplayObject, options?: { renderTexture?: RenderTexture; clear?: boolean }): void;
    extract: { canvas(target: DisplayObject | RenderTexture): HTMLCanvasElement };
  }
  class Ticker {
    add(fn: (dt: number) => void, context?: unknown, priority?: number): this;
    remove(fn: (dt: number) => void, context?: unknown): this;
  }
  const UPDATE_PRIORITY: { HIGH: number; NORMAL: number; LOW: number };
}

interface FoundryUser {
  id: string;
  name: string;
  isGM: boolean;
  active: boolean;
  color: { css?: string; toString(): string } | string;
  can(permission: string): boolean;
}

interface FoundryDocumentBase {
  id: string | null;
  uuid: string;
  name: string;
  flags: Record<string, Record<string, unknown> | undefined>;
  getFlag(scope: string, key: string): unknown;
  canUserModify(user: FoundryUser, action: "create" | "update" | "delete", data?: object): boolean;
  testUserPermission(user: FoundryUser, level: string | number, options?: object): boolean;
  update(data: object, options?: object): Promise<unknown>;
  readonly isOwner: boolean;
}

interface FoundryActor extends FoundryDocumentBase {
  img: string | null;
  prototypeToken: { flags: Record<string, Record<string, unknown> | undefined>; texture: { src: string | null } };
}

interface FoundryScene extends FoundryDocumentBase {
  tokens: { get(id: string): FoundryTokenDocument | undefined };
  createEmbeddedDocuments(type: "Token", data: object[], options?: object): Promise<FoundryTokenDocument[]>;
  grid: { type: number; size: number };
}

interface FoundryTokenDocument extends FoundryDocumentBase {
  parent: FoundryScene | null;
  object: FoundryToken | null;
  actor: FoundryActor | null;
  /** The world Actor (not the synthetic one of an unlinked token). */
  baseActor?: FoundryActor | null;
  actorLink: boolean;
  hidden: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  texture: { src: string | null; scaleX: number; scaleY: number; fit: string };
  getSize?(): { width: number; height: number };
}

interface PrimarySpriteMesh extends PIXI.Container {
  texture: PIXI.Texture;
  anchor: PIXI.ObservablePoint;
  canvasTransform: PIXI.Matrix;
  updateCanvasTransform?(): void;
  scale: PIXI.ObservablePoint;
}

interface FoundryToken extends PIXI.Container {
  document: FoundryTokenDocument;
  mesh?: PrimarySpriteMesh;
  texture?: PIXI.Texture;
  isPreview: boolean;
  _original?: FoundryToken;
  controlled: boolean;
  visible: boolean;
  center: { x: number; y: number };
  w: number;
  h: number;
  objectId: string;
  hasActiveHUD?: boolean;
  /** v13+: the dynamic token ring is active (its shader maps UVs to the quad). */
  hasDynamicRing?: boolean;
  control(options?: { releaseOthers?: boolean }): boolean;
  release(): boolean;
  layer: { hud?: { close(): void; object?: FoundryToken | null } };
  renderFlags?: { set(flags: Record<string, boolean>): void };
}

interface FoundryCanvas {
  ready: boolean;
  scene: FoundryScene | null;
  app: { renderer: PIXI.Renderer; ticker: PIXI.Ticker; view: HTMLCanvasElement };
  stage: PIXI.Container & { pivot: PIXI.ObservablePoint; scale: PIXI.ObservablePoint };
  dimensions: { size: number; scale: { min: number; max: number }; rect?: unknown };
  grid: {
    type: number;
    size: number;
    sizeX: number;
    sizeY: number;
    getSnappedPoint(point: { x: number; y: number }, behavior: { mode: number; resolution?: number }): { x: number; y: number };
  };
  tokens: {
    controlled: FoundryToken[];
    get(id: string): FoundryToken | undefined;
    hud?: { close(): void; object?: FoundryToken | null };
  };
  controls: PIXI.Container;
  mousePosition: { x: number; y: number };
  canvasCoordinatesFromClient(point: { x: number; y: number }): { x: number; y: number };
  clientCoordinatesFromCanvas(point: { x: number; y: number }): { x: number; y: number };
  animatePan(view: { x?: number; y?: number; scale?: number; duration?: number }): Promise<unknown>;
}

interface FoundryNotifications {
  info(message: string, options?: object): unknown;
  warn(message: string, options?: object): unknown;
  error(message: string, options?: object): unknown;
}

interface FoundrySettingConfig {
  name?: string;
  hint?: string;
  scope: "world" | "client" | "user";
  config: boolean;
  type: unknown;
  default: unknown;
  choices?: Record<string, string>;
  range?: { min: number; max: number; step: number };
  restricted?: boolean;
  requiresReload?: boolean;
  onChange?: (value: unknown) => void;
}

interface FoundryGame {
  ready: boolean;
  user: FoundryUser;
  users: { get(id: string): FoundryUser | undefined; contents?: FoundryUser[] } & Iterable<FoundryUser>;
  release: { generation: number; build?: number };
  version: string;
  i18n: {
    lang: string;
    localize(key: string): string;
    format(key: string, data?: Record<string, unknown>): string;
    has(key: string): boolean;
  };
  settings: {
    register(module: string, key: string, config: FoundrySettingConfig): void;
    get(module: string, key: string): unknown;
    set(module: string, key: string, value: unknown): Promise<unknown>;
  };
  keybindings: {
    register(
      module: string,
      key: string,
      config: {
        name: string;
        hint?: string;
        editable?: { key: string; modifiers?: string[] }[];
        onDown?: (context: unknown) => boolean | void;
        restricted?: boolean;
        precedence?: number;
      },
    ): void;
  };
  socket: {
    on(event: string, fn: (...args: unknown[]) => void): void;
    off?(event: string, fn: (...args: unknown[]) => void): void;
    emit(event: string, ...args: unknown[]): void;
  };
  modules: { get(id: string): { api?: unknown; version?: string } | undefined };
  world: { id: string };
  actors?: { get(id: string): FoundryActor | undefined };
}

interface FoundryHooks {
  on(hook: string, fn: (...args: any[]) => unknown): number;
  once(hook: string, fn: (...args: any[]) => unknown): number;
  off(hook: string, idOrFn: number | ((...args: any[]) => unknown)): void;
  callAll(hook: string, ...args: unknown[]): boolean;
}

interface DialogV2Static {
  confirm(options: {
    window?: { title?: string; icon?: string };
    content?: string;
    rejectClose?: boolean;
    modal?: boolean;
    yes?: { label?: string; icon?: string; default?: boolean };
    no?: { label?: string; icon?: string; default?: boolean };
  }): Promise<boolean | null>;
}

declare const game: FoundryGame;
declare const canvas: FoundryCanvas;
declare const ui: { notifications: FoundryNotifications };
declare const Hooks: FoundryHooks;
declare const CONFIG: {
  Token: { documentClass: new (data: object, context?: object) => FoundryTokenDocument };
  ux?: { FilePicker?: FilePickerStatic };
};

/** Server file operations (static API of foundry.applications.apps.FilePicker). */
interface FilePickerStatic {
  browse(source: string, target: string, options?: object): Promise<{ target?: string; dirs?: string[]; files?: string[] }>;
  createDirectory(source: string, target: string, options?: object): Promise<unknown>;
  /** Resolves `{path}` on success, `false`/`undefined`/`{}` on failure (it notifies or logs itself). */
  upload(source: string, path: string, file: File, body?: object, options?: { notify?: boolean }): Promise<{ path?: string; message?: string } | false | void>;
}

interface ApplicationV2Options {
  id?: string;
  classes?: string[];
  tag?: string;
  window?: { title?: string; icon?: string; resizable?: boolean; minimizable?: boolean; contentClasses?: string[] };
  position?: { width?: number | "auto"; height?: number | "auto"; top?: number; left?: number };
}

/** The parts of ApplicationV2 (v13+) a subclass here relies on. */
interface ApplicationV2Instance {
  readonly element: HTMLElement;
  readonly rendered: boolean;
  readonly id: string;
  render(options?: { force?: boolean }): Promise<unknown>;
  close(options?: { animate?: boolean }): Promise<unknown>;
  bringToFront(): void;
  _renderHTML(context: unknown, options: unknown): Promise<unknown>;
  _replaceHTML(result: unknown, content: HTMLElement, options: unknown): void;
  _onClose(options: unknown): void;
}

interface ApplicationV2Class {
  new (options?: ApplicationV2Options): ApplicationV2Instance;
  DEFAULT_OPTIONS: ApplicationV2Options;
}
declare const CONST: {
  GRID_TYPES: { GRIDLESS: number; SQUARE: number };
  GRID_SNAPPING_MODES: { CENTER: number; TOP_LEFT_CORNER: number; TOP_LEFT_VERTEX?: number };
  TOKEN_DISPLAY_MODES: { NONE: number; HOVER: number; OWNER_HOVER: number };
  KEYBINDING_PRECEDENCE: { PRIORITY: number; NORMAL: number; DEFERRED: number };
};
declare const foundry: {
  utils: {
    hasProperty(object: object, key: string): boolean;
    getProperty(object: object, key: string): unknown;
    debounce<F extends (...args: any[]) => void>(fn: F, delay: number): F;
    escapeHTML?(text: string): string;
  };
  applications: { api: { DialogV2: DialogV2Static; ApplicationV2: ApplicationV2Class }; apps?: { FilePicker?: { implementation?: FilePickerStatic } } };
};
