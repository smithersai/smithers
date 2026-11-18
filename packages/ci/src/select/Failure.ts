/**
 * The failure every part of fast mode answers with.
 *
 * @since 0.1.0
 */

import type { Failure } from "../contract/Parts.ts"

/**
 * A `select` failure with `code` and `message`.
 *
 * @category constructors
 * @since 0.1.0
 * @throws {never}
 */
export const failure = (code: Failure["code"], message: string): Failure => ({ code, message, part: "select" })
