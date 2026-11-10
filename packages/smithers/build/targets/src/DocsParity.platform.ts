/**
 * The platform code of DocsParity.vibe, which a .vibe file does not import as a
 * value (EK4402).
 *
 * @since 0.1.0
 */

import * as NodePath from "node:path"

/**
 * Joins host path segments.
 *
 * @category paths
 * @since 0.1.0
 */
export const join = (...segments: ReadonlyArray<string>): string => NodePath.join(...segments)
