/**
 * Read-only workspace reconnaissance as a dynamic flow.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
/**
 * Registry name for the explore flow.
 *
 * @category metadata
 * @since 1.0.0
 */
export declare const name: "explore";
/**
 * Model-facing description of the explore flow.
 *
 * @category metadata
 * @since 1.0.0
 */
export declare const description = "Investigate the workspace read-only, cite every finding as file:line, report evidence only, and never propose edits.";
/**
 * Input accepted by the explore flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Input: Schema.Struct<{
    readonly prompt: Schema.String;
}>;
/**
 * Decoded input accepted by the `explore` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type;
/**
 * Output returned by the explore flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Output: Schema.Struct<{
    readonly findings: Schema.String;
}>;
/**
 * Decoded output returned by the `explore` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type;
/**
 * Static effect envelope for read-only workspace reconnaissance.
 *
 * @category effects
 * @since 1.0.0
 */
export declare const effects: import("@smthrs/plan/Effects").Declaration;
/**
 * Narrows the explore effect declaration for one decoded input.
 *
 * @category effects
 * @since 1.0.0
 */
export declare const effectsFor: (_input: typeof Input.Type) => import("@smthrs/plan/Effects").Declaration;
/**
 * Transitive capabilities of the read-only flows available to explore.
 *
 * @category capabilities
 * @since 1.0.0
 */
