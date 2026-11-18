/**
 * Contract 4: the inventory of what a repository's CI does today.
 *
 * The importer writes it and the target generator and the baseline run read
 * it. It names commands, never tools: a step is a shell command with a
 * working directory, so a Zig repository driven by a Justfile and a
 * TypeScript monorepo driven by GitHub Actions and Turborepo use one shape.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * Where a job was read from.
 *
 * @category models
 * @since 0.1.0
 */
export const Source = Schema.Literals(["github-actions", "justfile", "makefile", "package-json", "turbo"])

/**
 * A decoded `Source`.
 *
 * @category models
 * @since 0.1.0
 */
export type Source = typeof Source.Type

/**
 * One shell command, run as `shell` followed by `command`. `env` holds plain
 * values; a secret appears only by name in `secrets`, never by value.
 * `secretEnv` names the variable each secret arrives in: variable name to
 * secret name. `command`, `cwd` and `env` values may hold
 * `${{ matrix.<key> }}`, which `withVariant` fills in.
 *
 * @category models
 * @since 0.1.0
 */
export const Step = Schema.Struct({
  id: Schema.NonEmptyString,
  command: Schema.NonEmptyString,
  cwd: Schema.String,
  env: Schema.Record(Schema.String, Schema.String),
  secrets: Schema.Array(Schema.String),
  name: Schema.optionalKey(Schema.String),
  secretEnv: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
})

/**
 * A decoded `Step`.
 *
 * @category models
 * @since 0.1.0
 */
export type Step = typeof Step.Type

/**
 * Something the importer read and cannot reproduce, such as a hosted service
 * container or a third-party action with no command.
 *
 * @category models
 * @since 0.1.0
 */
export const Unsupported = Schema.Struct({
  feature: Schema.NonEmptyString,
  detail: Schema.String
})

/**
 * A decoded `Unsupported`.
 *
 * @category models
 * @since 0.1.0
 */
export type Unsupported = typeof Unsupported.Type

/**
 * One job: steps that run in order on one machine. `needs` names the jobs
 * that must pass first. `matrix` lists one variable assignment per variant;
 * an empty list means the job runs once.
 *
 * @category models
 * @since 0.1.0
 */
export const Job = Schema.Struct({
  id: Schema.NonEmptyString,
  source: Source,
  file: Schema.NonEmptyString,
  name: Schema.String,
  needs: Schema.Array(Schema.String),
  triggers: Schema.Array(Schema.String),
  matrix: Schema.Array(Schema.Record(Schema.String, Schema.String)),
  steps: Schema.Array(Step),
  unsupported: Schema.Array(Unsupported),
  runsOn: Schema.optionalKey(Schema.String)
})

/**
 * A decoded `Job`.
 *
 * @category models
 * @since 0.1.0
 */
export type Job = typeof Job.Type

/**
 * A tool the repository pins, and the file that pins it.
 *
 * @category models
 * @since 0.1.0
 */
export const Toolchain = Schema.Struct({
  name: Schema.NonEmptyString,
  source: Schema.NonEmptyString,
  version: Schema.optionalKey(Schema.String)
})

/**
 * A decoded `Toolchain`.
 *
 * @category models
 * @since 0.1.0
 */
export type Toolchain = typeof Toolchain.Type

/**
 * Everything a repository's CI does at one commit. `unsupported` holds what
 * belongs to a file and to no job, such as a workflow that does not parse.
 *
 * @category models
 * @since 0.1.0
 */
export const Inventory = Schema.Struct({
  version: Schema.Literal(1),
  repository: Schema.NonEmptyString,
  commit: Schema.NonEmptyString,
  toolchains: Schema.Array(Toolchain),
  jobs: Schema.Array(Job),
  unsupported: Schema.optionalKey(Schema.Array(Unsupported))
})

/**
 * A decoded `Inventory`.
 *
 * @category models
 * @since 0.1.0
 */
export type Inventory = typeof Inventory.Type

/**
 * What runs a step: these arguments, then the step's `command`. A step that
 * needs another interpreter names it inside its command.
 *
 * @category constants
 * @since 0.1.0
 */
export const shell = ["bash", "-e", "-c"] as const

/**
 * The `Unsupported.feature` of a job that never exits, such as a dev server
 * or a watcher.
 *
 * @category constants
 * @since 0.1.0
 */
export const longRunning = "long-running"

/**
 * Whether the baseline and the generator run a job: it has a step, and it
 * exits.
 *
 * @category accessors
 * @since 0.1.0
 */
export const isRunnable = (job: Job): boolean =>
  job.steps.length > 0 && !job.unsupported.some((entry) => entry.feature === longRunning)

/**
 * Replaces each `${{ matrix.<key> }}` with the variant's value. A nested
 * value uses a dotted key: `matrix.node.version` is the key `node.version`.
 * A key the variant lacks is left as written.
 *
 * @category accessors
 * @since 0.1.0
 */
export const expand = (text: string, variant: Readonly<Record<string, string>>): string =>
  text.replaceAll(
    /\$\{\{\s*matrix\.([\w.-]+)\s*\}\}/g,
    (whole, key: string) => Object.hasOwn(variant, key) ? String(variant[key]) : whole
  )

/**
 * A step with one matrix variant filled into its command, directory and
 * environment values.
 *
 * @category accessors
 * @since 0.1.0
 */
export const withVariant = (step: Step, variant: Readonly<Record<string, string>>): Step => ({
  ...step,
  command: expand(step.command, variant),
  cwd: expand(step.cwd, variant),
  env: Object.fromEntries(Object.entries(step.env).map(([name, value]) => [name, expand(value, variant)]))
})
