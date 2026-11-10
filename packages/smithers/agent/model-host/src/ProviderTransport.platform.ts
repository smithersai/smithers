/** The platform code of ProviderTransport.vibe, which a .vibe file does not use directly (EK4402). */

/**
 * The runtime's global `fetch`, read now.
 *
 * @throws {never}
 */
export const globalFetch = (): typeof globalThis.fetch => globalThis.fetch
