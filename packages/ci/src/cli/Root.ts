/**
 * Who is running the program.
 *
 * @since 0.1.0
 */

/**
 * True when this process runs as root. On a system with no user ids it does not.
 *
 * @category accessors
 * @since 0.1.0
 * @throws {never}
 */
export const runningAsRoot = (): boolean => process.getuid?.() === 0
