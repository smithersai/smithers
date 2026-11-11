/**
 * The platform code of GitProxy.vibe, which a .vibe file does not read directly (EK4402): the host's
 * Compression Streams API.
 *
 * @since 0.1.0
 */

/**
 * A transform that inflates a gzip request body, from the host's `DecompressionStream`.
 *
 * @category platform
 * @since 0.1.0
 * @throws {never}
 */
export const gunzip = (): DecompressionStream => new DecompressionStream("gzip")
