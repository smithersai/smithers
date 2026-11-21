/**
 * Turns an inventory into the targets to declare: one per step of each matrix
 * variant, in dependency order.
 *
 * A job's steps share one machine, so a step can leave files the next step
 * needs. A step a later step relies on is a `setup` target. Smithers build
 * records what each step read, and keeps what it left: a step is answered
 * from the cache while everything it read is unchanged, and what it left is
 * put back when a step after it has to run. A setup target declares no files
 * of its own. Steps split from one step (`Step.from`) stand side by side:
 * none relies on another, and the step after them waits for all of them.
 * Steps split from a command that ran its parts in order (`Step.inOrder`)
 * keep that order: each waits for the one before it, so a part after one
 * that failed does not run.
 *
 * A step that follows another in one working tree can read what that step
 * wrote. Its target declares the step's inputs only when every earlier step
 * in the tree names both what it reads and what it writes (`Step.inputs` and
 * `Step.outputs`). Each of those is then a setup target that always runs and
 * declares its inputs and its outputs: Smithers build lets a target read what the targets
 * it depends on declare as outputs, and a target's key holds the keys of
 * those targets, so a change to a file a setup step read reruns every target
 * after it. Without that, the later target declares the whole repository, as
 * a step with no inputs does: its own inputs would not hold the files the
 * earlier step read, and it would pass stale when one of them changed.
 * GitHub jobs run on separate machines, so `needs` only orders them, and the
 * targets of one job name one machine (`StepTarget.machine`): Smithers build
 * runs them in a checkout, a home and a temporary directory no other job
 * sees. A job whose every step is held to the files it names needs none: two
 * such steps that run the same command, in the same directory and
 * environment, after the same targets, do the same work, and one target runs
 * both.
 * The jobs
 * of any other source run one after another in one working tree, in
 * `Inventory.treeOrder`: each waits for the job before it, as `just ci` runs
 * `build` and then `test` for `ci: build test`, and what a later job relies
 * on is `setup` too.
 *
 * A job's steps run under the tool versions the job names, once per matrix
 * variant when a version is a matrix value. Each distinct set of versions is
 * a leg of the generated workflow: one machine per runner that installs them
 * and runs their targets. A target's text then names its versions, so its key
 * differs from the same step's under another version. A target waits only for
 * targets of its own leg, as it waits only for targets of its own system: a
 * dependency would run under the wrong versions.
 *
 * An inventory also lists work CI never runs on a change: release workflows,
 * and every recipe and script, such as `clean` or `start`. Only what runs on a
 * change becomes a target.
 *
 * @since 0.1.0
 */

import * as Result from "effect/Result"
import {
  type Ci,
  eventsVariable,
  expand,
  generatedWorkflow,
  type Host,
  hostOf,
  type Inventory,
  type Job,
  readsCommit,
  runnerOf,
  runnerSoftware,
  runVariables,
  script,
  shell,
  type Step,
  type Toolchain,
  treeOrder,
  unknownRunner
} from "../contract/Inventory.ts"
import type { Failure } from "../contract/Parts.ts"
import { shardOf } from "../contract/Shard.ts"
import { forShell, forText, type Variant, variantKey, variantsOf } from "./Expressions.ts"
import { chooseToolchains } from "./Toolchains.ts"

/**
 * One target to declare.
 *
 * @category models
 * @since 0.1.0
 */
