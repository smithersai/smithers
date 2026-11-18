/**
 * Turns an inventory into the targets to declare: one per step of each matrix
 * variant, in dependency order.
 *
 * A job's steps share one machine, so a step can leave files the next step
 * needs. A cache hit restores no files, so only a step nothing later relies on
 * may be replayed. Every other step is a `setup` target, which always runs
 * and declares no files of its own. Steps split from one step (`Step.from`)
 * stand side by side: none relies on another, and the step after them waits
 * for all of them.
 *
 * A step that follows another in one working tree can read what that step
 * wrote. Its target declares the step's inputs only when every earlier step
 * in the tree names both what it reads and what it writes (`Step.inputs` and
 * `Step.outputs`). Each of those is then a setup target that declares its
 * inputs and its outputs: Smithers build lets a target read what the targets
 * it depends on declare as outputs, and a target's key holds the keys of
 * those targets, so a change to a file a setup step read reruns every target
 * after it. Without that, the later target declares the whole repository, as
 * a step with no inputs does: its own inputs would not hold the files the
 * earlier step read, and it would pass stale when one of them changed.
 * GitHub jobs run on separate machines, so `needs` only orders them; the other
 * sources run in one working tree, so what they need is `setup` too.
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
  generatedWorkflow,
  type Host,
  hostOf,
  type Inventory,
  type Job,
  shell,
  type Step,
  type Toolchain
} from "../contract/Inventory.ts"
import type { Failure } from "../contract/Parts.ts"
import { shardOf } from "../contract/Shard.ts"
import { forShell, forText, type Variant } from "./Expressions.ts"
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
  readonly host: Host | undefined
  readonly dependencies: ReadonlyArray<string>
  readonly title: string
  readonly job: string
  /** The step of the original CI: a step that was split names the step it was split from. */
  readonly step: string
  readonly variant: Variant
  /**
   * The paths and globs the target declares, from the repository root. `undefined` for a `check` target that
   * declares the whole repository: its step names no inputs, or follows a step that does not say what it reads and
   * writes. `undefined` for a `setup` target that declares no files.
   */
  readonly inputs: ReadonlyArray<string> | undefined
  /** What a `setup` target declares it writes, beside its marker; `undefined` when it declares only the marker. */
  readonly outputs: Outputs | undefined
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
  /** The tools the generated workflow installs: one entry, and so one version, per tool. */
  readonly toolchains: ReadonlyArray<Toolchain>
}

/**
 * Where a `setup` target records that it ran. The build requires a declared
 * output, and the cache directory stays out of every target's inputs.
 *
 * @category constants
 * @since 0.1.0
 */
export const markerDirectory = ".flows/ci"

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
}

interface Draft extends Omit<StepTarget, "rule" | "script" | "job"> {
  readonly job: Job
  readonly command: string
  readonly directory: string
}

