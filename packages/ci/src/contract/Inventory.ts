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

import * as Brand from "effect/Brand"
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
 * `inputs` lists every file the step reads, from the repository root, in the
 * forms Smithers build's `glob` reads: a path, `dir/**`, `dir/*`, `*`, `**`
 * (dot files match; files git ignores never do). Without `inputs` the step
 * reads the whole repository, so every change reruns it. A target generated
 * from a step with `inputs` runs where a read outside them fails: inputs
 * nobody enforces would let a step pass on a file it never declared, which
 * is a stale pass. `from` is the id of the step this one was split from.
 *
 * `outputs` lists every path the step writes, from the repository root, in
 * the same forms. Without `outputs` the step may write any file, so a step
 * that runs after it in the same working tree cannot be held to its own
 * `inputs`: it may read what this step wrote, and its key would not hold
 * what this step read. A step after one with both `inputs` and `outputs`
 * stays narrowed: its target reads those outputs and its key holds those
 * inputs.
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
  outputs: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
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
 * How long one step may run, in hours. The baseline stops a step that runs
 * longer and counts it failed, and a generated target has the same limit.
 *
 * @category constants
 * @since 0.1.0
 */
export const stepTimeoutHours = 6

/**
 * An operating system a job runs on, in Node's names.
 *
 * @category models
 * @since 0.1.0
 */
export const Host = Schema.Literals(["linux", "darwin", "win32"])

/**
 * A decoded `Host`.
 *
 * @category models
 * @since 0.1.0
 */
export type Host = typeof Host.Type

/**
 * The system a runner name means (`Job.runsOn`, with its matrix values filled
 * in), or `undefined` when the name says nothing about it. A variant whose
 * system is not this machine's is never run here and never named to Smithers
 * build: the replay lists it as not replayed with the feature `otherSystem`.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const hostOf = (runsOn: string | undefined): Host | undefined => {
  if (runsOn === undefined) return undefined
  if (/ubuntu|linux/i.test(runsOn)) return "linux"
  if (/macos|darwin/i.test(runsOn)) return "darwin"
  return /windows/i.test(runsOn) ? "win32" : undefined
}

/**
 * The `NotReplayed` feature of a matrix variant, or a whole job, that runs
 * on another operating system than this machine's.
 *
 * @category constants
 * @since 0.1.0
 */
export const otherSystem = "other-system"

/**
 * The `NotReplayed` feature of a CI job that has no command: every step of
 * it was a host action, such as a checkout and an upload.
 *
 * @category constants
 * @since 0.1.0
 */
export const noCommand = "no-command"

/**
 * The `NotReplayed` feature of a job with a step the generator made no
 * target for. The step's verdict could not be compared, so the job is not
 * run in the baseline either.
 *
 * @category constants
 * @since 0.1.0
 */
export const noTarget = "no-target"

/**
 * The working tree a job shares with the other jobs that name it, or
 * `undefined` for a job that gets a checkout of its own. A GitHub Actions
 * job runs on its own machine. The recipes of one Justfile, the scripts of
 * one `package.json` and the like run one after another in the directory
 * they were started in, so each sees what the one before it built.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const treeOf = (job: Job): string | undefined => job.source === "github-actions" ? undefined : job.file

/**
 * The order the jobs of each shared tree (`treeOf`) run in, by job id,
 * starting at the jobs no other job needs: what a job needs in the order it
 * lists them, each job once, then the job. It is the order `just ci` runs
 * `ci: build test`. `ci` returns the jobs of a
 * shared tree in this order, worked out before a job that only groups
 * others, such as that `ci` recipe, is left out.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const treeOrder = (jobs: ReadonlyArray<Job>): ReadonlyMap<string, ReadonlyArray<string>> => {
  const byId = new Map(jobs.map((job) => [job.id, job]))
  const order = new Map<string, Array<string>>()
  const seen = new Set<string>()
  const visit = (job: Job, tree: string): void => {
    if (seen.has(job.id)) return
    seen.add(job.id)
    for (const id of job.needs) {
      const need = byId.get(id)
      if (need !== undefined && treeOf(need) === tree) visit(need, tree)
    }
    order.set(tree, [...(order.get(tree) ?? []), job.id])
  }
  // A run starts at the jobs nothing needs, such as a `ci` recipe; the rest are reached from them, or are in a cycle.
  const needed = new Set(jobs.flatMap((job) => job.needs))
  for (const job of [...jobs.filter((entry) => !needed.has(entry.id)), ...jobs]) {
    const tree = treeOf(job)
    if (tree !== undefined) visit(job, tree)
  }
  return order
}

/**
 * The `Unsupported.feature` of a job that never exits, such as a dev server
 * or a watcher.
 *
 * @category constants
 * @since 0.1.0
 */
