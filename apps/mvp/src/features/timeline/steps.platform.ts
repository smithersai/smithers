/**
 * The platform code of steps.vibe: a fresh random claim owner from the host's `crypto`, which a .vibe file does not read.
 */

/**
 * A fresh random UUID (`crypto.randomUUID()`).
 * @throws {never}
 */
export const randomUUID = (): string => crypto.randomUUID()
