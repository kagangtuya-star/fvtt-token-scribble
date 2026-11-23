import { FLAG_DRAWING, FLAG_REPLACED, MODULE_ID } from "../constants.ts";
import { activeRecord, backupFileName, extForMime, folderFor, imageFileName, restoreSource } from "../model/replace.ts";
import type { ReplaceKind, ReplaceRecord } from "../model/replace.ts";
import { canUseFiles, ensureFolder, fetchBlob, srcExists, uploadFile } from "./files.ts";
import { isLayerHidden, rawDrawing } from "./store.ts";

/**
 * Replace mode, Foundry part: which document field is replaced, the backup
 * of the original, the upload of the new image and the document updates.
 */

export interface ReplaceTarget {
  readonly kind: ReplaceKind;
  readonly name: string;
  /** Document identity, including the scene and the prototype/portrait distinction. */
  readonly key: string;
  /** Document id used in file names. */
  readonly docId: string;
  /** Image path currently in use ("" when none). */
  src(): string;
  /** The backup record, while the document still shows the generated image. */
  record(): ReplaceRecord | null;
  canModify(): boolean;
  /** The world actor whose prototype token can follow a token replacement. */
  prototypeActor(): FoundryActor | null;
  related(kind: ReplaceKind): ReplaceTarget | null;
  /** In-place drawing that would be baked into the image (tokens only). */
  overlay(): unknown;
  update(data: Record<string, unknown>): Promise<unknown>;
}

const FLAG = `flags.${MODULE_ID}.${FLAG_REPLACED}`;
const DRAWING = `flags.${MODULE_ID}.${FLAG_DRAWING}`;

function flagOf(holder: { flags?: Record<string, Record<string, unknown> | undefined> } | null | undefined): unknown {
  return holder?.flags?.[MODULE_ID]?.[FLAG_REPLACED];
}

export function tokenTarget(doc: FoundryTokenDocument): ReplaceTarget {
  const worldActor = () => doc.baseActor ?? (doc.actorLink ? doc.actor : null);
  return {
    kind: "token",
    name: doc.name,
    key: doc.uuid ?? `Scene.${doc.parent?.id}.Token.${doc.id}`,
    docId: doc.id ?? "token",
    src: () => doc.texture.src ?? "",
    record: () => activeRecord(flagOf(doc), doc.texture.src),
    canModify: () => doc.canUserModify(game.user, "update"),
    prototypeActor: () => {
      const actor = worldActor();
      return actor && actor.canUserModify(game.user, "update") ? actor : null;
    },
    related: (kind) => kind === "token" ? tokenTarget(doc) : worldActor() ? portraitTarget(worldActor()!) : null,
    // A hidden drawing layer stays a separate (hidden) layer instead of being baked in.
    overlay: () => (isLayerHidden(doc) ? undefined : rawDrawing(doc)),
    update: (data) => doc.update(data),
  };
}

export function portraitTarget(actor: FoundryActor): ReplaceTarget {
  return {
    kind: "portrait",
    name: actor.name,
    key: `${actor.uuid ?? `Actor.${actor.id}`}.Portrait`,
    docId: actor.id ?? "actor",
    src: () => actor.img ?? "",
    record: () => activeRecord(flagOf(actor), actor.img),
    canModify: () => actor.canUserModify(game.user, "update"),
    prototypeActor: () => null,
    related: (kind) => kind === "portrait" ? portraitTarget(actor) : prototypeTarget(actor),
    overlay: () => undefined,
    update: (data) => actor.update(data),
  };
}

/** Edit the default token from a world actor without requiring a scene token. */
export function prototypeTarget(actor: FoundryActor): ReplaceTarget {
  return {
    kind: "token",
    name: actor.name,
    key: `${actor.uuid ?? `Actor.${actor.id}`}.PrototypeToken`,
    docId: `${actor.id ?? "actor"}-prototype`,
    src: () => actor.prototypeToken.texture.src ?? "",
    record: () => activeRecord(flagOf(actor.prototypeToken), actor.prototypeToken.texture.src),
    canModify: () => actor.canUserModify(game.user, "update"),
    prototypeActor: () => null,
    related: (kind) => kind === "token" ? prototypeTarget(actor) : portraitTarget(actor),
    overlay: () => undefined,
    update: (data) => actor.update(Object.fromEntries(Object.entries(data).map(([key, value]) => [`prototypeToken.${key}`, value]))),
  };
}