export const longRunning = "long-running"

/**
 * The `Unsupported.feature` of an action step that only prepares the CI
 * host: it checks the repository out, installs a toolchain the inventory
 * lists, restores or saves a cache, or uploads a file. The replay makes the
 * checkout itself and expects the toolchains on the machine, so leaving the
 * step out cannot change a verdict.
 *
 * @category constants
 * @since 0.1.0
 */
export const hostAction = "host-action"

/**
 * The actions that are host actions besides those the importer turns into a
 * toolchain, named without their version.
 *
 * @category constants
 * @since 0.1.0
 */
export const hostActions: ReadonlyArray<string> = [
  "actions/checkout",
  "actions/cache",
  "actions/cache/restore",
  "actions/cache/save",
  "actions/upload-artifact"
]

/**
 * The `Unsupported.feature` of a workflow that runs only for some branches
 * or paths. The replay runs its jobs for every change, which is more often
 * than the CI does and never less. A push limited to tags is not this: see
 * `releaseTrigger`.
 *
 * @category constants
 * @since 0.1.0
 */
export const triggerFilter = "trigger-filter"

/**
 * The `Unsupported.feature` of a workflow whose only change trigger is a
 * push limited to tags. It runs for a release, never for a change, so its
 * jobs are never run.
 *
 * @category constants
 * @since 0.1.0
 */
export const releaseTrigger = "release-trigger"

/**
 * The `Unsupported.feature` of a job whose workflow or own `permissions`
 * grant a `write` scope (`id-token: write` and `write-all` included). Such a
 * job is trusted to change something outside its checkout, so it is never
 * run.
 *
 * @category constants
 * @since 0.1.0
 */
export const writePermission = "write-permission"

/**
 * The feature of the blocker `blockers` adds for a step that receives a
 * secret. Without the secret the step is not what its CI runs, and a tool
 * that publishes or deploys falls back to the credentials of whoever runs
 * it.
 *
 * @category constants
 * @since 0.1.0
 */
export const secret = "secret"

/**
 * The only features a job may have and still be run. Every other feature
 * means the job's commands, run on this machine, are not what its CI runs:
 * a condition nobody evaluated, a variable only the CI host sets, a secret,
 * a service container, an action with no command, a release.
 *
 * @category constants
 * @since 0.1.0
 */
export const harmless: ReadonlyArray<string> = [hostAction, triggerFilter]

/**
 * The reasons a job cannot be reproduced on this machine: its unsupported
 * features that are not `harmless`, and one `secret` entry for each step
 * that receives a secret. A job with one is never run, never turned into a
 * target, and is listed in the report with these reasons.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const blockers = (job: Job): ReadonlyArray<Unsupported> => [
  ...job.unsupported.filter((entry) => !harmless.includes(entry.feature)),
  ...job.steps.flatMap((step) =>
    step.secrets.length === 0
      ? []
      : [{ feature: secret, detail: `${step.id} receives ${step.secrets.join(", ")}` }]
  )
]

/**
 * Whether the baseline and the generator run a job: it has a step and no
 * blocker, so no step of it receives a secret. Running a job with a blocker
 * would report a verdict its CI never gives, and may do what its CI guards
 * against, such as a step meant only for a release.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const isRunnable = (job: Job): boolean => job.steps.length > 0 && blockers(job).length === 0

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
 * The GitHub Actions workflow `apply` writes. A repository that has it is
 * read again with it in place, and its job is never part of the CI being
 * imported.
 *
 * @category constants
 * @since 0.1.0
 */
