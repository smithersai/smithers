/**
 * The `grep` flow and its Smithers Ripgrep Subset v1 contract.
 *
 * Supported ripgrep semantics: Rust-style regular expressions restricted to
 * Smithers Ripgrep ASCII v1; `-F` (`fixedStrings`); `-i` (`ignoreCase`) and `-S`
 * (`smartCase`); ordered `-g` include/exclude globs; `-A`, `-B`, and `-C`
 * context; per-file `--max-count`; `--files-with-matches`; `--hidden`; and
 * deterministic path/line ordering. Root and nested .gitignore files apply by
 * default, including outside git repositories. `noIgnore: true` opts out.
 * Parent/global ignore files, .git/info/exclude, .ignore and .rgignore are not
 * read. File-type registries are outside v1, and there is no `types` field to
 * pass. Patterns are capped at 4096 ASCII bytes and counted repetitions at 1000. Invalid UTF-8 is replacement-decoded; NUL-bearing
 * files are skipped and counted, while an explicitly named binary file is a
 * typed failure.
 *
 * Results are match-centric, which is `rg --json`'s own grouping: `limit`
 * counts matches, each match carries the context lines that belong to it, and
 * every context line belongs to exactly one match. A budget that counted rows
 * could spend itself on context and drop the match — astropy-7166 paid three
 * frames for exactly that — so a hit is never droppable to make room for its
 * own surroundings. Truncation is disclosed through `notice`.
 *
 * Each returned hit also carries the definition enclosing it when the file's
 * shape says so plainly, so a read window is computed rather than guessed, and
 * a metacharacter pattern that finds nothing is retried as a literal with
 * `retriedAsLiteral` set. Both are properties of the contract rather than of a
 * peer: they are computed in `internal/Grouping.ts` for both implementations.
 *
 * `globs` accepts exactly the shapes `glob` accepts and reads them the same
 * way: every pattern is matched against each candidate's path *relative to
 * `root`*, a pattern without `/` matches the basename at any depth, and a
 * leading `/` or `./` anchors at the root rather than naming a filesystem
 * absolute path. A `root` that names one file is searched whatever the globs
 * say. Caller globs filter after ignores; they never override them. See `Glob` for the full statement of the rules. A search that matched
 * nothing because a positive glob was unsatisfiable says so through `notice`
 * instead of returning a silent empty result.
 *
 * `filesSearched` counts every file the walk and globs admitted, including the binaries
 * `skippedBinary` reports and any file the process could not open. A walk
 * skips what it cannot read rather than failing the call.
 *
 * Native and in-process implementations are peers behind `Search.Search`.
 * This module declares and validates the call; it performs no host access.
 *
 * @since 1.0.0
 */
import { Effect, Schema } from "effect";
import * as Search from "./Search.vibe";
import * as StdError from "./StdError.vibe";
/**
 * The registry name for grep.
 *
 * @category identifiers
 * @since 1.0.0
 */
export declare const name = "grep";
/**
 * The model-facing grep description.
 *
 * @category descriptions
 * @since 1.0.0
 */
export declare const description = "Search file contents through the Smithers Ripgrep Subset v1 contract. limit counts matches, each carrying its own context and enclosing definition; fixedStrings searches a literal, and one is retried.";
/**
 * Input accepted by {@link flow} and {@link run}.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Input: Schema.Struct<{
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
/**
 * Decoded input accepted by the `grep` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type;
/**
 * One matching or context line.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const ContextLine: Schema.Struct<{
    readonly line: Schema.Int;
    readonly text: Schema.String;
}>;
/**
 * The definition a hit sits inside, when the file's shape says so plainly.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Symbol: Schema.Struct<{
    readonly kind: Schema.String;
    readonly name: Schema.String;
    readonly startLine: Schema.Int;
    readonly endLine: Schema.Int;
}>;
/**
 * One hit and the context that belongs to it.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Match: Schema.Struct<{
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
}>;
/**
 * Output produced by {@link run}.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Output: Schema.Struct<{
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
/**
 * Decoded output returned by the `grep` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type;
/**
 * Conservative sealed declaration for all workspace files.
 *
 * @category effects
 * @since 1.0.0
 */
export declare const effects: import("@smthrs/plan/Effects").Declaration;
/**
 * Narrows the read declaration to the requested root subtree.
 *
 * @category effects
 * @since 1.0.0
 */
export declare const effectsFor: (input: {
    readonly root?: string | undefined;
}) => import("@smthrs/plan/Effects").Declaration;
/**
 * Capability strings requested by grep.
 *
 * @category capabilities
 * @since 1.0.0
 */
export declare const capabilities: string[];
/**
 * Declaration-only grep flow.
 *
 * @category flows
 * @since 1.0.0
 */
export declare const flow: {
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
};
/**
 * What a call to this flow does, for a reader of a run.
 *
 * Display metadata only. `@smthrs/registry` `Descriptor.FlowActivity` is the
 * governing vocabulary and `StandardFlows` binds this value onto the flow's
 * descriptor, where the binding site checks it. `declarationDigest` excludes
 * it, so declaring it cannot invalidate a call identity or a cached prompt.
 *
 * @category presentation
 * @since 1.0.0-rc.0
 */
export declare const activity: "reads";
/**
 * How one recorded call to this flow reads: the verb for each settlement, the
 * input field that is its subject, and the measured output fields a one-line
 * summary may count.
 *
 * Display metadata only, governed by `@smthrs/registry`
 * `Descriptor.CallPresentation` and checked where `StandardFlows` binds it.
 *
 * @category presentation
 * @since 1.0.0-rc.0
 */
export declare const presentation: {
    readonly verb: {
        readonly pending: "searching";
        readonly success: "searched";
        readonly failure: "failed to search";
    };
    readonly subject: "pattern";
    readonly result: "matches";
};
/**
 * Runs one validated ripgrep-contract call through the selected peer implementation.
 *
 * A pattern full of metacharacters that finds nothing is the most common way a
 * search lies: `sphinx-16612` searched 867 files for a parenthesised name and
 * read `0 of 867` as "this symbol is not used here". The retry costs one more
 * pass over the same tree only in the case that already found nothing, and the
 * result says plainly that the answer came from the literal reading.
 *
 * @category handlers
 * @since 1.0.0
 */
export declare const run: (input: {
    readonly pattern: string;
    readonly root?: string | undefined;
    readonly fixedStrings?: boolean | undefined;
    readonly ignoreCase?: boolean | undefined;
    readonly smartCase?: boolean | undefined;
    readonly globs?: readonly string[] | undefined;
    readonly beforeContext?: number | undefined;
    readonly afterContext?: number | undefined;
    readonly context?: number | undefined;
    readonly maxCount?: number | undefined;
    readonly filesWithMatches?: boolean | undefined;
    readonly hidden?: boolean | undefined;
    readonly symbols?: boolean | undefined;
    readonly noIgnore?: boolean | undefined;
    readonly limit?: number | undefined;
}) => Effect.Effect<typeof Output.Type, StdError.StdError, Search.Search>;
