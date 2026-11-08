/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import * as NodeControl from "./NodeControl.ts"

/**
 * @private
 * @since 1.0.0
 */
export const exists = (path: string): boolean => existsSync(path)
/**
 * @private
 * @since 1.0.0
 */
export const objectsDirectory = (root: string): string =>
  join(dirname(NodeControl.executionDatabasePath(root)), "objects")
