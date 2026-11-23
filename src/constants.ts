/** Package id; must match module.json. */
export const MODULE_ID = "token-scribble";

/** Flag key holding the structured drawing on a TokenDocument (or prototype token). */
export const FLAG_DRAWING = "drawing";

/** Flag key toggling the visibility of the drawing layer without touching its data. */
export const FLAG_HIDDEN = "hidden";

/** Flag key marking tokens that were created by TokenScribble (blank paper tokens). */
export const FLAG_CREATED = "created";

/** Flag key holding the replace-mode backup record (see src/model/replace.ts). */
export const FLAG_REPLACED = "replaced";

/** Socket event name; requires `"socket": true` in the manifest. */
export const SOCKET_EVENT = `module.${MODULE_ID}`;

/** Transparent texture used by tokens created from scratch. */
export const BLANK_TEXTURE = `modules/${MODULE_ID}/assets/blank.png`;

/** Current persisted drawing format version. */
export const FORMAT_VERSION = 1;

/** Long side of the drawing "paper" coordinate space, in paper units. */
export const PAPER_LONG_SIDE = 1000;

/** Fixed-point factor used when encoding paper coordinates (0.1 unit precision). */
export const COORD_SCALE = 10;

/** Pressure quantisation levels (0..PRESSURE_LEVELS). */
export const PRESSURE_LEVELS = 63;

/** Maximum number of raw input samples accepted for one stroke before it is auto-split. */
export const MAX_SAMPLES_PER_STROKE = 6000;

/**
 * Ids of deleted ops remembered in the stored drawing, so a concurrent writer
 * that never saw the deletion cannot resurrect them. Only needs to outlive the
 * merge window (seconds), so a short list is enough (~2.6 KB at most).
 */
export const MAX_TOMBSTONES = 200;

/** Default storage budget for a single token drawing, in KiB (configurable by the GM). */
export const DEFAULT_MAX_KB = 384;
