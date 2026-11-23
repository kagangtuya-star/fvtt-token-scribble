import { DEFAULT_MAX_KB, MODULE_ID } from "../constants.ts";
import type { PressureMode } from "../engine/pressure.ts";
import { sanitizeToolState } from "../editor/tool-state.ts";
import type { ToolState } from "../editor/tool-state.ts";

export const SETTINGS = {
  maxKB: "maxStorageKB",
  tokenSize: "newTokenSize",
  createHidden: "createHidden",
  pressure: "pressureMode",
  autoFocus: "autoFocus",
  tools: "toolState",
  dock: "dockPosition",
} as const;

export function registerSettings(): void {
  const L = (k: string) => `TOKEN_SCRIBBLE.Settings.${k}`;
  game.settings.register(MODULE_ID, SETTINGS.maxKB, {
    name: L("MaxKB.Name"),
    hint: L("MaxKB.Hint"),
    scope: "world",
    config: true,
    restricted: true,
    type: Number,
    range: { min: 64, max: 2048, step: 32 },
    default: DEFAULT_MAX_KB,
  });
  game.settings.register(MODULE_ID, SETTINGS.tokenSize, {
    name: L("TokenSize.Name"),
    hint: L("TokenSize.Hint"),
    scope: "world",
    config: true,
    restricted: true,
    type: String,
    choices: {
      "0.5": L("TokenSize.Tiny"),
      "1": L("TokenSize.Medium"),
      "2": L("TokenSize.Large"),
      "3": L("TokenSize.Huge"),
      "4": L("TokenSize.Gargantuan"),
    },
    default: "1",
  });
  game.settings.register(MODULE_ID, SETTINGS.createHidden, {
    name: L("CreateHidden.Name"),
    hint: L("CreateHidden.Hint"),
    scope: "world",
    config: true,
    restricted: true,
    type: Boolean,
    default: false,
  });
  game.settings.register(MODULE_ID, SETTINGS.pressure, {
    name: L("Pressure.Name"),
    hint: L("Pressure.Hint"),
    scope: "client",
    config: true,
    type: String,
    choices: { auto: L("Pressure.Auto"), simulate: L("Pressure.Simulate"), off: L("Pressure.Off") },
    default: "auto",
  });
  game.settings.register(MODULE_ID, SETTINGS.autoFocus, {
    name: L("AutoFocus.Name"),
    hint: L("AutoFocus.Hint"),
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  });
  game.settings.register(MODULE_ID, SETTINGS.tools, {
    scope: "client",
    config: false,
    type: Object,
    default: {},
  });
  game.settings.register(MODULE_ID, SETTINGS.dock, {
    scope: "client",
    config: false,
    type: Object,
    default: {},
  });
}

export const getMaxBytes = (): number => Number(game.settings.get(MODULE_ID, SETTINGS.maxKB) || DEFAULT_MAX_KB) * 1024;

export const getTokenSize = (): number => {
  const v = Number(game.settings.get(MODULE_ID, SETTINGS.tokenSize));
  return Number.isFinite(v) && v > 0 ? v : 1;
};

export const getCreateHidden = (): boolean => game.settings.get(MODULE_ID, SETTINGS.createHidden) === true;

export const getPressureMode = (): PressureMode => {
  const v = game.settings.get(MODULE_ID, SETTINGS.pressure);
  return v === "simulate" || v === "off" ? v : "auto";
};

export const getAutoFocus = (): boolean => game.settings.get(MODULE_ID, SETTINGS.autoFocus) !== false;

export const getToolState = (): ToolState => sanitizeToolState(game.settings.get(MODULE_ID, SETTINGS.tools));

export function saveToolState(state: ToolState): void {
  void game.settings.set(MODULE_ID, SETTINGS.tools, state).catch((err: unknown) => console.warn(`${MODULE_ID} |`, err));
}

export function getDockPosition(): { x: number; y: number } | null {
  const v = game.settings.get(MODULE_ID, SETTINGS.dock) as { x?: unknown; y?: unknown } | null;
  return v && typeof v.x === "number" && typeof v.y === "number" ? { x: v.x, y: v.y } : null;
}

export function saveDockPosition(pos: { x: number; y: number } | null): void {
  void game.settings.set(MODULE_ID, SETTINGS.dock, pos ?? {}).catch((err: unknown) => console.warn(`${MODULE_ID} |`, err));
}
