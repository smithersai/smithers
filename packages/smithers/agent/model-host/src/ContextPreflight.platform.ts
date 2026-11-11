/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

/**
 * The monotonic clock a preflight's duration is read from.
 *
 * @private
 * @since 1.0.0
 * @throws {never}
 */
export const nowMs = (): number => performance.now()

/**
 * The UTF-8 byte length of a value's JSON. Callers pass already decoded JSON data.
 *
 * @private
 * @since 1.0.0
 * @throws {never}
 */
export const jsonByteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength
