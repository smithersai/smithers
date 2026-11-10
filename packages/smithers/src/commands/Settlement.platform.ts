/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

import { hostname as osHostname } from "node:os"

/**
 * @private
 * @since 1.0.0
 */
export const hostname = (): string => osHostname()

/**
 * @private
 * @since 1.0.0
 * @throws {never}
 */
export const pid = (): number => process.pid
