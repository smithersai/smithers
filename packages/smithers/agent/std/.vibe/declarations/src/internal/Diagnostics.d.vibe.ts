/**
 * Keeps a bound language server in step with the files the mutation flows
 * write, and reads back the errors an edit leaves.
 *
 * The server is optional: a host that binds no `LanguageServer` edits files
 * exactly as before, and a server that fails or times out never fails the
 * write that already happened.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as LanguageServer from "../LanguageServer.vibe";
/**
 * Most errors attached to one result.
 *
 * @category internal
 * @since 1.0.0
 */
export declare const MAX_ERRORS = 20;
/**
 * One error-severity diagnostic, at its 1-based position.
 *
 * @category internal
 * @since 1.0.0
 */
export declare const Problem: Schema.Struct<{
    readonly line: Schema.Number;
    readonly character: Schema.Number;
    readonly message: Schema.String;
}>;
/**
 * A decoded {@link Problem}.
 *
 * @category internal
 * @since 1.0.0
 */
export type Problem = typeof Problem.Type;
/**
 * The error-severity items of a document diagnostic report, 1-based.
 *
 * @category internal
 * @since 1.0.0
 */
export declare const errors: (report: unknown) => ReadonlyArray<Problem>;
/**
 * Sends a written file's new text to the bound server, if any. Succeeds with
 * the server that took it.
 *
 * @category internal
 * @since 1.0.0
 */
export declare const sync: (path: string, text: string) => Effect.Effect<LanguageServer.LanguageServer | undefined>;
/**
 * Tells the bound server, if any, that a file is gone.
 *
 * @category internal
 * @since 1.0.0
 */
export declare const close: (path: string) => Effect.Effect<void>;
/**
 * Tells the bound server, if any, to re-read every file it has open, after
 * something other than the mutation flows may have changed them.
 *
 * @category internal
 * @since 1.0.0
 */
export declare const refresh: Effect.Effect<void>;
/**
 * The errors `server` reports for `path`, or `undefined` when it could not
 * answer.
 *
 * @category internal
 * @since 1.0.0
 */
export declare const errorsOf: (server: LanguageServer.LanguageServer, path: string) => Effect.Effect<ReadonlyArray<Problem> | undefined>;
