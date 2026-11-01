/**
 * Shell-independent, bounded parsing for the agent command surface.
 *
 * @private
 * @since 0.1.0
 */
import { Effect } from "effect";
import { FsError } from "../FsError.vibe";
/**
 * Maximum UTF-8 bytes accepted in one command string.
 *
 * @private
 * @since 0.1.0
 */
export declare const maximumCommandBytes: number;
/**
 * Maximum tokens accepted in one command string.
 *
 * @private
 * @since 0.1.0
 */
export declare const maximumCommandTokens = 4096;
/**
 * Maximum UTF-16 length accepted in one token.
 *
 * @private
 * @since 0.1.0
 */
export declare const maximumTokenLength = 16384;
/**
 * Positional and named values extracted from an argv tail.
 *
 * @private
 * @since 0.1.0
 */
export interface ParsedFlags {
    args: ReadonlyArray<string>;
    options: Readonly<Record<string, unknown>>;
}
/**
 * Splits a command string into argv without invoking a shell.
 *
 * Quotes and backslashes only affect tokenization. Shell syntax, including
 * substitutions and variable references, remains literal text. Single quotes
 * are literal, so a backslash inside them is an ordinary character; unquoted
 * and double-quoted text honour backslash escapes.
 *
 * @private
 * @since 0.1.0
 */
export declare function lex(commandString: string): Effect.Effect<readonly string[], FsError, never>;
/**
 * Parses long options from an argv tail using a small deterministic grammar.
 *
 * @private
 * @since 0.1.0
 */
export declare function parseFlags(input: ReadonlyArray<string>): Effect.Effect<ParsedFlags, FsError, never>;
