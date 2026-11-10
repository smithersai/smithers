/**
 * The platform code of timing.vibe: a random id from the Web Crypto API, which a .vibe file does not read.
 */

/**
 * A fresh random UUID: a route attempt's id.
 * @throws {never}
 */
export const randomUUID = (): string => crypto.randomUUID()
