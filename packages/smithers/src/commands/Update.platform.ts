/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

import * as Update from "../Update.ts"

/**
 * @private
 * @since 1.0.0
 */
export const tags = async (): Promise<unknown> => {
  const response = await fetch(Update.registryUrl, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) return undefined
  return response.json()
}