export const generatedWorkflow = ".github/workflows/smithers-ci.yml"

/**
 * The jobs that are the repository's CI, each with every job it needs.
 * A job of `generatedWorkflow` is never one.
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
  const jobs = inventory.jobs.filter((job) => job.file !== generatedWorkflow)
  const byId = new Map(jobs.map((job) => [job.id, job]))
  const triggered = jobs.filter((job) => job.triggers.some((trigger) => changeTriggers.includes(trigger)))
  const entries = jobs.filter((job) =>
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
  return jobs.filter((job) => kept.has(job.id))
}

/**
 * An inventory that holds only jobs safe to run: what `ci` returns. Every
 * job in it has a step, and every need names a job in it. The generator and
 * the splitter accept nothing else, so no part can run or generate a job
 * that `ci` left out.
 *
 * @category models
 * @since 0.1.0
 */
export type Ci = Inventory & Brand.Brand<"smithers-ci/Ci">

const asCi = Brand.nominal<Ci>()

/**
 * The `Unsupported.feature` of a job left out because a job it needs is.
 *
 * @category constants
 * @since 0.1.0
 */
export const needsLeftOut = "needs"

/**
 * A CI job the program does not run, and why.
 *
 * @category models
 * @since 0.1.0
 */
export const NotReplayed = Schema.Struct({
  job: Schema.NonEmptyString,
  reasons: Schema.Array(Unsupported)
})

/**
 * A decoded `NotReplayed`.
 *
 * @category models
 * @since 0.1.0
 */
export type NotReplayed = typeof NotReplayed.Type

/**
 * Sorts the CI jobs into those run and those left out. A job is left out with every job that needs it. A job with
 * no step is run by nobody: it is listed as left out (`noCommand`) when it had host actions, and is in neither list
 * when it only groups other jobs.
 */
const sort = (
  inventory: Inventory
): { readonly kept: ReadonlyArray<Job>; readonly left: ReadonlyArray<NotReplayed> } => {
  const byId = new Map(inventory.jobs.map((job) => [job.id, job]))
  const reasons = new Map<string, ReadonlyArray<Unsupported>>()
  const reasonsOf = (job: Job): ReadonlyArray<Unsupported> => {
    const known = reasons.get(job.id)
    if (known !== undefined) return known
    // A job that needs itself is refused by the replay; here it only must not loop.
    reasons.set(job.id, [])
    const found = [
      ...blockers(job),
      ...job.needs.flatMap((id) => {
        const need = byId.get(id)
        return need === undefined || reasonsOf(need).length === 0
          ? []
          : [{ feature: needsLeftOut, detail: `${job.id} needs ${id}, which is not replayed` }]
      })
    ]
    reasons.set(job.id, found)
    return found
  }
  /** The nearest jobs with a step that a job waits for, looking through jobs that only group others. */
  const waitsFor = (job: Job, seen: Set<string>): ReadonlyArray<string> =>
    job.needs.flatMap((id) => {
      const need = byId.get(id)
      if (need === undefined || seen.has(id)) return []
      seen.add(id)
      return need.steps.length > 0 ? [id] : waitsFor(need, seen)
    })
  /** Why a job is listed as left out: its reasons, or that all it had was host actions. */
  const listedFor = (job: Job): ReadonlyArray<Unsupported> => {
    const found = reasonsOf(job)
    if (found.length > 0 || job.steps.length > 0) return found
    return job.unsupported.some((entry) => entry.feature === hostAction)
      ? [{ feature: noCommand, detail: `${job.id} has no command to run` }]
      : []
  }
  const jobs = ciJobs(inventory)
  const kept = jobs.filter((job) => job.steps.length > 0 && reasonsOf(job).length === 0)
  // The kept jobs of a shared tree take that tree's places in the order they run.
  const order = treeOrder(jobs)
  const queues = new Map<string, Array<Job>>()
  for (const [tree, ids] of order) {
    queues.set(tree, kept.filter((job) => treeOf(job) === tree).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)))
  }
  const next = (job: Job): Job => queues.get(treeOf(job) ?? "")?.shift() ?? job
  return {
    kept: kept.map(next).map((job) => ({ ...job, needs: waitsFor(job, new Set()) })),
    left: jobs.filter((job) => listedFor(job).length > 0).map((job) => ({ job: job.id, reasons: listedFor(job) }))
  }
}

