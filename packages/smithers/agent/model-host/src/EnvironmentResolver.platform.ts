/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0-rc.0
 */

/**
 * The process-wide fetch, read when the callback runs so a replaced global applies.
 *
 * @private
 * @since 1.0.0-rc.0
 * @throws {never}
 */
export const defaultFetch = (): typeof globalThis.fetch => globalThis.fetch
