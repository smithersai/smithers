/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

import { randomUUID as randomUUID_ } from "node:crypto"

/**
 * A random version 4 UUID from the host's cryptographic generator.
 *
 * @throws {never}
 * @private
 * @since 1.0.0
 */
export const randomUUID = (): string => randomUUID_()
