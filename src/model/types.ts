/** Drawing tools that produce stroke operations. */
export type ToolId = "pen" | "marker" | "brush" | "fill" | "eraser";

export const TOOL_IDS: readonly ToolId[] = ["pen", "marker", "brush", "fill", "eraser"];

/** Optional per-stroke overrides of the brush preset (only stored when they differ). */
export interface StrokeParams {
  thinning?: number;
  smoothing?: number;
  taperStart?: number;
  taperEnd?: number;
}

/**
 * A committed stroke. Coordinates live in paper space; `points` is a flat
 * `[x, y, pressure, x, y, pressure, ...]` array. Stroke objects are treated as
 * immutable once created so renderers can cache geometry per object.
 */
export interface StrokeOp {
  readonly kind: "stroke";
  readonly id: string;
  readonly tool: ToolId;
  /** `#rrggbb` */
  readonly color: string;
  /** 0..1 */
  readonly opacity: number;
  /** Base diameter in paper units. */
  readonly size: number;
  /** Also render mirrored around the paper's vertical centre line. */
  readonly mirror: boolean;
  readonly points: readonly number[];
  readonly params?: StrokeParams;
}

/** Clears everything drawn before it (kept in the log so it can be undone). */
export interface ClearOp {
  readonly kind: "clear";
  readonly id: string;
}

export type Op = StrokeOp | ClearOp;

/** The paper coordinate space. Its long side is PAPER_LONG_SIDE units. */
export interface Paper {
  readonly w: number;
  readonly h: number;
}

/** Decoded drawing with revision metadata. */
export interface DrawingState {
  readonly paper: Paper;
  readonly ops: readonly Op[];
  /** Revision id of this state, `null` when it has never been saved. */
  readonly rev: string | null;
  /** Revision this state was derived from. */
  readonly parent: string | null;
  /** Monotonic save counter (informational). */
  readonly seq: number;
  /** User id of the last writer. */
  readonly by: string | null;
  /** Recently deleted op ids (tombstones), oldest first. */
  readonly del: readonly string[];
}

export interface Point {
  x: number;
  y: number;
}
