/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

import { join } from "node:path"

/**
 * The runner's journal file in its state directory.
 *
 * @private
 * @since 1.0.0
 * @throws {never}
 */
export const engineDatabase = (stateDir: string): string => join(stateDir, "engine.db")
