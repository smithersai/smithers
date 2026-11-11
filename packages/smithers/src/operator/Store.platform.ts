/**
 * Host access for the adjacent VibeLang module.
 *
 * @since 1.0.0
 */

import type * as Environment from "../Environment.ts"
import * as Project from "../Project.ts"

/**
 * Parsed project selection for local operator commands.
 * @category models
 * @since 1.0.0
 */
interface LocalOptions {
  readonly root?: string | undefined
  readonly remote?: string | undefined
}
/**
 * Resolves the project root and refuses remote operator access.
 *
 * @private
 * @since 1.0.0
 */
export const localRoot = (options: LocalOptions, environment?: Environment.Source): string =>
  Project.localRoot(options, environment ?? process.env)
