/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

import * as Bug from "../Bug.ts"
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
export const identity = () => ({ platform: `${process.platform}-${process.arch}`, node: process.versions.node })
/**
 * @private
 * @since 1.0.0
 */
export const post = async (
  endpoint: string,
  payload: string
): Promise<{ readonly status: number; readonly ok: boolean }> => {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    signal: AbortSignal.timeout(Bug.timeoutMs)
  })
  return { status: response.status, ok: response.ok }
}