export declare const capabilities: ReadonlyArray<string>;
/**
 * Constructs an explore flow, optionally pinned to a model.
 *
 * Model selection remains optional so the invoking seat can inject its model.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const make: (options: {
    readonly model?: string | undefined;
}) => {
    readonly name: "explore";
    readonly description: "Investigate the workspace read-only, cite every finding as file:line, report evidence only, and never propose edits.";
    readonly input: Schema.Struct<{
        readonly prompt: Schema.String;
    }>;
    readonly output: Schema.Struct<{
        readonly findings: Schema.String;
    }>;
    readonly model: string | undefined;
    readonly flows: readonly [{
        readonly name: "read";
        readonly description: "Read a text file by 1-based offset and limit. content is RAW file text with no line-number prefixes, so any line of it is an edit anchor as it stands; the numbers are startLine/endLine.";
        readonly input: Schema.Struct<{
            readonly path: Schema.String;
            readonly offset: Schema.optional<Schema.Int>;
            readonly limit: Schema.optional<Schema.Int>;
        }>;
        readonly output: Schema.Struct<{
            readonly content: Schema.String;
            readonly startLine: Schema.Number;
            readonly endLine: Schema.Number;
            readonly totalLines: Schema.Number;
            readonly truncated: Schema.Boolean;
            readonly notice: Schema.optional<Schema.String>;
        }>;
        readonly capabilities: string[];
        readonly effects: import("@smthrs/plan/Effects").Declaration;
    }, {
        readonly name: "ls";
        readonly description: "List a directory with directories first, trailing /, and locale-independent UTF-16 code-unit ordering; use 1-based offset and limit to page large listings.";
        readonly input: Schema.Struct<{
            readonly path: Schema.String;
            readonly offset: Schema.optional<Schema.Int>;
            readonly limit: Schema.optional<Schema.Int>;
        }>;
        readonly output: Schema.Struct<{
            readonly entries: Schema.$Array<Schema.Struct<{
                readonly name: Schema.String;
                readonly kind: Schema.Literals<readonly ["file", "directory"]>;
            }>>;
            readonly total: Schema.Number;
            readonly truncated: Schema.Boolean;
            readonly notice: Schema.optional<Schema.String>;
        }>;
        readonly capabilities: string[];
        readonly effects: import("@smthrs/plan/Effects").Declaration;
    }, {
        readonly name: "glob";
        readonly description: "Find files through the Smithers Ripgrep Subset v1 contract.";
        readonly input: Schema.Struct<{
            readonly pattern: Schema.NonEmptyString;
            readonly root: Schema.optional<Schema.String>;
            readonly hidden: Schema.optional<Schema.Boolean>;
            readonly noIgnore: Schema.optional<Schema.Boolean>;
            readonly limit: Schema.optional<Schema.Int>;
        }>;
        readonly output: Schema.Struct<{
            readonly paths: Schema.$Array<Schema.String>;
            readonly total: Schema.Int;
            readonly truncated: Schema.Boolean;
            readonly notice: Schema.optional<Schema.String>;
        }>;
        readonly capabilities: string[];
        readonly effects: import("@smthrs/plan/Effects").Declaration;
    }, {
        readonly name: "grep";
        readonly description: "Search file contents through the Smithers Ripgrep Subset v1 contract. limit counts matches, each carrying its own context and enclosing definition; fixedStrings searches a literal, and one is retried.";
        readonly input: Schema.Struct<{
            readonly pattern: Schema.String;
            readonly root: Schema.optional<Schema.String>;
            readonly fixedStrings: Schema.optional<Schema.Boolean>;
            readonly ignoreCase: Schema.optional<Schema.Boolean>;
            readonly smartCase: Schema.optional<Schema.Boolean>;
            readonly globs: Schema.optional<Schema.$Array<Schema.String>>;
            readonly beforeContext: Schema.optional<Schema.Int>;
            readonly afterContext: Schema.optional<Schema.Int>;
            readonly context: Schema.optional<Schema.Int>;
            readonly maxCount: Schema.optional<Schema.Int>;
            readonly filesWithMatches: Schema.optional<Schema.Boolean>;
            readonly hidden: Schema.optional<Schema.Boolean>;
            readonly symbols: Schema.optional<Schema.Boolean>;
            readonly noIgnore: Schema.optional<Schema.Boolean>;
            readonly limit: Schema.optional<Schema.Int>;
        }>;
        readonly output: Schema.Struct<{
            readonly matches: Schema.$Array<Schema.Struct<{
                readonly file: Schema.String;
                readonly line: Schema.Int;
                readonly text: Schema.String;
                readonly before: Schema.$Array<Schema.Struct<{
                    readonly line: Schema.Int;
                    readonly text: Schema.String;
                }>>;
                readonly after: Schema.$Array<Schema.Struct<{
                    readonly line: Schema.Int;
                    readonly text: Schema.String;
                }>>;
                readonly symbol: Schema.optional<Schema.Struct<{
                    readonly kind: Schema.String;
                    readonly name: Schema.String;
                    readonly startLine: Schema.Int;
                    readonly endLine: Schema.Int;
                }>>;
            }>>;
            readonly files: Schema.$Array<Schema.String>;
            readonly filesSearched: Schema.Int;
            readonly skippedBinary: Schema.Int;
            readonly truncated: Schema.Boolean;
            readonly retriedAsLiteral: Schema.optional<Schema.Boolean>;
            readonly notice: Schema.optional<Schema.String>;
        }>;
        readonly capabilities: string[];
        readonly effects: import("@smthrs/plan/Effects").Declaration;
    }];
    readonly prompt: "Investigate the workspace read-only, cite every finding as file:line, report evidence only, and never propose edits.";
    readonly capabilities: readonly string[];
    readonly effects: import("@smthrs/plan/Effects").Declaration;
};
/**
 * Default explore declaration with seat-selected model injection.
 *
 * @category flows
 * @since 1.0.0
 */
