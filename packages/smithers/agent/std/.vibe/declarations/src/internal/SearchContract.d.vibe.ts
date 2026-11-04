/**
 * The failure constructors and the literal escape both Search peers share.
 *
 * The validation and matching rules themselves are public, in
 * `../SearchContract.ts`, because an external peer has to build on them. What
 * is left here is what an external peer never calls: the three `StdError`
 * shapes the contract fails with, the root-failure mapping, and the regex escape a fixed-string search
 * applies before compiling.
 *
 * @since 1.0.0
 */
import type * as PlatformError from "effect/PlatformError";
import * as StdError from "../StdError.vibe";
/**
 * Constructs the common unsupported-pattern failure.
 *
 * @private
 * @since 1.0.0
 */
export declare const invalidPattern: (pattern: string, detail: string) => StdError.StdError;
/**
 * How every rejection {@link invalidPattern} writes begins.
 *
 * @private
 * @since 1.0.0
 */
export declare const rejectionPrefix = "Unsupported ripgrep pattern ";
/**
 * Constructs the common invalid-options failure.
 *
 * @private
 * @since 1.0.0
 */
export declare const invalidInput: (detail: string) => StdError.StdError;
/**
 * Constructs the common missing-root failure.
 *
 * @private
 * @since 1.0.0
 */
export declare const notFound: (path: string) => StdError.StdError;
/**
 * Maps a failure to inspect the search root onto the contract's failures.
 *
 * Only a root that does not exist is `not_found`. Every other reason a stat
 * or listing can fail (a guarded host that fails closed, a permission the
 * process lacks, an I/O error) is a host operation failing, and it is
 * reported as `command_failed` with the platform's own message, so the
 * caller reads the real cause instead of a missing-path claim about a path
 * that exists.
 *
 * @private
 * @since 1.0.0
 */
export declare const rootFailure: (path: string, error: PlatformError.PlatformError) => StdError.StdError;
/**
 * Escapes literal text for JavaScript regular expressions.
 *
 * @private
 * @since 1.0.0
 */
export declare const escapeRegex: (value: string) => string;
