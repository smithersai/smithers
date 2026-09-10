/**
 * The `glob` projection of Smithers Ripgrep Subset v1.
 *
 * It has the same two peer implementations as `grep` and corresponds to
 * `rg --files -g`: `*`, `**`, `?`, and brace alternatives are supported;
 * results are path sorted; hidden files are opt-in; ignore files are disabled;
 * and the fixed skip-directory convention still permits an explicitly named
 * skipped directory as the root.
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
import * as Flow from "@smthrs/core/Flow"
import { Effect, Schema } from "effect"
import { capability, envelope, rootSubtree } from "./internal/Declaration.ts"
import { MAX_ENTRIES } from "./internal/Text.ts"
import * as Search from "./Search.ts"
import * as Contract from "./SearchContract.ts"
import * as StdError from "./StdError.ts"

/**
 * The registry name for glob.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const name = "glob"
/**
 * The model-facing glob description.
 *
 * @category descriptions
 * @since 1.0.0
 */
export const description = "Find files through the Smithers Ripgrep Subset v1 contract."
/**
 * Input accepted by {@link flow} and {@link run}.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Input = Schema.Struct({
  pattern: Schema.NonEmptyString.annotate({
    description:
      "Ripgrep -g pattern, matched against paths relative to root, never absolute paths: *, ?, {a,b} stay inside one segment, ** crosses directories, a pattern without / matches any basename, and a leading / anchors at root."
  }),
  root: Schema.optional(Schema.String).annotate({
    description: "Search root the pattern is relative to; defaults to /. Pass the project directory."
  }),
  hidden: Schema.optional(Schema.Boolean).annotate({ description: "Ripgrep --hidden." }),
  noIgnore: Schema.optional(Schema.Literal(true)).annotate({
    description: "Ignore files are never consulted; only true is accepted."
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: `Maximum paths, capped at ${MAX_ENTRIES}.`
  })
})
/**
 * Decoded input accepted by the `glob` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type
/**
 * Output produced by {@link run}.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Output = Schema.Struct({
  paths: Schema.Array(Schema.String),
  total: Schema.Int,
  truncated: Schema.Boolean,
  notice: Schema.optional(Schema.String)
})
/**
 * Decoded output returned by the `glob` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type
/**
 * Conservative sealed declaration for all workspace files.
 *
 * @category effects
 * @since 1.0.0
 */
export const effects = envelope({ tier: "sealed", mode: "hermetic", reads: ["/**"], writes: [] })
/**
 * Narrows the read declaration to the requested root subtree.
 *
 * @category effects
 * @since 1.0.0
 */
export const effectsFor = (input: { readonly root?: string | undefined }) =>
  envelope({ tier: "sealed", mode: "hermetic", reads: [rootSubtree(input.root ?? "/")], writes: [] })
/**
 * Capability strings requested by glob.
 *
 * @category capabilities
 * @since 1.0.0
 */
export const capabilities = [capability("fs:read", "/**")]
/**
 * Declaration-only glob flow.
 *
 * @category flows
 * @since 1.0.0
 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

/**
 * Runs one `rg --files -g` contract call through the selected peer implementation.
 *
 * @category handlers
 * @since 1.0.0
 */
export const run = Effect.fn("Glob.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError, Search.Search> {
  // `Input` admits only `true`, so a decoded call never trips this. `run` is
  // exported, and a caller reaching it without decoding still gets the refusal
  // rather than a listing that quietly ignored what it asked for.
  if (input.noIgnore !== undefined && input.noIgnore !== true) {
    return yield* Effect.fail(
      new StdError.StdError({
        code: "invalid_input",
        message: "Invalid ripgrep options: ignore-file handling is not supported; use noIgnore: true"
      })
    )
  }
  const patternError = Contract.validateGlob(input.pattern)
  if (patternError !== undefined) return yield* Effect.fail(patternError)
  const search = yield* Search.Search
  return yield* search.glob({
    pattern: input.pattern,
    root: input.root ?? "/",
    hidden: input.hidden ?? false,
    limit: Math.min(input.limit ?? MAX_ENTRIES, MAX_ENTRIES)
  })
})
