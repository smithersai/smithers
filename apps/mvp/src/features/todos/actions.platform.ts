/**
 * The platform code of actions.vibe: fresh random ids from the host's `crypto`, which a .vibe file does not read.
 */

/**
 * A fresh random UUID (`crypto.randomUUID()`).
 * @throws {never}
 */
export const randomUUID = (): string => crypto.randomUUID()
