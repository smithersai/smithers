/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0-rc.0
 */

import type { NativeAgent } from "@smthrs/rpc"

/**
 * A fresh random identity for this process's monotonic clock.
 *
 * @private
 * @since 1.0.0-rc.0
 * @throws {never}
 */
export const randomClockId = (): string => crypto.randomUUID()

/**
 * The monotonic clock preflight frames are stamped from.
 *
 * @private
 * @since 1.0.0-rc.0
 * @throws {never}
 */
export const nowMs = (): number => performance.now()

/**
 * The process-wide fetch, bound to the global object.
 *
 * @private
 * @since 1.0.0-rc.0
 * @throws {never}
 */
export const defaultFetch = (): NativeAgent.FetchLike => fetch.bind(globalThis)

/**
 * The lowercase hex SHA-256 of a string's UTF-8 bytes.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
