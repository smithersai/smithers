/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

/**
 * Whether the embedding host is Bun.
 *
 * @private
 * @since 1.0.0
 */
export const bun = (): boolean => "Bun" in globalThis
