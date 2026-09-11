/**
 * Model-review lint macros, anchored to the package that declares them.
 *
 * One `lint/PACKAGE.ts` once declared these reviews as workspace-wide targets
 * whose `include` list named every covered package by hand, so putting a
 * package under a rubric meant editing a file in a directory that package
 * does not own. Each rubric is a macro here instead: a package's own
 * PACKAGE.ts declares the review it opts into, and the macro supplies the
 * rubric, the prompt framing, the engine, the model tier, the batch size, and
 * the failure threshold.
 *
 * Every glob a macro emits is workspace-rooted. The review matches its
 * `include` patterns against workspace-relative paths that `git diff` listed
 * and expands `context` against the workspace. A PACKAGE.ts writes in a
 * package-relative frame, so the macro resolves each declared pattern against
 * `cwd` and re-roots it. The diff itself is narrowed to the same patterns, so
 * one package's review re-keys on that package's changes alone.
 *
 * @since 0.1.0
 */
import * as Input from "@smthrs/targets/Input"
import { LlmLint } from "@smthrs/targets/LlmLint"
import type { Engine } from "@smthrs/targets/LlmLint"
import type * as Target from "@smthrs/targets/Target"

/** The base revision a review diffs against when the caller names none. */
const defaultBase = "origin/main"

/** The cheap fast codex tier the reviews run on when the caller names none. */
const defaultModel = "gpt-5.6-luna"

/**
 * The framing every review rubric is prepended with.
 *
 * @category constants
 * @since 0.1.0
 */
export const smithersReviewPrompt = "You are reviewing a diff in `smithers`, an Effect v4 coding-agent harness written from " +
  "scratch. Report only violations of the rubric below. Judgment calls that the rubric does not " +
  "cover are not findings. Prefer no finding over a speculative one."

/**
 * Options accepted by every macro in this module.
 *
 * `cwd` is the workspace-relative package directory the default globs, and any
 * package-relative glob a caller passes, resolve against. It is required: every
 * default glob is package-shaped, so a package-level declaration passes its own
 * directory, for example `packages/smithers/flows/journal`, and a workspace-wide
 * declaration passes `"."` beside its `//`-rooted globs.
 *
 * `engine` selects the CLI the review runs through and `model` is an id that
 * engine accepts. Omitted, the review runs on `codex` with `gpt-5.6-luna`; a
 * Codex review names another Codex tier such as `gpt-5.6-sol`. Any other engine
 * has no default model, so a `claude` review must name a Claude id.
 *
 * @category models
 * @since 0.1.0
 */
export type Options = BaseOptions & EngineOptions

/** The engine and the model id it runs, paired so a model reaches its own CLI. */
type EngineOptions =
  | {
    /** @default "codex" */
    readonly engine?: "codex" | undefined
    /** A Codex model id. @default "gpt-5.6-luna" */
    readonly model?: string | undefined
  }
  | {
    readonly engine: Exclude<Engine, "codex">
    /** A model id the selected engine's CLI accepts. */
    readonly model: string
  }

/** The options that do not depend on the engine. */
interface BaseOptions {
  readonly cwd: string
  /**
   * The changed paths this review covers. Patterns are package-relative unless
   * they carry the `//` workspace-root prefix. Each macro documents its own
   * default.
   */
  readonly include?: ReadonlyArray<Input.Glob> | undefined
  /**
   * Files read into every batch prompt whether or not they changed. Patterns
   * resolve the same way `include` does, but execution crosses package boundaries.
   * A nonempty declaration must match at least one file and fit LlmLint's
   * 512-file and 2 MiB aggregate context limits.
   */
  readonly context?: ReadonlyArray<Input.Glob> | undefined
  /** @default [] */
  readonly deps?: ReadonlyArray<Target.AnyTarget> | undefined
  /** @default "origin/main" */
  readonly base?: string | undefined
  readonly summary?: string | undefined
  /** @default false */
  readonly featured?: boolean | undefined
}

