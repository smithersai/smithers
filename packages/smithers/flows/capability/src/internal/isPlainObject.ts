/**
 * Plain-record test shared by metadata snapshotting and payload validation.
 *
 * @since 0.1.0
 */

/**
 * @since 0.1.0
 * @private
 */
export const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
