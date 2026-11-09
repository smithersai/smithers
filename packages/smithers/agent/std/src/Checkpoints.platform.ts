/**
 * Host randomness for the scratch-checkout leases a container store names.
 *
 * @since 1.0.0
 */

/**
 * A random identifier unique enough to name a checkout directory.
 *
 * @throws {never}
 * @since 1.0.0
 */
export const randomId = (): string => globalThis.crypto.randomUUID()
