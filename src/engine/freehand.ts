import { getStroke } from "perfect-freehand";
import type { Outliner } from "./geometry.ts";

/**
 * The production outliner: perfect-freehand's `getStroke`.
 *
 * This is the only module importing perfect-freehand, so the rest of the
 * engine stays testable and the library can be swapped per format version.
 */
export const freehandOutliner: Outliner = (points, options) => getStroke(points, options);
