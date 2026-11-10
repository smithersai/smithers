/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

import { createHash } from "node:crypto"

/**
 * @private
 * @since 1.0.0
 */
export { randomBytes } from "node:crypto"

/**
 * @private
 * @since 1.0.0
 */
export { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

/**
 * @private
 * @since 1.0.0
 */
export { homedir } from "node:os"

/**
 * @private
 * @since 1.0.0
 */
export { isAbsolute, join, resolve } from "node:path"

/**
 * A text's SHA-256 as 64 lowercase hex.
 *
 * @private
 * @since 1.0.0
 */
export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")
