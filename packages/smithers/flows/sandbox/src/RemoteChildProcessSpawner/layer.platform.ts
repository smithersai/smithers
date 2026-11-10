/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

/**
 * The environment of the process hosting the spawner, or `undefined` on a
 * runtime without `process`.
 *
 * @private
 * @since 1.0.0
 * @throws {never}
 */
export const hostEnvironment = (): Readonly<Record<string, string | undefined>> | undefined =>
  globalThis.process?.env
