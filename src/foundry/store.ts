import { FLAG_CREATED, FLAG_DRAWING, FLAG_HIDDEN, MODULE_ID } from "../constants.ts";
import { decodeDrawing } from "../model/serialize.ts";
import type { DecodeResult, StoredDrawing } from "../model/serialize.ts";

/**
 * Persistence: TokenDocument flags, written through the normal document update
 * path so Foundry's server-side permission checks always apply. There is no
 * socket/GM relay that could let a user write what they could not write anyway.
 */

type FlagHolder = Pick<FoundryDocumentBase, "flags">;

function moduleFlags(doc: FlagHolder): Record<string, unknown> {
  return (doc.flags?.[MODULE_ID] ?? {}) as Record<string, unknown>;
}

export function rawDrawing(doc: FlagHolder): unknown {
  return moduleFlags(doc)[FLAG_DRAWING];
}

export function readDrawing(doc: FlagHolder): DecodeResult {
  return decodeDrawing(rawDrawing(doc));
}

export function hasDrawingFlag(doc: FlagHolder): boolean {
  return rawDrawing(doc) !== undefined && rawDrawing(doc) !== null;
}

export function isLayerHidden(doc: FlagHolder): boolean {
  return moduleFlags(doc)[FLAG_HIDDEN] === true;
}

export function isScribbleToken(doc: FlagHolder): boolean {
  return moduleFlags(doc)[FLAG_CREATED] === true;
}

/** Does an update's `changes` touch this module's flags? */
export function touchesModuleFlags(changes: object): boolean {
  const flags = (changes as { flags?: Record<string, unknown> }).flags;
  if (!flags) return false;
  return MODULE_ID in flags || `-=${MODULE_ID}` in flags;
}

/** Native permission check: may `user` modify this token document's data? */
export function canEditToken(doc: FoundryTokenDocument, user: FoundryUser = game.user): boolean {
  if (!doc?.id || !doc.parent) return false;
  try {
    return doc.canUserModify(user, "update", { flags: { [MODULE_ID]: { [FLAG_DRAWING]: null } } });
  } catch {
    return false;
  }
}

export class PermissionError extends Error {
  override name = "PermissionError";
}

/**
 * Write a drawing. Permission is re-checked immediately before writing; the
 * server checks again. `options[MODULE_ID].rev` lets clients recognise echoes.
 */
export async function writeDrawing(doc: FoundryTokenDocument, stored: StoredDrawing): Promise<void> {
  if (!canEditToken(doc)) throw new PermissionError("No permission to modify this token");
  await doc.update({ [`flags.${MODULE_ID}.${FLAG_DRAWING}`]: stored }, { [MODULE_ID]: { rev: stored.rev }, diff: true });
}

export async function setLayerHidden(doc: FoundryTokenDocument, hidden: boolean): Promise<void> {
  if (!canEditToken(doc)) throw new PermissionError("No permission to modify this token");
  await doc.update({ [`flags.${MODULE_ID}.${FLAG_HIDDEN}`]: hidden });
}

/** Copy the drawing to the actor's prototype token so future tokens of this actor carry it. */
export async function writePrototypeDrawing(actor: FoundryActor, stored: StoredDrawing): Promise<void> {
  if (!actor.canUserModify(game.user, "update")) throw new PermissionError("No permission to modify this actor");
  await actor.update({ [`prototypeToken.flags.${MODULE_ID}.${FLAG_DRAWING}`]: stored });
}
