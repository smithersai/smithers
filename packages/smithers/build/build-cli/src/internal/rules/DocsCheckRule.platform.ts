/**
 * The platform code of DocsCheckRule.vibe, which a .vibe file does not import as a
 * value (EK4402).
 *
 * @since 1.0.0
 */

import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"

/**
 * Joins host path segments.
 *
 * @category paths
 * @since 1.0.0
 */
export const join = (...segments: ReadonlyArray<string>): string => NodePath.join(...segments)

/**
 * Reads a host file as UTF-8 text.
 *
 * @category files
 * @since 1.0.0
 */
export const readFileUtf8 = (path: string): Promise<string> => Fs.readFile(path, "utf8")