/**
 * The inventory narrowed to its CI: the `ciJobs` that have a step, have no
 * blocker, and need no job that has one. A need on a job with no step, which
 * only groups other jobs, becomes a need on the jobs it groups. The jobs of
 * one shared tree (`treeOf`) come in the order they run (`treeOrder`): the
 * baseline runs them in that order in one checkout and stops at the first
 * failure, and the targets generated from them must run in the same order.
 * The baseline, the generator and the replay work from this, never from
 * the whole inventory.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const ci = (inventory: Inventory): Ci => asCi({ ...inventory, jobs: sort(inventory).kept })

/**
 * The CI jobs `ci` leaves out, each with its reasons: its blockers, a
 * `needs` entry for each job it needs that is left out, or `noCommand` for
 * a job whose every step was a host action. The report lists them, so a
 * speedup is never read as covering a job that was not run.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const notReplayed = (inventory: Inventory): ReadonlyArray<NotReplayed> => sort(inventory).left

/**
 * What an inventory could not read and belongs to no job, such as a
 * workflow that does not parse: `Inventory.unsupported` without the
 * `smithersBuild` entry, which names a workspace and no gap. The replay
 * report lists these under the jobs not replayed.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const notRead = (inventory: Inventory): ReadonlyArray<Unsupported> =>
  (inventory.unsupported ?? []).filter((entry) => entry.feature !== smithersBuild)

/**
 * The top-level `unsupported` feature of a working tree that differs from
 * its commit. The files are read from the working tree; a replay runs the
 * commits, so the changes are not replayed.
 *
 * @category constants
 * @since 0.1.0
 */
export const uncommittedChanges = "uncommitted-changes"

/**
 * The top-level `unsupported` feature of a repository that already builds
 * with Smithers build. Its `detail` is the workspace file.
 *
 * @category constants
 * @since 0.1.0
 */
export const smithersBuild = "smithers-build"

/**
 * The repository's own Smithers workspace file, or `undefined` when it has
 * none. Such a repository is never converted: `apply` refuses it, and a
 * replay measures its own targets.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const ownWorkspace = (inventory: Inventory): string | undefined =>
  inventory.unsupported?.find((entry) => entry.feature === smithersBuild)?.detail

/**
 * A CI with each job's steps replaced, for a part that splits steps. `ci`
 * cannot be called again on its own result (a root `ci` recipe is gone from
 * it), so this is how a `Ci` is changed. A job given no steps keeps the steps
 * it had: every job of a `Ci` has a step.
 *
 * @throws {never}
 * @category constructors
 * @since 0.1.0
 */
export const withSteps = (inventory: Ci, steps: (job: Job) => ReadonlyArray<Step>): Ci =>
  asCi({
    ...inventory,
    jobs: inventory.jobs.map((job) => {
      const replaced = steps(job)
      return replaced.length === 0 ? job : { ...job, steps: replaced }
    })
  })

/**
 * Why nothing of this CI can be run, or `undefined` when `ci` keeps a job.
 * The replay and `apply` refuse with this text, so a repository reads one
 * answer: it has no CI, or the jobs left out, one per line with their
 * features.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const refusal = (inventory: Inventory): string | undefined => {
  const { kept, left } = sort(inventory)
  if (kept.length > 0) return undefined
  if (left.length === 0) {
    return "no job runs on a push or a pull request, and the repository root has no `ci` recipe or script"
  }
  const width = Math.max(...left.map((entry) => entry.job.length))
  return [
    `0 of ${left.length} CI job${left.length === 1 ? "" : "s"} can be reproduced on this machine`,
    ...left.map((entry) =>
      `  ${entry.job.padEnd(width)}  ${[...new Set(entry.reasons.map((reason) => reason.feature))].join(", ")}`
    )
  ].join("\n")
}