export declare const flow: {
    readonly name: "explore";
    readonly description: "Investigate the workspace read-only, cite every finding as file:line, report evidence only, and never propose edits.";
    readonly input: Schema.Struct<{
        readonly prompt: Schema.String;
    }>;
    readonly output: Schema.Struct<{
        readonly findings: Schema.String;
    }>;
    readonly model: string | undefined;
    readonly flows: readonly [{
        readonly name: "read";
        readonly description: "Read a text file by 1-based offset and limit. content is RAW file text with no line-number prefixes, so any line of it is an edit anchor as it stands; the numbers are startLine/endLine.";
        readonly input: Schema.Struct<{
            readonly path: Schema.String;
            readonly offset: Schema.optional<Schema.Int>;
            readonly limit: Schema.optional<Schema.Int>;
        }>;
        readonly output: Schema.Struct<{
            readonly content: Schema.String;
            readonly startLine: Schema.Number;
            readonly endLine: Schema.Number;
            readonly totalLines: Schema.Number;
            readonly truncated: Schema.Boolean;
            readonly notice: Schema.optional<Schema.String>;
        }>;
        readonly capabilities: string[];
        readonly effects: import("@smthrs/plan/Effects").Declaration;
    }, {
        readonly name: "ls";
        readonly description: "List a directory with directories first, trailing /, and locale-independent UTF-16 code-unit ordering; use 1-based offset and limit to page large listings.";
        readonly input: Schema.Struct<{
            readonly path: Schema.String;
            readonly offset: Schema.optional<Schema.Int>;
            readonly limit: Schema.optional<Schema.Int>;
        }>;
        readonly output: Schema.Struct<{
            readonly entries: Schema.$Array<Schema.Struct<{
                readonly name: Schema.String;
                readonly kind: Schema.Literals<readonly ["file", "directory"]>;
            }>>;
            readonly total: Schema.Number;
            readonly truncated: Schema.Boolean;
            readonly notice: Schema.optional<Schema.String>;
        }>;
        readonly capabilities: string[];
        readonly effects: import("@smthrs/plan/Effects").Declaration;
    }, {
        readonly name: "glob";
        readonly description: "Find files through the Smithers Ripgrep Subset v1 contract.";
        readonly input: Schema.Struct<{
            readonly pattern: Schema.NonEmptyString;
            readonly root: Schema.optional<Schema.String>;
            readonly hidden: Schema.optional<Schema.Boolean>;
            readonly noIgnore: Schema.optional<Schema.Boolean>;
            readonly limit: Schema.optional<Schema.Int>;
        }>;
        readonly output: Schema.Struct<{
            readonly paths: Schema.$Array<Schema.String>;
            readonly total: Schema.Int;
            readonly truncated: Schema.Boolean;
            readonly notice: Schema.optional<Schema.String>;
        }>;
        readonly capabilities: string[];
        readonly effects: import("@smthrs/plan/Effects").Declaration;
    }, {
        readonly name: "grep";
        readonly description: "Search file contents through the Smithers Ripgrep Subset v1 contract. limit counts matches, each carrying its own context and enclosing definition; fixedStrings searches a literal, and one is retried.";
        readonly input: Schema.Struct<{
            readonly pattern: Schema.String;
            readonly root: Schema.optional<Schema.String>;
            readonly fixedStrings: Schema.optional<Schema.Boolean>;
            readonly ignoreCase: Schema.optional<Schema.Boolean>;
            readonly smartCase: Schema.optional<Schema.Boolean>;
            readonly globs: Schema.optional<Schema.$Array<Schema.String>>;
            readonly beforeContext: Schema.optional<Schema.Int>;
            readonly afterContext: Schema.optional<Schema.Int>;
            readonly context: Schema.optional<Schema.Int>;
            readonly maxCount: Schema.optional<Schema.Int>;
            readonly filesWithMatches: Schema.optional<Schema.Boolean>;
            readonly hidden: Schema.optional<Schema.Boolean>;
            readonly symbols: Schema.optional<Schema.Boolean>;
            readonly noIgnore: Schema.optional<Schema.Boolean>;
            readonly limit: Schema.optional<Schema.Int>;
        }>;
        readonly output: Schema.Struct<{
            readonly matches: Schema.$Array<Schema.Struct<{
                readonly file: Schema.String;
                readonly line: Schema.Int;
                readonly text: Schema.String;
                readonly before: Schema.$Array<Schema.Struct<{
                    readonly line: Schema.Int;
                    readonly text: Schema.String;
                }>>;
                readonly after: Schema.$Array<Schema.Struct<{
                    readonly line: Schema.Int;
                    readonly text: Schema.String;
                }>>;
                readonly symbol: Schema.optional<Schema.Struct<{
                    readonly kind: Schema.String;
                    readonly name: Schema.String;
                    readonly startLine: Schema.Int;
                    readonly endLine: Schema.Int;
                }>>;
            }>>;
            readonly files: Schema.$Array<Schema.String>;
            readonly filesSearched: Schema.Int;
            readonly skippedBinary: Schema.Int;
            readonly truncated: Schema.Boolean;
            readonly retriedAsLiteral: Schema.optional<Schema.Boolean>;
            readonly notice: Schema.optional<Schema.String>;
        }>;
        readonly capabilities: string[];
        readonly effects: import("@smthrs/plan/Effects").Declaration;
    }];
    readonly prompt: "Investigate the workspace read-only, cite every finding as file:line, report evidence only, and never propose edits.";
    readonly capabilities: readonly string[];
    readonly effects: import("@smthrs/plan/Effects").Declaration;
};
