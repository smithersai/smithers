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
 * `inputs` lists every file the step reads, as paths or globs from the
 * repository root; without it the step reads the whole repository, so every
 * change reruns it. `from` is the id of the step this one was split from.
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
  secretEnv: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  inputs: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  from: Schema.optionalKey(Schema.NonEmptyString)
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
 * @throws {never}
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
 * @throws {never}
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
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const withVariant = (step: Step, variant: Readonly<Record<string, string>>): Step => ({
  ...step,
  command: expand(step.command, variant),
  cwd: expand(step.cwd, variant),
  env: Object.fromEntries(Object.entries(step.env).map(([name, value]) => [name, expand(value, variant)]))
})

/**
 * The events that mean "a change arrived". A job one of them triggers is CI.
 *
 * @category constants
 * @since 0.1.0
 */
export const changeTriggers: ReadonlyArray<string> = ["push", "pull_request", "merge_group"]

/**
 * The name of the recipe or script that is a repository's CI when no
 * workflow is.
 *
 * @category constants
 * @since 0.1.0
 */
export const ciEntry = "ci"

/**
 * The jobs that are the repository's CI, each with every job it needs.
 *
 * An inventory lists everything a repository can run: deploys, migrations,
 * cleaners and dev servers among it. Only these jobs are ever run or turned
 * into targets:
 *
 * 1. every job a change triggers (`changeTriggers`); or, when there is none,
 * 2. the recipe or script named `ci` in a file at the repository root.
 *
 * The answer is empty when the repository has neither, and the program then
 * exits `unsupported` instead of guessing.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const ciJobs = (inventory: Inventory): ReadonlyArray<Job> => {
  const byId = new Map(inventory.jobs.map((job) => [job.id, job]))
  const triggered = inventory.jobs.filter((job) => job.triggers.some((trigger) => changeTriggers.includes(trigger)))
  const entries = inventory.jobs.filter((job) =>
    job.triggers.length === 0 && !job.file.includes("/") && job.id.slice(job.id.indexOf(":") + 1) === ciEntry
  )
  const kept = new Set<string>()
  const keep = (job: Job): void => {
    if (kept.has(job.id)) return
    kept.add(job.id)
    for (const id of job.needs) {
      const needed = byId.get(id)
      if (needed !== undefined) keep(needed)
    }
  }
  for (const job of triggered.length > 0 ? triggered : entries) keep(job)
  return inventory.jobs.filter((job) => kept.has(job.id))
}

/**
 * The inventory narrowed to its CI: `ciJobs` that pass `isRunnable`. The
 * baseline, the generator and the replay work from this, never from the
 * whole inventory.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const ci = (inventory: Inventory): Inventory => ({ ...inventory, jobs: ciJobs(inventory).filter(isRunnable) })
