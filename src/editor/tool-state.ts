import { BRUSHES, DEFAULT_PALETTE, clampSize } from "../engine/brushes.ts";
import { TOOL_IDS } from "../model/types.ts";
import type { ToolId } from "../model/types.ts";

/** Per-user tool preferences, remembered between sessions. */
export interface ToolState {
  tool: ToolId;
  color: string;
  /** Recently used custom colours (most recent first). */
  recent: string[];
  sizes: Record<ToolId, number>;
  opacity: Record<ToolId, number>;
  /** Pressure sensitivity (perfect-freehand thinning) per tool. */
  thinning: Record<ToolId, number>;
  mirror: boolean;
}

const COLOR_RE = /^#[0-9a-f]{6}$/;
const MAX_RECENT = 5;

export function defaultToolState(): ToolState {
  const sizes = {} as Record<ToolId, number>;
  const opacity = {} as Record<ToolId, number>;
  const thinning = {} as Record<ToolId, number>;
  for (const t of TOOL_IDS) {
    sizes[t] = BRUSHES[t].defaultSize;
    opacity[t] = BRUSHES[t].defaultOpacity;
    thinning[t] = BRUSHES[t].thinning;
  }
  return { tool: "pen", color: DEFAULT_PALETTE[0]!, recent: [], sizes, opacity, thinning, mirror: false };
}

/** Accept anything (stored settings may be stale or hand-edited) and return a valid state. */
export function sanitizeToolState(raw: unknown): ToolState {
  const def = defaultToolState();
  if (typeof raw !== "object" || raw === null) return def;
  const r = raw as Partial<Record<keyof ToolState, unknown>>;
  const state = def;
  if (TOOL_IDS.includes(r.tool as ToolId)) state.tool = r.tool as ToolId;
  if (typeof r.color === "string" && COLOR_RE.test(r.color)) state.color = r.color;
  if (Array.isArray(r.recent)) {
    state.recent = r.recent.filter((c): c is string => typeof c === "string" && COLOR_RE.test(c)).slice(0, MAX_RECENT);
  }
  const sizes = (r.sizes ?? {}) as Record<string, unknown>;
  const opacity = (r.opacity ?? {}) as Record<string, unknown>;
  const thinning = (r.thinning ?? {}) as Record<string, unknown>;
  for (const t of TOOL_IDS) {
    const th = thinning[t];
    if (BRUSHES[t].usesPressure && typeof th === "number" && th >= 0 && th <= 0.95) {
      state.thinning[t] = Math.round(th * 100) / 100;
    }
    if (typeof sizes[t] === "number" && Number.isFinite(sizes[t])) state.sizes[t] = clampSize(t, sizes[t] as number);
    const o = opacity[t];
    if (typeof o === "number" && o >= 0.05 && o <= 1) state.opacity[t] = Math.round(o * 100) / 100;
  }
  state.mirror = r.mirror === true;
  return state;
}

/** Remember a custom colour (palette colours are not added to "recent"). */
export function rememberColor(state: ToolState, color: string): void {
  if (DEFAULT_PALETTE.includes(color)) return;
  state.recent = [color, ...state.recent.filter((c) => c !== color)].slice(0, MAX_RECENT);
}

/** Normalise user colour input (`#RGB`, `#RRGGBB`, any case) to `#rrggbb`. */
export function normalizeColor(input: string): string | null {
  const v = input.trim().toLowerCase();
  if (COLOR_RE.test(v)) return v;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return null;
}