export interface StepTarget {
  readonly label: string
  readonly rule: "setup" | "check"
  readonly script: string
  readonly env: Readonly<Record<string, string>>
  readonly inheritEnv: ReadonlyArray<string>
  /**
   * The variables a step is given whose values say nothing of what it did unless it used them: the commit and the
   * run's id, number and attempt (`Inventory.runVariables`), which are another at every run, and where the machine
   * has a runner's software (`Inventory.runnerSoftware`), which an image update moves. A step with runner text is
   * given all of them, as a runner gives them to every step. Their values are no part of an observed target's key:
   * its result is reused at another commit unless its run used one of them. Nor are they part of the key of a target held to its inputs, unless
   * its text or one of those inputs names one.
   */
  readonly runEnv: ReadonlyArray<string>
  readonly host: Host | undefined
  readonly dependencies: ReadonlyArray<string>
  readonly title: string
  readonly job: string
  /** The step of the original CI: a step that was split names the step it was split from. */
  readonly step: string
  /** The part of a split step this target runs, as the step's id names it after the step it came from. */
  readonly part: string | undefined
  readonly variant: Variant
  /**
   * The paths and globs the target declares, from the repository root. `undefined` for a `check` target that
   * declares the whole repository: its step names no inputs, or follows a step that does not say what it reads and
   * writes. `undefined` for a `setup` target that declares no files.
   */
  readonly inputs: ReadonlyArray<string> | undefined
  /** What a `setup` target declares it writes; `undefined` when its step does not say. */
  readonly outputs: Outputs | undefined
  /** The other steps this target runs too: the same work at the same point of another job or variant. */
  readonly also: ReadonlyArray<SameStep>
  /**
   * True for a step that is told where Smithers build keeps its cache, as a step that restores or saves a cache
   * is. It keeps files there from one run to the next, and what it finds there is in no record of what it read,
   * so its target always runs.
   */
  readonly keeps: boolean
  /**
   * True for a step split from a command that ran its parts at the same time (`Step.atOnce`). Two such targets of
   * one `step`, job and variant may run at once.
   */
  readonly atOnce: boolean
  /**
   * The directories the target writes at the same time as the targets split from the same command (`Step.shares`):
   * left out of what its run is seen to read.
   */
  readonly shares: ReadonlyArray<string>
  /**
   * The machine the target runs on: one for each GitHub job and matrix variant, as each starts on a runner of its
   * own. Smithers build gives the targets of one machine a private checkout, home and temporary directory.
   * `undefined` for a job whose every step is held to the files it names, which reads and writes nothing else, and
   * for the jobs of a source that shares one working tree.
   */
  readonly machine: string | undefined
}

/**
 * A step that another step's target runs, because both do the same work in
 * the same tree.
 *
 * @category models
 * @since 0.1.0
 */
export interface SameStep {
  readonly title: string
  readonly job: string
  readonly step: string
  readonly variant: Variant
}

/**
 * The directories and files a setup target declares as outputs, from the
 * repository root. Smithers build fails a target that leaves a declared
 * directory missing or empty, or a declared file missing.
 *
 * @category models
 * @since 0.1.0
 */
export interface Outputs {
  readonly directories: ReadonlyArray<string>
  readonly files: ReadonlyArray<string>
}

/**
 * One machine of the generated workflow when targets need different tool
 * versions: a runner, the versions it installs and the targets it runs.
 *
 * @category models
 * @since 0.1.0
 */
export interface Leg {
  readonly id: string
  readonly runner: string
  /** The versions as a person reads them: `node 18, python 3.12`. */
  readonly name: string
  readonly toolchains: ReadonlyArray<Toolchain>
  readonly labels: ReadonlyArray<string>
}

/**
 * Everything the renderer needs.
 *
 * @category models
 * @since 0.1.0
 */
export interface StepPlan {
  readonly targets: ReadonlyArray<StepTarget>
  readonly notes: ReadonlyArray<string>
  readonly runners: ReadonlyArray<string>
  readonly triggers: ReadonlyArray<string>
  /** The tools every target runs under, one entry per tool. Without `legs`, what the workflow installs. */
  readonly toolchains: ReadonlyArray<Toolchain>
  /** Empty when every target runs under the same versions. */
  readonly legs: ReadonlyArray<Leg>
}

/** What Smithers build replaces with its cache directory in the text of a target's command. */
const cacheDirectoryToken = "{smthrs:cache-directory}"

/**
 * The generated GitHub Actions workflow. Reading a repository again finds it,
 * and it is never part of the CI being imported.
 *
 * @category constants
 * @since 0.1.0
 */
export const workflowPath = generatedWorkflow

/**
 * The label of the file group large graphs share.
 *
 * @category constants
 * @since 0.1.0
 */
export const repositoryLabel = "_repository"

