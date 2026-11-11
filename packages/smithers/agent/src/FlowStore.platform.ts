/**
 * Host access for the saved-flow store.
 *
 * @since 0.1.0
 */

/**
 * A fresh name for one save's staging directory.
 *
 * @since 0.1.0
 * @throws {never}
 */
export const generationName = (): string => globalThis.crypto.randomUUID()
