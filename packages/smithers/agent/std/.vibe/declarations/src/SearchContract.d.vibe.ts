/**
 * The validation and matching rules every Search implementation shares.
 *
 * Both peers shipped here match globs through {@link includedByGlobs} and
 * canonicalize them through {@link canonicalGlob}, so the two implementations
 * cannot drift on what a pattern means, and an external peer binding its own
 * `Search` builds on the same functions. {@link unsatisfiableNotice} is the
 * shared explanation for empty answers caused by impossible globs or ignore
 * exclusions.
 *
 * @since 1.0.0
 */
import type * as Path from "@smthrs/kernel/Path";
import { Effect } from "effect";
import type * as FileSystem from "effect/FileSystem";
import type * as StdError from "./StdError.vibe";
/**
 * Validates Smithers Ripgrep ASCII v1. It is deliberately the intersection of
 * Rust regex and JavaScript RegExp: ASCII patterns, captures, alternation,
 * ASCII character classes and ordinary quantifiers. Lookaround,
 * backreferences, named/inline groups, Unicode/shorthand classes and control
 * escapes are rejected before either implementation runs. Patterns are
 * limited to 4096 bytes, counted repetitions to 1000, group nesting to 128
 * and expanded state machines to 8192 states. Both peers share this
 * compilation boundary; portable matching never backtracks over input.
 *
 * @category validation
 * @since 1.0.0
 */
export declare const validatePattern: (pattern: string, fixedStrings: boolean) => StdError.StdError | undefined;
/**
 * Whether `error` is a pattern or glob rejection this contract wrote.
 *
 * Those messages are host-authored and name the construct that broke, so a
 * caller may show them to a model. A peer's `invalid_pattern` built from
 * `rg`'s stderr is not one of them and stays private.
 *
 * @category validation
 * @since 1.0.0
 */
export declare const isContractRejection: (error: StdError.StdError) => boolean;
/**
 * Validates the portable `-g` grammar before either peer sees it.
 *
 * @category validation
 * @since 1.0.0
 */
export declare const validateGlob: (glob: string) => StdError.StdError | undefined;
/**
 * Compiles a pattern after common validation.
 *
 * @category matching
 * @since 1.0.0
 */
export declare const expression: (pattern: string, fixedStrings: boolean, insensitive: boolean) => RegExp;
/**
 * Rewrites a glob into the one spelling both peers match against.
 *
 * `.` is never a path component either peer can produce, so a leading `./` and
 * every interior `/./` would silently make a pattern unmatchable. Both are
 * folded into the root anchor, which is what a caller writing `./src/**` means.
 * Trailing spaces are dropped because `rg` reads `-g` by gitignore's rules and
 * drops them too, so `"a.ts "` finds `a.ts` in the native peer and has to find
 * it in the in-process one. A leading `!` is preserved so exclusion globs
 * canonicalize the same way.
 *
 * @category matching
 * @since 1.0.0
 */
export declare const canonicalGlob: (glob: string) => string;
/**
 * Matches the supported `-g` subset against a root-relative candidate path.
 *
 * A pattern without `/` matches the basename at any depth. Every other pattern
 * is matched against the candidate's path relative to the search root, anchored
 * at the root, whether or not it carries the optional leading `/`.
 *
 * @category matching
 * @since 1.0.0
 */
export declare const matchesGlob: (pattern: string, relative: string, basename: string) => boolean;
/**
 * Applies ripgrep `-g` ordering: positive globs include and `!` globs exclude.
 *
 * @category matching
 * @since 1.0.0
 */
export declare const includedByGlobs: (globs: ReadonlyArray<string>, relative: string, basename: string) => boolean;
/**
 * Explains the positive globs that no file under the root could ever match.
 *
 * A search that returns nothing is ambiguous: the tree may hold no match, or
 * the pattern may be unsatisfiable — an absolute path written where a
 * root-relative one belongs, a directory that does not exist, a skipped
 * directory, a hidden path with `hidden` left false. Callers attach the result
 * to `notice` when they produced no entries. Ignore exclusions name the
 * `noIgnore: true` escape hatch, while impossible globs explain the correction.
 * This keeps the cases
 * distinguishable. Exclusion globs are ignored: excluding what is not there
 * changes nothing.
 *
 * @category diagnostics
 * @since 1.0.0
 */
export declare const unsatisfiableNotice: (options: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly root: string;
    readonly globs: ReadonlyArray<string>;
    readonly noIgnore?: boolean | undefined;
    readonly ignored?: boolean | undefined;
    readonly hidden: boolean;
}) => Effect.Effect<string | undefined>;
