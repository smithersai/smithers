/**
 * The assembled workspace gateway: one HTTP surface carrying the control
 * plane, the sync read path, the served projections, and a health probe.
 * @since 1.0.0
 */

// The platform code of GatewayServer.vibe, which a .vibe file does not use directly (EK4402).

/**
 * 256 random bits, hex-encoded so a query string carries them unescaped.
 *
 * @throws {never}
 * @since 1.0.0
 * @category constructors
 */
export const newTicket = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("")
