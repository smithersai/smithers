/**
 * The `glob` projection of Smithers Ripgrep Subset v1.
 *
 * It has the same two peer implementations as `grep` and supports the
 * `rg --files -g` pattern subset: `*`, `**`, `?`, and brace alternatives;
 * results are path sorted; hidden files are opt-in; root and nested .gitignore
 * files apply by default (even outside git repositories). `noIgnore: true` opts
 * out. Parent/global ignore files, .git/info/exclude, .ignore and .rgignore
 * are not read. Caller globs filter the remaining files without overriding
 * ignores. An explicitly named ignored or skipped directory is still searched.
 *
 * **Patterns are relative to `root`, never to the filesystem.** A candidate is
 * matched by the path it has *relative to the search root*, so `tests/**\/*.py`
 * — what every caller writing a project-relative pattern means — matches
 * `<root>/tests/admin_views/admin.py`. Three rules follow, and both peers
 * implement all three identically:
 *
 * - A pattern with no `/` matches the **basename** at any depth: `*.py` finds
 *   every Python file in the subtree.
 * - A pattern containing `/` is matched against the root-relative path and is
 *   anchored at the root: `tests/*.py` matches `<root>/tests/a.py` and not
 *   `<root>/src/tests/a.py`.
 * - A leading `/` is the same anchor spelled explicitly, not a filesystem
 *   absolute path: `/a.py` matches only `<root>/a.py`, where bare `a.py` would
 *   match any `a.py` in the subtree. A leading `./` means the same anchor.
 *
 * `**` crosses directory boundaries, `*` and `?` stay inside one segment, and
 * `?` consumes one UTF-8 byte. Trailing spaces are not part of a pattern:
 * `rg` reads `-g` by gitignore's rules and drops them, so `"a.ts "` finds
 * `a.ts`, and a pattern left blank by that is rejected rather than read as no
 * filter at all.
 *
 * A `root` that names one file is that file. It is reported whatever the
 * pattern says, because `rg` searches a path given on its command line without
 * consulting `-g`, and a walk that reaches one file has nothing to filter.
 *
 * A walk skips what it cannot read — a dangling symlink, a link cycle, a
 * directory the process may not list — and reports everything it did reach.
 * One unreadable entry never fails the call.
 *
 * The consequence worth stating is the one that cost a SWE-bench run 41 of its
 * 43 frames: an *absolute* pattern such as `/home/repo/tests/**` is read as the
 * root-relative path `home/repo/tests/**`, which nothing under a root of
 * `/home/repo` can match. That answer is now never silent — a pattern no file
 * under the root could match reports why through `notice`, so "unsatisfiable"
 * and "searched and found none" stay distinguishable.
 *
 * @since 1.0.0
 */
import { Effect, Schema } from "effect";
import * as Search from "./Search.vibe";
import type * as StdError from "./StdError.vibe";
/**
 * The registry name for glob.
 *
 * @category identifiers
 * @since 1.0.0
 */
export declare const name = "glob";
/**
 * The model-facing glob description.
 *
 * @category descriptions
 * @since 1.0.0
 */
export declare const description = "Find files through the Smithers Ripgrep Subset v1 contract.";
/**
 * Input accepted by {@link flow} and {@link run}.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Input: Schema.Struct<{
    readonly pattern: Schema.NonEmptyString;
    readonly root: Schema.optional<Schema.String>;
    readonly hidden: Schema.optional<Schema.Boolean>;
    readonly noIgnore: Schema.optional<Schema.Boolean>;
    readonly limit: Schema.optional<Schema.Int>;
}>;
/**
 * Decoded input accepted by the `glob` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type;
/**
 * Output produced by {@link run}.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Output: Schema.Struct<{
    readonly paths: Schema.$Array<Schema.String>;
    readonly total: Schema.Int;
    readonly truncated: Schema.Boolean;
    readonly notice: Schema.optional<Schema.String>;
}>;
/**
 * Decoded output returned by the `glob` flow.
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
 * Capability strings requested by glob.
 *
 * @category capabilities
 * @since 1.0.0
 */
export declare const capabilities: string[];
/**
 * Declaration-only glob flow.
 *
 * @category flows
 * @since 1.0.0
 */
export declare const flow: {
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
        readonly pending: "listing";
        readonly success: "listed";
        readonly failure: "failed to list";
    };
    readonly subject: "pattern";
    readonly result: "paths";
};
/**
 * Runs one `rg --files -g` contract call through the selected peer implementation.
 *
 * @category handlers
 * @since 1.0.0
 */
export declare const run: (input: {
    readonly pattern: string;
    readonly root?: string | undefined;
    readonly hidden?: boolean | undefined;
    readonly noIgnore?: boolean | undefined;
    readonly limit?: number | undefined;
}) => Effect.Effect<typeof Output.Type, StdError.StdError, Search.Search>;
