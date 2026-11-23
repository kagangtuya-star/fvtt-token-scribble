import type { ToolId } from "../model/types.ts";

export type Command =
  | { type: "tool"; tool: ToolId }
  | { type: "color"; index: number }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "size"; direction: 1 | -1 }
  | { type: "mirror" }
  | { type: "focus" }
  | { type: "help" }
  | { type: "done" };

export interface KeyLike {
  code: string;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const TOOL_KEYS: Record<string, ToolId> = {
  KeyP: "pen",
  KeyM: "marker",
  KeyB: "brush",
  KeyG: "fill",
  KeyE: "eraser",
};

/** Shortcut labels shown in tooltips and the help panel (physical key codes). */
export const SHORTCUTS = {
  pen: "P",
  marker: "M",
  brush: "B",
  fill: "G",
  eraser: "E",
  mirror: "V",
  focus: "F",
  undo: "Ctrl+Z",
  redo: "Ctrl+Shift+Z",
  sizeDown: "[",
  sizeUp: "]",
  colors: "1 – 0",
  line: "Shift",
  done: "Enter / Esc",
  help: "?",
} as const;

/**
 * Map a key event to an editor command. Uses `code` (physical key) so the
 * shortcuts keep working with IMEs and non-Latin layouts.
 */
export function commandForKey(e: KeyLike): Command | null {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey) {
    if (e.code === "KeyZ") return e.shiftKey ? { type: "redo" } : { type: "undo" };
    if (e.code === "KeyY") return { type: "redo" };
    return null;
  }
  if (mod || e.altKey) return null;
  if (e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Escape") return { type: "done" };
  if (e.code === "Slash" && e.shiftKey) return { type: "help" };
  if (e.shiftKey) return null;
  const tool = TOOL_KEYS[e.code];
  if (tool) return { type: "tool", tool };
  if (e.code === "KeyV") return { type: "mirror" };
  if (e.code === "KeyF") return { type: "focus" };
  if (e.code === "BracketLeft") return { type: "size", direction: -1 };
  if (e.code === "BracketRight") return { type: "size", direction: 1 };
  const digit = /^Digit(\d)$/.exec(e.code);
  if (digit) return { type: "color", index: digit[1] === "0" ? 9 : Number(digit[1]) - 1 };
  return null;
}

/** Keys that must still reach Foundry while editing (modifiers, function keys). */
export function isPassThroughKey(e: KeyLike): boolean {
  return /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/.test(e.code) || /^F\d{1,2}$/.test(e.code);
}
