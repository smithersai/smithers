/**
 * Web Crypto access for `BranchIds`, kept in TypeScript because a VibeLang
 * module does not read host globals.
 *
 * @since 1.0.0
 * @private
 */

/**
 * A random UUID from the host's Web Crypto.
 *
 * @since 1.0.0
 * @private
 */
export const randomUUID = (): string => crypto.randomUUID()