const runnerVariable = /\$\{?((?:GITHUB|RUNNER)_[A-Z0-9_]+)/g
const workflowTriggers: ReadonlySet<string> = new Set(["merge_group", "pull_request", "push", "workflow_dispatch"])

const invalid = (message: string): Result.Result<never, Failure> =>
  Result.fail({ code: "invalid-document", message, part: "generate" })

// Every list sorted here holds distinct values.
const compare = (left: string, right: string): number => left < right ? -1 : 1

const sorted = (values: Iterable<string>): ReadonlyArray<string> => [...new Set(values)].sort(compare)

// The input that names every file: a step with it reads the whole repository.
const everything = "**"

// A job's steps in order, with the steps split from one step kept together.
const groupsOf = (steps: ReadonlyArray<Step>): ReadonlyArray<ReadonlyArray<Step>> => {
  const groups: Array<Array<Step>> = []
  for (const step of steps) {
    const last = groups.at(-1)
    if (last !== undefined && step.from !== undefined && last[0]?.from === step.from) last.push(step)
    else groups.push([step])
  }
  return groups
}

const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

const clean = (text: string): string => text.replace(/[^A-Za-z0-9._-]+/g, "-")

const slug = (text: string): string => {
  const cleaned = clean(text)
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `s-${cleaned}`
}

const variantKey = (variant: Variant): string =>
  JSON.stringify(Object.keys(variant).sort(compare).map((name) => [name, variant[name]]))

const variantsOf = (job: Job): ReadonlyArray<Variant> => {
  const unique = new Map<string, Variant>(job.matrix.map((variant) => [variantKey(variant), variant]))
  return unique.size === 0 ? [{}] : [...unique.keys()].sort(compare).map((key) => unique.get(key) as Variant)
}

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
const scriptOf = (command: string, directory: string, marker: string | undefined): string =>
  [
    ...(marker === undefined ? [] : [`mkdir -p ${markerDirectory} || exit`, `: > ${marker} || exit`]),
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
  const jobs = inDependencyOrder(inventory.jobs)
  if (jobs === undefined) return invalid("The jobs' needs form a cycle.")

  const drafts = new Map<string, Draft>()
  const tails = new Map<string, Array<Tail>>()
  const notes = new Set<string>()
  const runners = new Set<string>()
  // Targets a later target needs on disk: these can never be replayed.
  const reliedOn = new Set<string>()

  // The labels taken so far, in lower case. Smithers build refuses a package with two labels that differ only by
  // case, and a setup target's marker is a file, which a macOS disk finds whatever its case.
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

  // The tails of the jobs a job needs that run on its system.
  const upstreamOf = (job: Job, host: Host | undefined): ReadonlyArray<Tail> =>
    job.needs.flatMap((need) =>
      (tails.get(need) as ReadonlyArray<Tail>).filter((tail) => {
        if (tail.host === undefined || tail.host === host) return true
        if (host === undefined) notes.add(`${job.id}: runs on every system, so it does not wait for ${need}.`)
        return false
      })
    )

  const draftOf = (
    job: Job,
    step: Step,
    variant: Variant,
    host: Host | undefined,
    dependencies: ReadonlyArray<string>,
    scoped: boolean
  ): Draft | undefined => {
    const command = forShell(step.command, variant)
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
    // The runner's own variables reach a step only when it names them. They
    // enter its key, so a step that reads the commit reruns on every commit.
    const inheritEnv = sorted([...command.matchAll(runnerVariable)].map((match) => match[1] as string))
      .filter((name) => name !== "GITHUB_TOKEN" && !Object.hasOwn(env, name))
    return {
      label: uniqueLabel(step, variant),
      env,
      inheritEnv,
      host,
      dependencies,
      title: `${job.name} / ${step.name ?? step.id}`,
      step: step.from ?? step.id,
      variant,
      // Kept only for a step whose reads its inputs can stand for: see `scoped` where the steps are walked.
      ...(scoped && step.inputs !== undefined && !step.inputs.includes(everything)
        ? { inputs: sorted(step.inputs), outputs: outputsOf(step) }
        : { inputs: undefined, outputs: undefined }),
      job,
      command,
      directory
    }
  }

  for (const job of jobs) {
    for (const feature of job.unsupported) notes.add(`${job.id}: ${feature.feature}: ${feature.detail}`)
    const jobTails: Array<Tail> = []
    tails.set(job.id, jobTails)
    for (const variant of variantsOf(job)) {
      const runsOn = job.runsOn === undefined ? undefined : forText(job.runsOn, variant)
      const host = hostOf(runsOn)
      if (host === "win32") notes.add(`${job.id}: runs only on Windows, which generated targets do not support.`)
      else if (runsOn !== undefined) runners.add(runsOn)
      const upstream = upstreamOf(job, host)
      let previous = sorted(upstream.flatMap((tail) => tail.labels))
      let sharesTree = job.source !== "github-actions"
      // True while every step that ran before in this working tree names what it reads and what it writes.
      let known = upstream.every((tail) => tail.known)
      for (const group of groupsOf(job.steps)) {
        // Steps split from one step each follow the step before them, never each other.
        const made: Array<Draft> = []
        // What an earlier step left in this working tree, these steps can read. Their own inputs stand for all
        // they read only when nothing ran before them, or when all of it is declared.
        const scoped = !(sharesTree && previous.length > 0) || known
        for (const step of group) {
          const draft = draftOf(job, step, variant, host, previous, scoped)
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
      jobTails.push({ host, labels: previous, known })
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

  const targets = [...drafts.values()].map(({ command, directory, job, ...draft }): StepTarget => {
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
      script: scriptOf(command, directory, setup ? `${markerDirectory}/${draft.label}` : undefined)
    }
  })

  const tools = chooseToolchains(inventory)
  return Result.succeed({
    targets,
    toolchains: tools.toolchains,
    notes: sorted([...notes, ...tools.notes]),
    runners: runners.size === 0 ? ["ubuntu-latest"] : sorted(runners),
    triggers: ((found) => found.length === 0 ? ["pull_request", "push"] : found)(
      sorted(jobs.flatMap((job) => job.triggers).filter((trigger) => workflowTriggers.has(trigger)))
    )
  })
}
