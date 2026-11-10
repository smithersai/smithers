/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

import { existsSync } from "node:fs"

/**
 * Whether a file exists on the host file system.
 *
 * @throws {never}
 * @private
 * @since 1.0.0
 */
export const exists = (filename: string): boolean => existsSync(filename)
