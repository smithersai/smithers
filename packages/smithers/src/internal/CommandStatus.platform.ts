/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

/**
 * Sets the process exit status.
 *
 * @throws {never}
 * @private
 * @since 1.0.0
 */
export const setExitCode = (code: number): void => {
  process.exitCode = code
}
