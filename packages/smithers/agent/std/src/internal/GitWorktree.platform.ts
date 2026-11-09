/**
 * Host randomness for the names of shadow repositories and scratch checkouts.
 *
 * @since 1.0.0
 */

/**
 * A random identifier unique enough to name a directory.
 *
 * @throws {never}
 * @since 1.0.0
 */
export const randomId = (): string => globalThis.crypto.randomUUID()
