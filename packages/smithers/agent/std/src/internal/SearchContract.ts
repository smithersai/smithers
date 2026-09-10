/**
 * The failure constructors and the literal escape both Search peers share.
 *
 * The validation and matching rules themselves are public, in
 * `../SearchContract.ts`, because an external peer has to build on them. What
 * is left here is what an external peer never calls: the three `StdError`
 * shapes the contract fails with, and the regex escape a fixed-string search
 * applies before compiling.
 *
 * @since 1.0.0
 */
import * as StdError from "../StdError.ts"

/**
 * Constructs the common unsupported-pattern failure.
 *
 * @private
 * @since 1.0.0
 */
export const invalidPattern = (pattern: string, detail: string): StdError.StdError =>
  new StdError.StdError({ code: "invalid_pattern", message: `Unsupported ripgrep pattern "${pattern}": ${detail}` })

/**
 * Constructs the common invalid-options failure.
 *
 * @private
 * @since 1.0.0
 */
export const invalidInput = (detail: string): StdError.StdError =>
  new StdError.StdError({ code: "invalid_input", message: `Invalid ripgrep options: ${detail}` })

/**
 * Constructs the common missing-root failure.
 *
 * @private
 * @since 1.0.0
 */
export const notFound = (path: string): StdError.StdError =>
  new StdError.StdError({ code: "not_found", message: `Path not found: ${path}`, path })

/**
 * Escapes literal text for JavaScript regular expressions.
 *
 * @private
 * @since 1.0.0
 */
export const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
