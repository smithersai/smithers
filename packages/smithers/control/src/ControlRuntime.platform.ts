// The platform code of ControlRuntime.vibe: the memory adapter copies stored
// values with structuredClone, as the original TypeScript module did.

/**
 * Copies a stored value. A value that cannot be cloned is a defect, not a
 * typed failure of the caller.
 *
 * @throws {never}
 */
export const snapshot = <A>(value: A): A => structuredClone(value)
