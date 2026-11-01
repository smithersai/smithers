/**
 * Prepares a settled exit for the JSON codecs the engine records outcomes
 * through: `undefined` is not a JSON value, so a void success is written as
 * `null`.
 *
 * @since 1.0.0
 */
import * as Exit from "effect/Exit";
/**
 * Rewrites a settled exit's success value to `null` when it is absent.
 *
 * @private
 * @since 1.0.0
 */
export declare const toJsonExit: <E>(self: Exit.Exit<any, E>) => Exit.Exit<any, E>;