/**
 * The target every macro in this module returns.
 *
 * @category models
 * @since 0.1.0
 */
export type ReviewLint = ReturnType<typeof LlmLint>

/** Re-roots one declared glob so it matches the paths `git diff` lists. */
const anchor = (cwd: string, declaration: Input.Glob): Input.Glob =>
  Input.Glob.make({
    pattern: `//${Input.resolvePath(cwd, declaration.pattern)}`,
    exclude: declaration.exclude.map((entry) => `//${Input.resolvePath(cwd, entry)}`)
  })

/** One rubric's fixed half: everything a caller does not choose. */
interface Rubric {
  readonly summary: string
  readonly rubric: string
  readonly batchSize: number
  readonly failOn: "error" | "warning"
  readonly include: ReadonlyArray<Input.Glob>
  readonly context: ReadonlyArray<Input.Glob>
}

/** Applies one rubric to one package's options. */
const review = (options: Options, rubric: Rubric): ReviewLint => {
  const cwd = options.cwd
  const include = (options.include ?? rubric.include).map((entry) => anchor(cwd, entry))
  const context = (options.context ?? rubric.context).map((entry) => anchor(cwd, entry))
  return LlmLint({
    summary: options.summary ?? rubric.summary,
    featured: options.featured ?? false,
    // `paths` is key material only: it keeps this package's review out of the
    // digest of every unrelated commit, while `include` is what the executor
    // filters the reviewed set with.
    changes: Input.gitDiff({
      base: options.base ?? defaultBase,
      paths: include.map((entry) => entry.pattern.slice(2))
    }),
    include,
    context,
    deps: options.deps ?? [],
    prompt: smithersReviewPrompt,
    rubric: rubric.rubric,
    engine: options.engine ?? "codex",
    model: options.model ?? defaultModel,
    batchSize: rubric.batchSize,
    failOn: rubric.failOn
  })
}

/**
 * Reviews changed sources for identity strings, migrations, persisted
 * schemas, and durable keys.
 *
 * The rubric is written for a package that persists something: a store, a
 * journal, a cache, or a database driver. `include` defaults to `src/**`,
 * which already contains a `src/migrations` tree, and findings fail the
 * target at `error`.
 *
 * @example
 * ```ts
 * import { ReviewTagsMigrationsAndKeys, ReviewDocsAgainstCode, ReviewJsdocAgainstCode } from "./ReviewLint.ts"
 *
 * const reviewTagsMigrationsAndKeys = ReviewTagsMigrationsAndKeys({ cwd: "packages/smithers/flows/journal" })
 * ```
 *
 * @category macros
 * @since 0.1.0
 */
export const ReviewTagsMigrationsAndKeys = (options: Options): ReviewLint =>
  review(options, {
    summary:
      "A cheap Codex review of the diff against origin/main for identity strings, migrations, persisted schemas and durable keys.",
    include: [Input.glob("src/**")],
    context: [],
    batchSize: 2,
    failOn: "error",
    rubric: [
      "1. An identity string passed to `Action.make`, `Flow.make`, a service tag, or a",
      "   `Schema.TaggedError` tag must equal the defining module path. A tag that names a",
      "   different module, a moved module that kept its old tag, or a tag that no longer",
      "   matches the file it is defined in is an error.",
      "2. A rename must rename the identity everywhere and leave no backwards-compatible",
      "   alias, re-export, or fallback branch. A compat alias is an error.",
      "3. A change to a persisted schema, a table, or a stored column must add a NEW migration",
      "   file. Editing a migration that has already shipped is an error.",
      "4. A change to a durable key: a step key, a cache key, a run key, or the material any of",
      "   them hashes, is a replay and cache hazard. It is an error unless the diff carries an",
      "   explicit note saying so.",
      "Report the offending identity or key by name. Line 1 is fine for whole-file findings."
    ].join("\n")
  })

