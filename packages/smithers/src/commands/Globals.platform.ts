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
/**
 * @private
 * @since 1.0.0
 */
export const writeNotice = (message: string): void => {
  process.stderr.write(message)
}
/**
 * @private
 * @since 1.0.0
 */
export const selectBackend = (backend: string): void => {
  process.env.SMITHERS_BACKEND = backend
}
