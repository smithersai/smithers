/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

/**
 * The environment of the process driving the container CLI, which the
 * transport command inherits apart from the names it overrides.
 *
 * @private
 * @since 1.0.0
 * @throws {never}
 */
export const environment = (): typeof process.env => process.env