/**
 * Reviews changed public APIs against the prose that documents them.
 *
 * `context` defaults to the package's own `README.md` and `docs/*.md` plus the
 * site API reference pages at
 * `//apps/site/src/content/docs/docs/reference/api/<package>*.mdx`, where
 * `<package>` is the last directory in `cwd`. At the workspace root only the
 * local prose is selected. Override `context` to opt into concept or guide
 * sections. Context crosses package boundaries and is read into every batch
 * whether or not it changed; the set must fit LlmLint's 2 MiB aggregate cap.
 * Findings report at `warning` while the rubric is tuned.
 *
 * @example
 * ```ts
 * import { ReviewTagsMigrationsAndKeys, ReviewDocsAgainstCode, ReviewJsdocAgainstCode } from "./ReviewLint.ts"
 *
 * const reviewDocsAgainstCode = ReviewDocsAgainstCode({ cwd: "packages/smithers/flows/journal" })
 * ```
 *
 * @category macros
 * @since 0.1.0
 */
export const ReviewDocsAgainstCode = (options: Options): ReviewLint => {
  const packageName = Input.resolvePath("", options.cwd).replace(/\/$/, "").split("/").at(-1)!
  return review(options, {
    summary: "A cheap Codex review of changed public APIs against package prose and matching site API references.",
    include: [Input.glob("src/**")],
    context: [
      Input.glob("README.md"),
      Input.glob("docs/*.md"),
      ...(packageName === "." ? [] : [
        Input.glob(`//apps/site/src/content/docs/docs/reference/api/${packageName}*.mdx`)
      ])
    ],
    batchSize: 3,
    failOn: "warning",
    rubric: [
      "The context files are package prose and selected site reference, concept, or guide pages.",
      "Compare their current contents against the changed source, whether or not they changed.",
      "1. A public export whose reference page still describes removed, renamed, or changed",
      "   behavior is a warning against the reference page.",
      "2. A new public export absent from its package's reference page is a warning against the",
      "   reference page.",
      "3. A concept page contradicted by the change is a warning against the concept page.",
      "Name the stale documentation page in `file`. Do not report a source file for these.",
      "Private helpers, tests, and internal modules are out of scope."
    ].join("\n")
  })
}

/**
 * Reviews changed exports against the JSDoc that describes them.
 *
 * `include` defaults to `src/**\/*.ts`, and findings report at `warning` while
 * the rubric is tuned. Presence of JSDoc is already gated by eslint; this
 * rubric is about truthfulness alone.
 *
 * @example
 * ```ts
 * import { ReviewTagsMigrationsAndKeys, ReviewDocsAgainstCode, ReviewJsdocAgainstCode } from "./ReviewLint.ts"
 *
 * const reviewJsdocAgainstCode = ReviewJsdocAgainstCode({ cwd: "packages/smithers/flows/journal" })
 * ```
 *
 * @category macros
 * @since 0.1.0
 */
export const ReviewJsdocAgainstCode = (options: Options): ReviewLint =>
  review(options, {
    summary: "A cheap Codex review of changed exports against their JSDoc.",
    include: [Input.glob("src/**/*.ts")],
    context: [],
    batchSize: 3,
    failOn: "warning",
    rubric: [
      "For each export whose body changed in this diff:",
      "1. The JSDoc prose must still describe what the code does. Prose that describes the old",
      "   behavior is a warning.",
      "2. The documented error channel must match the actual `Schema.TaggedError` union the",
      "   code can fail with. A documented error the code cannot raise, or a raised error the",
      "   doc never mentions, is a warning.",
      "3. A documented default must match the default in the code.",
      "4. `@since` on a NEW export must be the current unreleased version, not a value",
      "   copy-pasted from a neighboring export.",
      "Report against the source file and the line of the JSDoc block. Presence of JSDoc is",
      "already gated by eslint; only truthfulness is in scope."
    ].join("\n")
  })
