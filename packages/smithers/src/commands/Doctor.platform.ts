/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

import type * as Environment from "../Environment.ts"

/**
 * @private
 * @since 1.0.0
 */
export const environment = (): Environment.Source => process.env
