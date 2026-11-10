/**
 * The platform code of actions.vibe: a random id from the Web Crypto API, which a .vibe file does not read.
 */

/**
 * A fresh random UUID: an act's or a run form's token.
 * @throws {never}
 */
export const randomUUID = (): string => crypto.randomUUID()
