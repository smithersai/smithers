/**
 * The platform code of store.vibe: a random id from the Web Crypto API, which a .vibe file does not read.
 */

/**
 * A fresh random UUID: this store's steer namespace.
 * @throws {never}
 */
export const randomUUID = (): string => crypto.randomUUID()
