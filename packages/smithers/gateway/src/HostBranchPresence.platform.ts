/**
 * Host-only adapter of the existing branch protocol and lease roster.
 * @since 1.0.0
 */

// The platform code of HostBranchPresence.vibe, which a .vibe file does not use directly (EK4402).

/**
 * A fresh random secret for the host-local share key, minted once per layer build.
 *
 * @throws {never}
 * @since 1.0.0
 * @category constructors
 */
export const hostShareSecret = (): string => crypto.randomUUID() + crypto.randomUUID()
