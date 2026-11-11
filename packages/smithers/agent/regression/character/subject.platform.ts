/**
 * Host reads for the character turn runner.
 *
 * @since 0.1.0
 */

/**
 * Returns the host environment a live seat resolves against.
 *
 * @since 0.1.0
 * @throws {never}
 */
export const hostEnvironment = (): Readonly<Record<string, string | undefined>> => process.env

/**
 * Whether character debugging output is on.
 *
 * @since 0.1.0
 * @throws {never}
 */
export const characterDebug = (): boolean => process.env.CHARACTER_DEBUG !== undefined