interface Tail {
  readonly host: Host | undefined
  readonly labels: ReadonlyArray<string>
  /** True when every step that ran in the working tree up to here names what it reads and what it writes. */
  readonly known: boolean
  readonly versions: string
}

interface Draft extends Omit<StepTarget, "rule" | "script" | "job" | "also" | "keeps"> {
  readonly job: Job
  readonly command: string
  readonly directory: string
  readonly also: Array<SameStep>
  readonly installs: ReadonlyArray<Toolchain>
  readonly versions: string
}

const runnerVariable = /\$\{?((?:GITHUB|RUNNER)_[A-Z0-9_]+)/g

// Where a runner says the event file is.
const eventPath = "GITHUB_EVENT_PATH"
const workflowTriggers: ReadonlySet<string> = new Set(["merge_group", "pull_request", "push", "workflow_dispatch"])

const invalid = (message: string): Result.Result<never, Failure> =>
  Result.fail({ code: "invalid-document", message, part: "generate" })

// Every list sorted here holds distinct values.
const compare = (left: string, right: string): number => left < right ? -1 : 1

const sorted = (values: Iterable<string>): ReadonlyArray<string> => [...new Set(values)].sort(compare)

// The input that names every file: a step with it reads the whole repository.
const everything = "**"

// A job's steps in order, with the steps split from one step kept together. Steps split from a command that ran
// its parts in order (`Step.inOrder`) stay apart: each follows the one before it, and does not run when that failed.
const groupsOf = (steps: ReadonlyArray<Step>): ReadonlyArray<ReadonlyArray<Step>> => {
  const groups: Array<Array<Step>> = []
  for (const step of steps) {
    const last = groups.at(-1)
    const beside = step.from !== undefined && step.inOrder !== true && last?.[0]?.from === step.from
    if (last !== undefined && beside) last.push(step)
    else groups.push([step])
  }
  return groups
}

const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

// The part of a split step a step is: what its id says after the id of the step it came from and a colon.
const partOf = (step: Step): string | undefined => {
  const prefix = `${step.from ?? step.id}:`
  return step.id.length > prefix.length && step.id.startsWith(prefix) ? step.id.slice(prefix.length) : undefined
}

const clean = (text: string): string => text.replace(/[^A-Za-z0-9._-]+/g, "-")

const slug = (text: string): string => {
  const cleaned = clean(text)
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `s-${cleaned}`
}

// The machine of a GitHub job's variant: named as the job is, with the variant when the job has a matrix.
const machineOf = (job: Job, variant: Variant): string =>
  Object.keys(variant).length === 0 ? job.id : `${job.id} ${variantKey(variant)}`

// How a job that needs a runner job of its own is named beside the tool versions it runs under: `job lint`, or
// `job test (node 20, os macos-latest)` for a matrix variant.
const aloneOf = (job: Job, variant: Variant): string => {
  const values = Object.keys(variant).sort((left, right) => left < right ? -1 : 1).map((name) =>
    `${name} ${variant[name]}`
  )
  return values.length === 0 ? `job ${job.id}` : `job ${job.id} (${values.join(", ")})`
}

// True when every step of a job with a checkout of its own would be held to the files it names. Such a job reads
// and writes nothing else, so it needs no machine. The conditions are the ones `draftOf` narrows a step under.
const heldThroughout = (job: Job): boolean => {
  let first = true
  let known = true
  for (const group of groupsOf(job.steps)) {
    for (const step of group) {
      const free = step.runner === undefined || (first && !readsCommit(step))
      const scoped = first || known
      if (!free || !scoped || step.inputs === undefined || step.inputs.includes(everything)) return false
    }
    known = group.every((step) => outputsOf(step) !== undefined)
    first = false
  }
  return true
}

// The versions a target runs under, as a person reads them.
const versionsText = (tools: ReadonlyArray<Toolchain>): string =>
  tools.flatMap((tool) => tool.version === undefined ? [] : [`${tool.name} ${tool.version}`]).join(", ")

const variantSuffix = (variant: Variant): string =>
  Object.keys(variant).sort(compare).map((name) => `--${clean(variant[name] as string)}`).join("")

const directoryOf = (cwd: string): string | undefined => {
  const parts = cwd.split("/").filter((part) => part !== "" && part !== ".")
  return cwd.startsWith("/") || parts.includes("..") ? undefined : parts.join("/")
}

// Characters a glob reader gives a meaning to. Smithers build declares an output as one directory or one file.
const globbed = /[*?[\]{}!]/

// What a step writes, as directories (`dir/**`) and files. `undefined` when the step does not say, or says it in
// a form that is not one directory or one file inside the repository: what it writes is then unknown.
const outputsOf = (step: Step): Outputs | undefined => {
  if (step.outputs === undefined) return undefined
  const directories: Array<string> = []
  const files: Array<string> = []
  for (const output of step.outputs) {
    const whole = output.endsWith("/**")
    const path = directoryOf(whole ? output.slice(0, -3) : output)
    if (path === undefined || path === "" || globbed.test(path)) return undefined
    ;(whole ? directories : files).push(path)
  }
  return { directories: sorted(directories), files: sorted(files) }
}

// Smithers build starts a target's text with `/bin/sh`. The step itself runs
// under the contract's shell, as the baseline runs it: `source`, `time`, `[[`
// and `pipefail` mean in the target what they mean in the repository's CI.
// The lines before it are read the same way by every shell.
const scriptOf = (command: string, directory: string): string =>
  [
    ...(directory === "" ? [] : [`cd -- ${quote(directory)} || exit`]),
    `${shell.join(" ")} ${quote(command)}`
  ].join("\n")

const validate = (inventory: Inventory): Failure | undefined => {
  const fail = (message: string): Failure => ({ code: "invalid-document", message, part: "generate" })
  const jobs = new Set<string>()
  const steps = new Set<string>()
  for (const job of inventory.jobs) {
    if (jobs.has(job.id)) return fail(`Job ${job.id} appears twice.`)
    jobs.add(job.id)
    for (const step of job.steps) {
      if (steps.has(step.id)) return fail(`Step ${step.id} appears twice.`)
      steps.add(step.id)
    }
  }
  for (const job of inventory.jobs) {
    const missing = job.needs.find((need) => !jobs.has(need))
    if (missing !== undefined) return fail(`Job ${job.id} needs ${missing}, which the inventory does not hold.`)
  }
  return undefined
}

// Each job with the job that runs just before it in its working tree added to what it needs. The recipes of one
// Justfile run one after another in one directory, so each waits for the one before it; a job with a checkout of
// its own, as a GitHub job has, waits only for what it names.
const inTreeOrder = (jobs: ReadonlyArray<Job>): ReadonlyArray<Job> => {
  const before = new Map<string, string>()
  for (const order of treeOrder(jobs).values()) {
    for (const [index, id] of order.entries()) {
      if (index > 0) before.set(id, order[index - 1] as string)
    }
  }
  return jobs.map((job) => {
    const prior = before.get(job.id)
    return prior === undefined || job.needs.includes(prior) ? job : { ...job, needs: [...job.needs, prior] }
  })
}

const inDependencyOrder = (jobs: ReadonlyArray<Job>): ReadonlyArray<Job> | undefined => {
  const pending = [...jobs].sort((left, right) => compare(left.id, right.id))
  const placed = new Set<string>()
  const ordered: Array<Job> = []
  while (pending.length > 0) {
    const next = pending.findIndex((job) => job.needs.every((need) => placed.has(need)))
    if (next < 0) return undefined
    const [job] = pending.splice(next, 1) as [Job]
    placed.add(job.id)
    ordered.push(job)
  }
  return ordered
}

/**
 * Plans one target for every step of every job of the CI. Which jobs are the
 * CI is `Inventory.ci`'s rule and no longer decided here. Fails when the
 * document contradicts itself or holds nothing to run.
 *
 * @throws {never}
 * @category planning
 * @since 0.1.0
 */
export const planSteps = (inventory: Ci): Result.Result<StepPlan, Failure> => {
  const problem = validate(inventory)
  if (problem !== undefined) return Result.fail(problem)
  const choice = chooseToolchains(inventory)
  const jobs = inDependencyOrder(inTreeOrder(inventory.jobs))
  if (jobs === undefined) {
    return invalid("The jobs' needs form a cycle, or contradict the order the jobs of one working tree run in.")
  }

  const drafts = new Map<string, Draft>()
  const tails = new Map<string, Array<Tail>>()
  const notes = new Set<string>()
  const runners = new Set<string>()
  // Targets a later target needs on disk: these can never be replayed.
  const reliedOn = new Set<string>()
  // The steps of jobs with a machine of their own, by the work they do: what runs, where, with which values, and
  // after which targets. A second step with the same work joins the first one's target.
  const sameWork = new Map<string, Draft>()

  // The labels taken so far, in lower case. Smithers build refuses a package with two labels that differ only by
  // case.
  const taken = new Set<string>([repositoryLabel.toLowerCase()])

  // A label another step took gets a suffix from this step's id, hashed. An id can be written to equal such a
  // label, so a suffixed label that is taken too is hashed again until one is free.
  const uniqueLabel = (step: Step, variant: Variant): string => {
    const base = `${slug(step.id)}${variantSuffix(variant)}`
    const identity = `${step.id}\n${variantKey(variant)}`
    let label = base
    for (let attempt = 0; taken.has(label.toLowerCase()); attempt += 1) {
      const hashed = shardOf(attempt === 0 ? identity : `${identity}\n${attempt}`, 0x1_0000_0000)
      label = `${base}-${hashed.toString(16)}`
    }
    taken.add(label.toLowerCase())
    return label
  }

  // The tails of the jobs a job needs that run on its system, under its tool versions. Running one under other
  // versions would test the wrong thing, so the two run apart and the workflow fails when either fails.
  const upstreamOf = (job: Job, host: Host | undefined, versions: string): ReadonlyArray<Tail> =>
    job.needs.flatMap((need) => {
      const here = (tails.get(need) as ReadonlyArray<Tail>).filter((tail) => {
        if (tail.host === undefined || tail.host === host) return true
        if (host === undefined) notes.add(`${job.id}: runs on every system, so it does not wait for ${need}.`)
        return false
      })
      const same = here.filter((tail) => tail.versions === versions)
      if (same.length > 0) return same
      for (const tail of here) {
        notes.add(
          `${job.id}: runs with ${versions}, so it does not wait for ${need}, which runs with ${tail.versions}. ` +
            `The workflow still fails when either fails.`
        )
      }
      return []
    })

  const draftOf = (
    job: Job,
    step: Step,
    variant: Variant,
    host: Host | undefined,
    dependencies: ReadonlyArray<string>,
    scoped: boolean,
    own: boolean,
    installs: ReadonlyArray<Toolchain>,
    alone: boolean,
    machine: string | undefined,
    versions: string
  ): Draft | undefined => {
    // A step with runner text is run as that text. It fills in its own `${{ }}`, so only matrix values are written.
    const command = step.runner === undefined ? forShell(step.command, variant) : expand(script(step), variant)
    const cwd = forText(step.cwd, variant)
    const directory = cwd === undefined ? undefined : directoryOf(cwd)
    if (command === undefined || directory === undefined) {
      notes.add(`${step.id}: not generated, it uses a value only GitHub Actions can provide.`)
      return undefined
    }
    const env: Record<string, string> = {}
    for (const name of Object.keys(step.env).sort(compare)) {
      const value = forText(step.env[name] as string, variant)
      if (value === undefined) notes.add(`${step.id}: ${name} is not set, its value exists only on GitHub Actions.`)
      else env[name] = value
    }
    // Without runner text, the runner's own variables reach a step only when it names them. They enter its key,
    // so a step that reads the commit reruns on every commit. Runner text gives its step every runner variable
    // itself, but three things. What a run alone knows: the commit and the run's numbers, which the target passes
    // on from the run (`runEnv`). Where the machine has the software a runner comes with, passed on the same way: a
    // new image moves an SDK, and only a step that used it should run again. And the event file, which the runner
    // names or a replay wrote: its place is the same at every run, and what it holds is one more file the step may
    // read. An unset name is left out.
    const unset = (name: string): boolean => !Object.hasOwn(env, name)
    const inheritEnv = step.runner !== undefined
      ? sorted([eventsVariable, eventPath]).filter(unset)
      : sorted([...command.matchAll(runnerVariable)].map((match) => match[1] as string))
        .filter((name) => name !== "GITHUB_TOKEN" && unset(name))
    const runEnv = step.runner === undefined ? [] : sorted([...runVariables, ...runnerSoftware]).filter(unset)
    const title = `${job.name} / ${step.name ?? step.id}`
    // A step with runner text reads what the steps before it in its job left for it, which no input names, so it
    // is held to its inputs only as the first step of its tree. One that reads the commit is never held to them:
    // its verdict is that commit's. A held step is given the commit and the run's numbers all the same, and
    // Smithers build keys it on them only when its text or one of its inputs names one (`runEnv`).
    const free = step.runner === undefined || (alone && !readsCommit(step))
    // Kept only for a step whose reads its inputs can stand for: see `scoped` where the steps are walked.
    const files = free && scoped && step.inputs !== undefined && !step.inputs.includes(everything)
      ? { inputs: sorted(step.inputs), outputs: outputsOf(step) }
      : { inputs: undefined, outputs: undefined }
    // Steps under different tool versions, or of jobs that run apart, are different work, whatever their text.
    const work = JSON.stringify([host, command, directory, env, inheritEnv, runEnv, dependencies, files, versions])
    const same = own ? sameWork.get(work) : undefined
    if (same !== undefined) {
      same.also.push({ title, job: job.id, step: step.id, variant })
      return same
    }
    const draft: Draft = {
      label: uniqueLabel(step, variant),
      env,
      inheritEnv,
      runEnv,
      host,
      dependencies,
      title,
      step: step.from ?? step.id,
      part: partOf(step),
      variant,
      ...files,
      also: [],
      atOnce: step.atOnce === true,
      shares: step.shares ?? [],
      machine,
      job,
      command,
      directory,
      installs,
      versions
    }
    if (own) sameWork.set(work, draft)
    return draft
  }

  for (const job of jobs) {
    for (const feature of job.unsupported) notes.add(`${job.id}: ${feature.feature}: ${feature.detail}`)
    const jobTails: Array<Tail> = []
    tails.set(job.id, jobTails)
    for (const variant of variantsOf(job)) {
      const runner = runnerOf(job, variant)
      // A variant whose runner the workflow file does not give stays in the repository's own workflow.
      if (unknownRunner(runner)) {
        notes.add(`${job.id}: a variant picks its runner from ${runner}, which the workflow file does not give.`)
        continue
      }
      const runsOn = runner === undefined ? undefined : forText(runner, variant)
      const host = hostOf(runsOn)
      if (host === "win32") notes.add(`${job.id}: runs only on Windows, which generated targets do not support.`)
      else if (runsOn !== undefined) runners.add(runsOn)
      const variantTools = choice.toolsOf(job, variant)
      // A GitHub job starts on a runner of its own, so its targets run on a machine of their own.
      // A job with a step that sends its results out runs on a machine, whose checkout the build keeps for that step.
      const machine = job.source === "github-actions" && (!heldThroughout(job) || (job.kept ?? []).length > 0)
        ? machineOf(job, variant)
        : undefined
      // Two jobs never share a `/tmp`. On Linux each machine has its own, by a mount. A macOS runner has no such
      // mount, so a job with a machine is a runner job of its own there: it is kept apart from every other job,
      // as targets that need other tool versions are, and waits for no job on another runner.
      const tools = versionsText(variantTools)
      const versions = machine !== undefined && host === "darwin"
        ? [tools, aloneOf(job, variant)].filter((part) => part !== "").join(", ")
        : tools
      const upstream = upstreamOf(job, host, versions)
      let previous = sorted(upstream.flatMap((tail) => tail.labels))
      let sharesTree = job.source !== "github-actions"
      // True while every step that ran before in this working tree names what it reads and what it writes.
      let known = upstream.every((tail) => tail.known)
      for (const group of groupsOf(job.steps)) {
        // Steps split from one step each follow the step before them, never each other.
        const made: Array<Draft> = []
        // What an earlier step left in this working tree, these steps can read. Their own inputs stand for all
        // they read only when nothing ran before them, or when all of it is declared.
        // On a machine no step is held to its inputs: a later step reads what an earlier one left there.
        const scoped = machine === undefined && (!(sharesTree && previous.length > 0) || known)
        // A job held to the files it names starts from a fresh checkout and writes only what it declares, so its
        // step can stand for an equal step of another such job. Steps split from one step are kept apart. On a
        // machine a step is its job's alone, as each job of a workflow installs and builds for itself.
        const own = machine === undefined && job.source === "github-actions" && group.length === 1 &&
          group[0]?.from === undefined
        for (const step of group) {
          const alone = !(sharesTree && previous.length > 0)
          const draft = draftOf(job, step, variant, host, previous, scoped, own, variantTools, alone, machine, versions)
          if (draft === undefined) continue
          drafts.set(draft.label, draft)
          made.push(draft)
        }
        if (made.length === 0) continue
        if (sharesTree) { for (const label of previous) reliedOn.add(label) }
        // Steps of one job always share a machine.
        sharesTree = true
        previous = made.map((draft) => draft.label)
        known = made.every((draft) => draft.inputs !== undefined && draft.outputs !== undefined)
      }
      jobTails.push({ host, labels: previous, known, versions })
    }
  }

  if (drafts.size === 0) {
    return Result.fail({
      code: "unsupported",
      message: "No job of the CI has a command.",
      part: "generate"
    })
  }

  if ([...drafts.values()].every((draft) => draft.host === "win32")) {
    return Result.fail({ code: "unsupported", message: "Every job runs only on Windows.", part: "generate" })
  }

  // Targets for Windows are generated and never run, so their versions make no leg.
  const running = [...drafts.values()].filter((draft) => draft.host !== "win32")
  const sets = new Map(running.map((draft) => [draft.versions, draft.installs]))
  const apart = sets.size > 1
  // The line changes nothing the script does; it puts the versions in the target's text, and so in its key.
  const underVersions = (versions: string, script: string): string =>
    apart ? `# Runs under ${versions.replace(/[\r\n\u2028\u2029]+/g, " ")}.\n${script}` : script

  const targets = [...drafts.values()].map(
    ({ command, directory, installs: _installs, job, versions, ...draft }): StepTarget => {
      const setup = reliedOn.has(draft.label)
      // A setup target declares what it reads only together with what it writes: the two let a later target stay
      // narrowed. A target nothing relies on has no use for its outputs.
      const declares = setup && draft.outputs !== undefined
      return {
        ...draft,
        inputs: setup && !declares ? undefined : draft.inputs,
        outputs: declares ? draft.outputs : undefined,
        job: job.id,
        rule: setup ? "setup" : "check",
        keeps: command.includes(cacheDirectoryToken),
        script: underVersions(versions, scriptOf(command, directory))
      }
    }
  )

  const machines = runners.size === 0 ? ["ubuntu-latest"] : sorted(runners)
  const legs = !apart ? [] : machines
    .flatMap((runner) =>
      sorted(sets.keys()).flatMap((versions) => {
        const labels = running
          .filter((draft) => draft.versions === versions && (draft.host === undefined || draft.host === hostOf(runner)))
          .map((draft) => draft.label)
        return labels.length === 0
          ? []
          : [{ runner, name: versions, toolchains: sets.get(versions) as ReadonlyArray<Toolchain>, labels }]
      })
    )
    .map((leg, index): Leg => ({ id: `${index + 1}`, ...leg }))

  return Result.succeed({
    targets,
    toolchains: (running[0] as Draft).installs,
    legs,
    notes: sorted([...notes, ...choice.notes]),
    runners: machines,
    triggers: ((found) => found.length === 0 ? ["pull_request", "push"] : found)(
      sorted(jobs.flatMap((job) => job.triggers).filter((trigger) => workflowTriggers.has(trigger)))
    )
  })
}
