import { Effect } from "effect";
import { SmithersError } from "@smthrs/errors";
/**
 * Constructs a failure containing safe context and a cause without credentials.
 *
 * @returns The tagged failure, ready to raise or inspect.
 * @since 1.0.0
 * @throws {never}
 */
export declare const makeFailure: () => SmithersError;
/**
 * Looks up recovery guidance for a structurally recognized failure.
 *
 * @param failure - A caught value, possibly from another package copy.
 * @returns The catalog description, or undefined for an unrecognized failure.
 * @since 1.0.0
 * @throws {never}
 */
export declare const describeFailure: (failure: unknown) => string | undefined;
/**
 * Fails with the failure {@link makeFailure} constructs.
 *
 * @since 1.0.0
 */
export declare function raiseFailure(): Effect.Effect<never, SmithersError>;
/**
 * Recovers the failure and reads its machine-readable code.
 *
 * @returns The classified code; nothing escapes.
 * @since 1.0.0
 */
export declare function recoverFailure(): Effect.Effect<string>;