export type ReplaceRefusal = "permission" | "files" | "video";

/** Why replace mode cannot run for this target (null: it can). */
export function replaceRefusal(target: ReplaceTarget, isVideo: (src: string) => boolean): ReplaceRefusal | null {
  if (!target.canModify()) return "permission";
  if (!canUseFiles()) return "files";
  if (isVideo(target.src())) return "video";
  return null;
}

export class BackupError extends Error {
  override name = "BackupError";
}

export interface ApplyOptions {
  /** Also point the actor's prototype token at the new image. */
  prototype: boolean;
  /** The in-place drawing was baked into the image: clear it (kept in the record for restore). */
  bakedOverlay: boolean;
  now?: number;
}

/**
 * Upload `image` and switch the target to it. The original is backed up into
 * the world folder first; if that fails nothing is changed.
 */
export async function applyReplacement(target: ReplaceTarget, image: Blob, opts: ApplyOptions): Promise<string> {
  const now = opts.now ?? Date.now();
  const worldId = game.world.id;
  const protoActor = opts.prototype ? target.prototypeActor() : null;
  const protoTarget = protoActor ? prototypeTarget(protoActor) : null;
  // Back up both sources before changing either document: their originals may differ.
  const record = await replacementRecord(target, now);
  const protoRecord = protoTarget ? await replacementRecord(protoTarget, now) : null;
  const folder = folderFor(worldId, target.kind);
  await ensureFolder(folder);
  const path = await uploadFile(
    folder,
    new File([image], imageFileName(target.name, target.docId, now), { type: "image/png" }),
  );
  record.current = path;
  const overlay = opts.bakedOverlay ? target.overlay() : undefined;
  if (record.drawing === undefined && overlay !== undefined && overlay !== null) record.drawing = overlay;
  if (protoTarget) record.proto = true;

  const field = target.kind === "token" ? "texture.src" : "img";
  await target.update({
    [field]: path,
    [FLAG]: record,
    ...(opts.bakedOverlay ? { [DRAWING]: null } : {}),
  });
  if (protoTarget && protoRecord) {
    protoRecord.current = path;
    await protoTarget.update({ "texture.src": path, [FLAG]: protoRecord });
  }
  return path;
}

async function replacementRecord(target: ReplaceTarget, now: number): Promise<ReplaceRecord> {
  const worldId = game.world.id;
  const existing = target.record();
  const original = existing?.original ?? target.src();
  let backup = existing?.backup ?? null;

  if (!existing && original) {
    let copy: Blob;
    try {
      copy = await fetchBlob(original);
    } catch (err) {
      throw new BackupError(`Could not read ${original}: ${(err as Error).message}`);
    }
    const name = backupFileName(original, target.docId, now, extForMime(copy.type));
    try {
      await ensureFolder(folderFor(worldId, "backup"));
      backup = await uploadFile(
        folderFor(worldId, "backup"),
        new File([copy], name, { type: copy.type || "application/octet-stream" }),
      );
    } catch (err) {
      throw new BackupError(`Could not store the backup of ${original}: ${(err as Error).message}`);
    }
  }

  const record: ReplaceRecord = {
    v: 1,
    kind: target.kind,
    original,
    backup,
    current: "",
    at: now,
    by: game.user.id,
  };
  // The first replacement's overlay is the one "restore" brings back.
  const keepDrawing = existing?.drawing;
  if (keepDrawing !== undefined && keepDrawing !== null) record.drawing = keepDrawing;
  if (existing?.proto) record.proto = true;
  return record;
}

/** Put the original image (or its backup) back and forget the record. */
export async function restoreOriginal(target: ReplaceTarget): Promise<string | null> {
  const rec = target.record();
  if (!rec) return null;
  const src = restoreSource(rec, await srcExists(rec.original));
  const field = target.kind === "token" ? "texture.src" : "img";
  await target.update({
    [field]: src || null,
    [FLAG]: null,
    ...(rec.drawing !== undefined ? { [DRAWING]: rec.drawing } : {}),
  });
  const actor = rec.proto ? target.prototypeActor() : null;
  if (actor && actor.prototypeToken.texture.src === rec.current) {
    const proto = prototypeTarget(actor);
    if (proto.record()) await restoreOriginal(proto);
  }
  return src;
}
