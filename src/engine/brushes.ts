import type { StrokeOp, StrokeParams, ToolId } from "../model/types.ts";

/**
 * Brush presets. Values that affect *rendering* are part of format v1: changing
 * them changes how existing drawings look, so new behaviour must be expressed
 * as per-stroke `params` (or a new format version) instead.
 *
 * Sizes are in paper units (paper long side = 1000).
 */
export interface BrushPreset {
  readonly tool: ToolId;
  /** perfect-freehand thinning: how strongly pressure affects width. */
  readonly thinning: number;
  /** perfect-freehand smoothing: outline point spacing softness. */
  readonly smoothing: number;
  /** Input-time streamline applied before storage (0 = raw, 1 = very laggy). */
  readonly streamline: number;
  /** Taper length as a multiple of the stroke size (0 = none). */
  readonly taperStart: number;
  readonly taperEnd: number;
  readonly defaultSize: number;
  readonly minSize: number;
  readonly maxSize: number;
  readonly defaultOpacity: number;
  /** Whether pointer pressure / simulated pressure is recorded at all. */
  readonly usesPressure: boolean;
  /** Fill the closed lasso polygon instead of stroking it. */
  readonly fill: boolean;
  readonly erase: boolean;
}

export const BRUSHES: Readonly<Record<ToolId, BrushPreset>> = {
  pen: {
    tool: "pen",
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.45,
    taperStart: 0.6,
    taperEnd: 2.5,
    defaultSize: 9,
    minSize: 1,
    maxSize: 80,
    defaultOpacity: 1,
    usesPressure: true,
    fill: false,
    erase: false,
  },
  marker: {
    tool: "marker",
    thinning: 0,
    smoothing: 0.6,
    streamline: 0.5,
    taperStart: 0,
    taperEnd: 0,
    defaultSize: 22,
    minSize: 2,
    maxSize: 160,
    defaultOpacity: 0.85,
    usesPressure: false,
    fill: false,
    erase: false,
  },
  brush: {
    tool: "brush",
    thinning: 0.82,
    smoothing: 0.62,
    streamline: 0.55,
    taperStart: 1.8,
    taperEnd: 3.5,
    defaultSize: 30,
    minSize: 2,
    maxSize: 240,
    defaultOpacity: 1,
    usesPressure: true,
    fill: false,
    erase: false,
  },
  fill: {
    tool: "fill",
    thinning: 0,
    smoothing: 0.5,
    streamline: 0.5,
    taperStart: 0,
    taperEnd: 0,
    defaultSize: 4,
    minSize: 1,
    maxSize: 40,
    defaultOpacity: 1,
    usesPressure: false,
    fill: true,
    erase: false,
  },
  eraser: {
    tool: "eraser",
    thinning: 0,
    smoothing: 0.5,
    streamline: 0.35,
    taperStart: 0,
    taperEnd: 0,
    defaultSize: 40,
    minSize: 4,
    maxSize: 300,
    defaultOpacity: 1,
    usesPressure: false,
    fill: false,
    erase: true,
  },
};

/** Fully resolved render parameters of one stroke (preset ⊕ per-stroke overrides). */
export interface ResolvedStroke {
  readonly preset: BrushPreset;
  readonly size: number;
  readonly thinning: number;
  readonly smoothing: number;
  readonly taperStart: number;
  readonly taperEnd: number;
}

export function resolveStroke(op: Pick<StrokeOp, "tool" | "size" | "params">): ResolvedStroke {
  const preset = BRUSHES[op.tool];
  const p: StrokeParams = op.params ?? {};
  return {
    preset,
    size: op.size,
    thinning: p.thinning ?? preset.thinning,
    smoothing: p.smoothing ?? preset.smoothing,
    taperStart: p.taperStart ?? preset.taperStart,
    taperEnd: p.taperEnd ?? preset.taperEnd,
  };
}

export function clampSize(tool: ToolId, size: number): number {
  const b = BRUSHES[tool];
  return Math.min(b.maxSize, Math.max(b.minSize, Math.round(size * 10) / 10));
}

/** Curated ink colours that read well on battle maps (dark ink first). */
export const DEFAULT_PALETTE: readonly string[] = [
  "#1f1b18",
  "#f6f1e7",
  "#c62f2f",
  "#e9822b",
  "#f2c230",
  "#3f9b4b",
  "#1f8f8a",
  "#2f6fd1",
  "#7b4bc4",
  "#8a5a3c",
];
