/**
 * The pure half of the replay: which steps a baseline runs, how attempts settle
 * a target, and how run records become the replay report.
 *
 * @throws {never}
 * @since 0.1.0
 */

import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  type Ci,
  expand,
  type FailedHere,
  hostOf,
  type Inventory,
  isSelfHosted,
  type Job,
  needsLeftOut,
  noTarget,
  notRead,
  type NotReplayed,
  otherSystem,
  script,
  selfHosted,
  treeOf,
  type Unsupported,
  withheldOf,
  withVariant
} from "../contract/Inventory.ts"
import type { Failure } from "../contract/Parts.ts"
import type { Plan } from "../contract/Plan.ts"
import { reasonsSentence } from "../contract/Reasons.ts"
import type {
  FirstRun,
  Mismatch,
  NotReplayedCommit,
  ReplayCommit,
  ReplayReport,
  RunTotals,
  StepFailure
} from "../contract/ReplayReport.ts"
import {
  combine,
  type Mode,
  type RunRecord,
  type StatusCounts,
  type TargetResult,
  type Verdict,
  verdictOf
} from "../contract/RunRecord.ts"
import { type Metrics, metrics, type Row, type Score, select, type Settings } from "../contract/Selection.ts"
import { labelsOf as targetsOfStep, type TargetMap } from "../contract/TargetMap.ts"
import { failuresOf, type StepNames } from "./Failures.ts"

/**
 * A tool that walks a repository's tree, how its output is told from another
 * tool's, and where it is told to leave a path alone.
 */
interface TreeTool {
  readonly name: string
  readonly says: RegExp
  readonly ignore: (path: string) => string
}

// The first that matches names the tool. `tsc` prints `error TS2307`, typed ESLint a parsing error, Prettier
// `[warn] <file>`, and each of the others its own name or section heading.
const treeTools: ReadonlyArray<TreeTool> = [
  { name: "tsc", says: /\berror TS\d+/, ignore: (path) => `Add ${path} to "exclude" in the tsconfig.json it reads` },
  {
    name: "ESLint",
    says: /Parsing error|@typescript-eslint|\beslint\b|\d+ problems? \(/i,
    ignore: (path) => `Add ${path} to "ignores" in eslint.config.js, or to .eslintignore`
  },
  {
    name: "Prettier",
    says: /^\[warn\] |Code style issues|\bprettier\b/im,
    ignore: (path) => `Add ${path} to .prettierignore`
  },
  {
    name: "Biome",
    says: /\bbiome\b|━━━━/i,
    ignore: (path) => `Add "!${path}" to "files.includes" in biome.json`
  },
  {
    name: "dprint",
    says: /\bdprint\b|not formatted files?/i,
    ignore: (path) => `Add ${path} to "excludes" in dprint.json`
  },
  {
    name: "cspell",
    says: /Unknown word|\bcspell\b/i,
    ignore: (path) => `Add ${path} to "ignorePaths" in the cspell configuration`
  },
  {
    name: "knip",
    says: /Unused files|Unlisted binaries|\bknip\b/i,
    ignore: (path) => `Add ${path} to "ignore" in the knip configuration`
  },
  {
    name: "Jest",
    says: /\bjest\b|Failed to collect coverage/i,
    ignore: (path) =>
      `Add ${path} to "coveragePathIgnorePatterns" and "testPathIgnorePatterns" in the Jest configuration`
  },
  { name: "Vitest", says: /\bvitest\b/i, ignore: (path) => `Add ${path} to "exclude" in the Vitest configuration` },
  { name: "Mocha", says: /\bmocha\b/i, ignore: (path) => `Add ${path} to "ignore" in .mocharc` },
  { name: "npm", says: /npm notice|\bnpm pack\b|\bpublint\b/i, ignore: (path) => `Add ${path} to .npmignore` }
]

// A tool target's failure is one JSON document on its line, holding what the tool printed.
const toolFailureOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ stdout: Schema.optionalKey(Schema.String), stderr: Schema.optionalKey(Schema.String) })
  )
)

/**
 * What a run of Smithers build printed for each target that failed: the
 * lines after `<label>  failed  ...`, up to the next target's line. The
 * line itself holds the step's command and is left out, unless it is a tool
 * failure, which holds the tool's output.
 *
 * @category results
 * @throws {never}
 * @since 0.1.0
 */
export const failureTexts = (output: string): ReadonlyMap<string, string> => {
  const texts = new Map<string, Array<string>>()
  let current: Array<string> | undefined
  for (const line of output.split("\n")) {
    const status = /^(\/\/\S*:\S+) {2}(hit|ran|failed|skipped|cancelled)\b(?: {2}\S+ {2}(.*))?/.exec(line)
    if (status !== null) {
      current = status[2] === "failed" ? [] : undefined
      if (current !== undefined) {
        const tool = Option.getOrUndefined(toolFailureOf(status[3] ?? ""))
        current.push(
          ...[tool?.stdout, tool?.stderr].flatMap((text) => text === undefined || text === "" ? [] : [text.trimEnd()])
        )
        texts.set(status[1] as string, current)
      }
      continue
    }
    // The summary that ends a run starts with one of these keys.
    if (/^(code|verb|pattern|counts|ok): /.test(line)) current = undefined
    current?.push(line)
  }
  return new Map([...texts].map(([label, lines]) => [label, lines.join("\n")]))
}

// The path of `written` that the output names: the entry itself, or for a directory (an entry that ends in `/`)
// the first path under it. A directory is named at the start of a path, never inside another name.
const namedIn = (error: string, entry: string): string | undefined => {
  if (!entry.endsWith("/")) return error.includes(entry) ? entry : undefined
  const under = new RegExp(`(?:^|[\\s"'(/])(${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\s:"'()]+)`, "m").exec(
    error
  )
  return under === null ? undefined : under[1]
}

/**
 * One line for a step that failed over a file Smithers CI wrote: the tool
 * that read it, the file, and what to add to that tool's ignore list.
 * `written` holds the files, and each directory Smithers CI fills, such as
 * its cache, as a path that ends in `/`. A file under `.smithers` or under
 * such a directory is left alone by naming the directory. `undefined` when
 * the failed step's output names nothing of `written`.
 *
 * @category report
 * @throws {never}
 * @since 0.1.0
 */
export const seenIn = (error: string | undefined, written: ReadonlyArray<string>): string | undefined => {
  if (error === undefined) return undefined
  const found = written.flatMap((entry) => {
    const file = namedIn(error, entry)
    return file === undefined ? [] : [{ entry, file }]
  })[0]
  if (found === undefined) return undefined
  const { entry, file } = found
  const ignored = entry.endsWith("/") ? entry.slice(0, -1) : file.startsWith(".smithers/") ? ".smithers" : file
  const tool = treeTools.find((entry) => entry.says.test(error))
  return tool === undefined
    ? `A tool of this repository read ${file}, which Smithers CI wrote. Add ${ignored} to that tool's ignore list.`
    : `${tool.name} read ${file}, which Smithers CI wrote. ${tool.ignore(ignored)}.`
}

/**
 * How many times a failed target reruns after its first run.
 *
 * @category constants
 * @throws {never}
 * @since 0.1.0
 */
export const maxReruns = 10

/**
 * One step of a baseline unit, with its matrix values filled in.
 *
 * @category models
 * @since 0.1.0
 */
export interface UnitStep {
  readonly id: string
  /** The name a person knows the step by, with the matrix variant it ran in. */
  readonly name: string
  /**
   * The name the step's verdict is compared under: its target's label, or, when it was split, its own id with the
   * matrix variant it ran in.
   */
  readonly label: string
  /** The targets that run the step: one, or several when it was split. */
  readonly targets: ReadonlyArray<string>
  /** What the shell runs: the step's command, with what its CI's runner does around it. */
  readonly command: string
  /** The command as the CI file writes it, which is what a report shows. */
  readonly written: string
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

/**
 * One job on one matrix variant: the steps one machine runs in order. `tree`
 * names the working tree the unit shares with the units before and after it
 * (`Inventory.treeOf`); without it the unit gets a checkout of its own.
 *
 * @category models
 * @since 0.1.0
 */
export interface Unit {
  readonly job: string
  readonly needs: ReadonlyArray<string>
  readonly steps: ReadonlyArray<UnitStep>
  readonly tree?: string | undefined
  /** The matrix variant, for a job that has a matrix. */
  readonly variant?: Readonly<Record<string, string>> | undefined
}

/**
 * The roots of a plan, without the targets in `left` and every target that
 * waits on one of them.
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const rootsWithout = (plan: Plan, left: ReadonlySet<string>): ReadonlyArray<string> => {
  const needs = new Map(plan.targets.map((target) => [target.label, target.dependencies]))
  const known = new Map<string, boolean>()
  const reachesLeft = (label: string): boolean => {
    const found = known.get(label)
    if (found !== undefined) return found
    known.set(label, left.has(label))
    const reaches = left.has(label) || (needs.get(label) ?? []).some(reachesLeft)
    known.set(label, reaches)
    return reaches
  }
  return plan.roots.filter((label) => !reachesLeft(label))
}

/**
 * A failure of the replay part.
 *
 * @category constructors
 * @throws {never}
 * @since 0.1.0
 */
export const failure = (code: Failure["code"], message: string): Failure => ({ code, message, part: "replay" })

type Variant = Readonly<Record<string, string>>

/** A variant as a person reads it: ` (os=macos-latest, node=22)`, or nothing for a job with no matrix. */
const variantText = (variant: Variant): string => {
  const entries = Object.entries(variant).sort(([a], [b]) => (a < b ? -1 : 1))
  return entries.length === 0 ? "" : ` (${entries.map(([name, value]) => `${name}=${value}`).join(", ")})`
}

/**
 * The name a split step's verdict is compared under: the step's id with the
 * matrix variant, so one variant's verdict never answers for another's.
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const stepKey = (step: string, variant: Variant): string => `${step}${variantText(variant)}`

/**
 * What of a CI the replay runs, and what it leaves out.
 *
 * @category models
 * @since 0.1.0
 */
export interface Replayable {
  readonly units: ReadonlyArray<Unit>
  /** The jobs and matrix variants left out here, each with its reasons. */
  readonly left: ReadonlyArray<NotReplayed>
}

/**
 * The units a change runs on this machine: every job of the CI
 * (`Inventory.ci`), once per matrix variant, in the CI's order, which is
 * the order the jobs of a shared tree run in. Three things are left out and
 * listed:
 *
 * - a variant whose runner is another operating system than `host`
 *   (`other-system`): its commands were written for that system, and
 *   Smithers build refuses its target here;
 * - a job with a step the generator made no target for (`no-target`): the
 *   step would run and be timed in the baseline with nothing to compare it
 *   with;
 * - a job that needs a job left out whole (`needs`).
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const replayable = (inventory: Ci, map: TargetMap, host: string): Replayable => {
  const byId = new Map(inventory.jobs.map((job) => [job.id, job]))
  const variantsOf = (job: Job): ReadonlyArray<Variant> => job.matrix.length === 0 ? [{}] : job.matrix
  const runnerOf = (job: Job, variant: Variant) => job.runsOn === undefined ? undefined : expand(job.runsOn, variant)
  const systemOf = (job: Job, variant: Variant) => hostOf(runnerOf(job, variant))
  const here = (job: Job): ReadonlyArray<Variant> =>
    variantsOf(job).filter((variant) =>
      !isSelfHosted(runnerOf(job, variant)) && (systemOf(job, variant) ?? host) === host
    )
  const elsewhere = (job: Job): ReadonlyArray<Unsupported> =>
    variantsOf(job).flatMap((variant) => {
      if (isSelfHosted(runnerOf(job, variant))) {
        return [{ feature: selfHosted, detail: `${job.id}${variantText(variant)} runs on a self-hosted runner` }]
      }
      const system = systemOf(job, variant) ?? host
      return system === host
        ? []
        : [{
          feature: otherSystem,
          detail: `${job.id}${variantText(variant)} runs on ${system}; this machine is ${host}`
        }]
    })
  const untargeted = (job: Job): ReadonlyArray<Unsupported> =>
    here(job).flatMap((variant) =>
      job.steps.flatMap((step) =>
        targetsOfStep(map, job.id, step.id, variant).length > 0
          ? []
          : [{ feature: noTarget, detail: `${step.id}${variantText(variant)} has no target` }]
      )
    )
  const known = new Map<string, ReadonlyArray<Unsupported>>()
  /** Why a job is left out whole; empty when some variant of it runs. */
  const whole = (job: Job): ReadonlyArray<Unsupported> => {
    const found = known.get(job.id)
    if (found !== undefined) return found
    // A job that needs itself is refused by `cycleIn`; here it only must not loop.
    known.set(job.id, [])
    const own = here(job).length === 0 ? elsewhere(job) : untargeted(job)
    const reasons = [
      ...own,
      ...job.needs.flatMap((id) => {
        const need = byId.get(id)
        return need === undefined || whole(need).length === 0
          ? []
          : [{ feature: needsLeftOut, detail: `${job.id} needs ${id}, which is not replayed` }]
      })
    ]
    known.set(job.id, reasons)
    return reasons
  }
  const units = inventory.jobs.filter((job) => whole(job).length === 0).flatMap((job) =>
    here(job).map((variant): Unit => ({
      job: job.id,
      needs: job.needs,
      tree: treeOf(job),
      ...(job.matrix.length === 0 ? {} : { variant }),
      steps: job.steps.map((step) => {
        const filled = withVariant(step, variant)
        const targets = targetsOfStep(map, job.id, step.id, variant)
        return {
          id: step.id,
          name: stepKey(step.name === undefined ? step.id : `${job.id}: ${step.name}`, variant),
          label: targets.length > 1 ? stepKey(step.id, variant) : (targets[0] as string),
          targets,
          // The jobs of a baseline run at once in one checkout, so each step is told its job.
          command: script(filled, job.id),
          written: filled.command,
          cwd: filled.cwd,
          env: filled.env
        }
      })
    }))
  )
  const left = inventory.jobs.flatMap((job) => {
    const reasons = whole(job).length > 0 ? whole(job) : elsewhere(job)
    return reasons.length === 0 ? [] : [{ job: job.id, reasons }]
  })
  return { units, left }
}

/**
 * What names a unit among the units of a CI: its job and its matrix variant.
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const unitKey = (unit: Pick<Unit, "job" | "variant">): string => stepKey(unit.job, unit.variant ?? {})

/**
 * What one run of the baseline says of each unit it was asked about.
 *
 * @category models
 * @since 0.1.0
 */
export interface TrialResult {
  /** The units all of whose steps passed. */
  readonly passed: ReadonlyArray<string>
  /** The units with a step that failed, with the first line of its error. */
  readonly failed: ReadonlyArray<FailedHere>
  /** The first failure, in the order of the CI. */
  readonly first: StepFailure | undefined
}

/**
 * Sorts `units` by their steps' results. A unit whose steps neither all
 * passed nor failed was kept from running by what ran before it, and is in
 * neither list.
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const trialOf = (
  units: ReadonlyArray<Unit>,
  results: ReadonlyArray<TargetResult>,
  names: StepNames
): TrialResult => {
  const byLabel = new Map(results.map((result) => [result.label, result]))
  const passed: Array<string> = []
  const failed: Array<FailedHere> = []
  let first: StepFailure | undefined
  for (const unit of units) {
    const own = unit.steps.flatMap((step) => {
      const result = byLabel.get(step.label)
      return result === undefined ? [] : [result]
    })
    const [failure] = failuresOf(own, names)
    if (failure !== undefined) {
      first ??= failure
      const variant = unit.variant === undefined ? {} : { variant: unit.variant }
      const prefix = unit.variant === undefined ? "" : `${stepKey("", unit.variant).trim()} `
      failed.push({ job: unit.job, ...variant, reason: `${prefix}${failure.reason}` })
    } else if (own.length === unit.steps.length && own.every((result) => result.status === "ran")) {
      passed.push(unitKey(unit))
    }
  }
  return { passed, failed, first }
}

/**
 * A job that failed the first run, with the commits it failed at after its
 * reason: `no docker here (at 3f2a1c9 and 8d1e0b2)`. A commit named twice is
 * named once.
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const failedAt = (entry: FailedHere, commits: ReadonlyArray<string>): FailedHere => ({
  ...entry,
  reason: `${entry.reason} (at ${[...new Set(commits.map((commit) => commit.slice(0, 7)))].join(" and ")})`
})

/**
 * The commit a job that failed the first run ran once more at: the newest,
 * or, when nothing runs again, the commit of the first run itself.
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const ranAgainAt = (again: number, first: string, newest: string): string => again === 0 ? first : newest

/**
 * The results that failed and failed again when they ran once more, by label.
 * A result that was not run again, such as one stopped for making no
 * progress, is not among them.
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const failedTwice = (results: ReadonlyArray<TargetResult>): ReadonlySet<string> =>
  new Set(
    results.filter((result) => result.status === "failed" && (result.attempts ?? []).length > 1)
      .map((result) => result.label)
  )

/**
 * Why a replay that was asked to start warm starts with an empty cache when
 * its oldest commit has no commit before it in the repository.
 *
 * @category report
 * @throws {never}
 * @since 0.1.0
 */
export const noCommitBefore = (oldest: string): string =>
  `no commit comes before ${oldest.slice(0, 7)} in this repository`

/**
 * Why a replay that was asked to start warm starts with an empty cache when
 * the commit before its oldest has no CI that can be run here.
 *
 * @category report
 * @throws {never}
 * @since 0.1.0
 */
export const noCiBefore = (oldest: string): string =>
  `the commit before ${oldest.slice(0, 7)} has no CI that runs on this machine`

/**
 * How many of the CI's jobs a replay covers: the jobs of `units`, of those and
 * the jobs in `left`.
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const jobsCovered = (
  units: ReadonlyArray<Pick<Unit, "job">>,
  left: ReadonlyArray<NotReplayed>
): { readonly replayed: number; readonly total: number } => {
  const replayed = new Set(units.map((unit) => unit.job))
  return { replayed: replayed.size, total: new Set([...replayed, ...left.map((entry) => entry.job)]).size }
}

/**
 * The comparison names of a unit, limited to `wanted` when it is given.
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const labelsOf = (unit: Unit, wanted: ReadonlySet<string> | undefined): ReadonlyArray<string> =>
  unit.steps.flatMap((step) => wanted === undefined || wanted.has(step.label) ? [step.label] : [])

/**
 * Why a replay has nothing to run although the CI has jobs: each job left
 * out, one per line with why.
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const nothingToReplay = (left: ReadonlyArray<NotReplayed>): string => {
  const width = Math.max(0, ...left.map((entry) => entry.job.length))
  return [
    "no CI step that runs on a change has a target on this machine",
    ...left.map((entry) => `  ${entry.job.padEnd(width)}  ${reasonsSentence(entry.reasons)}`)
  ].join("\n")
}

/**
 * A remote URL without the user name and password it may hold. The replay
 * gives its copies the repository's remote, so a reader names the repository
 * as it does in place, and CI steps run in those copies: they get no secret.
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const withoutCredentials = (remote: string): string =>
  remote.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1")

/**
 * Every target the units' steps became.
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const targetsOf = (units: ReadonlyArray<Unit>): ReadonlyArray<string> =>
  units.flatMap((unit) => unit.steps.flatMap((step) => step.targets))

/**
 * The steps that were split: the name each is compared under, which carries
 * its matrix variant, with its targets.
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const splitOf = (units: ReadonlyArray<Unit>): ReadonlyMap<string, ReadonlyArray<string>> =>
  new Map(
    units.flatMap((unit) =>
      unit.steps.flatMap((step) => step.targets.length > 1 ? [[step.label, step.targets] as const] : [])
    )
  )

/**
 * What each comparison name and target of the units is called in a report, and
 * the command behind it.
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const stepNames = (units: ReadonlyArray<Unit>): StepNames =>
  new Map(
    units.flatMap((unit) =>
      unit.steps.flatMap((step) =>
        [step.label, ...step.targets].map((label) => [label, { step: step.name, command: step.written }] as const)
      )
    )
  )

/**
 * Units the baseline starts together: one job's variants, or every job of
 * one shared tree. `needs` are the jobs elsewhere that must pass first.
 * Each of `runs` gets one fresh checkout, its units run there in order, and
 * its first failure stops it: a job's variants are one run each, and the
 * jobs of a shared tree are one run together.
 *
 * @category models
 * @since 0.1.0
 */
export interface Station {
  readonly jobs: ReadonlyArray<string>
  readonly needs: ReadonlyArray<string>
  readonly runs: ReadonlyArray<ReadonlyArray<Unit>>
}

/**
 * The stations of the units that hold a wanted comparison name, or of every
 * unit when none is named, in order of first appearance. A run of a shared
 * tree is kept whole when any of its units is wanted: a recipe is rerun
 * after the recipes before it, as it first ran.
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const stationsOf = (
  units: ReadonlyArray<Unit>,
  wanted: ReadonlySet<string> | undefined = undefined
): ReadonlyArray<Station> => {
  const keyOf = (unit: Unit): string => unit.tree === undefined ? `job ${unit.job}` : `tree ${unit.tree}`
  return [...new Set(units.map(keyOf))].flatMap((key) => {
    const members = units.filter((unit) => keyOf(unit) === key)
    const jobs = [...new Set(members.map((unit) => unit.job))]
    const runs = (members.some((unit) => unit.tree !== undefined) ? [members] : members.map((unit) => [unit]))
      .filter((run) => run.some((unit) => labelsOf(unit, wanted).length > 0))
    const needs = [...new Set(members.flatMap((unit) => unit.needs))].filter((need) => !jobs.includes(need))
    return runs.length === 0 ? [] : [{ jobs, needs, runs }]
  })
}

/**
 * The steps one run executes, in order: every step of its units up to the
 * last unit that holds a wanted comparison name.
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const stepsThrough = (
  run: ReadonlyArray<Unit>,
  wanted: ReadonlySet<string> | undefined
): ReadonlyArray<UnitStep> =>
  run.slice(0, run.findLastIndex((unit) => labelsOf(unit, wanted).length > 0) + 1).flatMap((unit) => unit.steps)

/**
 * The lines of a copy's `.git/info/exclude` for what `git ls-files -z`
 * listed as untracked there: each path from the copy's root, with the
 * characters a pattern reads as wildcards taken literally.
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const excludeLines = (listed: string): string =>
  listed.split("\0").filter((entry) => entry !== "").map((entry) => `/${entry.replace(/[\\*?[\]]/g, "\\$&")}\n`)
    .join("")

/**
 * A job that can never start because its needs form a cycle, if there is one.
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const cycleIn = (units: ReadonlyArray<Unit>): string | undefined => {
  const done = new Set<string>()
  let waiting = [...units]
  while (waiting.length > 0) {
    const ready = waiting.filter((unit) => unit.needs.every((need) => done.has(need)))
    if (ready.length === 0) return waiting[0]?.job
    for (const unit of ready) done.add(unit.job)
    waiting = waiting.filter((unit) => !done.has(unit.job))
  }
  return undefined
}

/**
 * What `smthrs ci --plan --format json` prints, as far as the replay reads it.
 *
 * @category models
 * @since 0.1.0
 */
export const PrintedPlan = Schema.Struct({
  verb: Schema.String,
  pattern: Schema.String,
  roots: Schema.Array(Schema.String),
  targets: Schema.Array(Schema.Struct({
    label: Schema.NonEmptyString,
    target: Schema.NonEmptyString,
    keyPreview: Schema.optionalKey(Schema.String),
    cacheable: Schema.Boolean,
    dependencies: Schema.Array(Schema.String)
  }))
})

/**
 * The plan (contract 2) in a printed plan. A target with no key yet has the
 * empty key.
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const planOfPrinted = (printed: typeof PrintedPlan.Type): Plan => ({
  verb: printed.verb,
  pattern: printed.pattern,
  roots: printed.roots,
  targets: printed.targets.map((target) => ({
    label: target.label,
    rule: target.target,
    key: target.keyPreview ?? "",
    cacheable: target.cacheable,
    dependencies: target.dependencies
  }))
})

/**
 * How many generated targets may run at once: the request's limit, never above
 * the target map's. `undefined` leaves the choice to Smithers build.
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const jobsFor = (requested: number | undefined, maxJobs: number | undefined): number | undefined =>
  requested === undefined ? maxJobs : maxJobs === undefined ? requested : Math.min(requested, maxJobs)

/**
 * A target that never ran because something before it failed.
 *
 * @category results
 * @throws {never}
 * @since 0.1.0
 */
export const blocked = (label: string, blockedBy: string): TargetResult => ({
  label,
  status: "skipped",
  key: "",
  durationMs: 0,
  blockedBy,
  skipReason: "dependency-failed"
})

/**
 * A target fast mode chose not to run.
 *
 * @category results
 * @throws {never}
 * @since 0.1.0
 */
export const predictedSafe = (label: string): TargetResult => ({
  label,
  status: "skipped",
  key: "",
  durationMs: 0,
  skipReason: "predicted-safe"
})

/**
 * Records a first run as the first attempt. A cache hit executed nothing, and
 * a skip without a reason was blocked by a dependency.
 *
 * @category results
 * @throws {never}
 * @since 0.1.0
 */
export const firstAttempt = (result: TargetResult): TargetResult => {
  if (result.status === "skipped") return { skipReason: "dependency-failed", ...result }
  if (result.status === "hit") return result
  return { ...result, attempts: [{ passed: result.status === "ran", durationMs: result.durationMs }] }
}

/**
 * Adds one rerun to a failed target. A rerun that passes makes the target pass;
 * its first failure stays in the attempts, so its verdict is flaky. A target
 * the rerun did not reach counts as a failed attempt.
 *
 * @category results
 * @throws {never}
 * @since 0.1.0
 */
export const addRerun = (result: TargetResult, rerun: TargetResult | undefined): TargetResult => {
  const passed = rerun?.status === "ran" || rerun?.status === "hit"
  const attempts = [...(result.attempts ?? []), { passed, durationMs: rerun?.durationMs ?? 0 }]
  if (!passed) return { ...result, attempts }
  const { command: _command, error: _error, exitCode: _exitCode, failureDigest: _failureDigest, ...rest } = result
  return { ...rest, status: "ran", attempts }
}

/**
 * True when a target failed at first and passed on a rerun.
 *
 * @category results
 * @throws {never}
 * @since 0.1.0
 */
export const recovered = (result: TargetResult): boolean => result.status === "ran" && verdictOf(result) === "flaky"

/**
 * True when a dependency's failure kept a target from running.
 *
 * @category results
 * @throws {never}
 * @since 0.1.0
 */
export const isBlocked = (result: TargetResult): boolean =>
  result.status === "skipped" && result.skipReason !== "predicted-safe"

const countsOf = (results: ReadonlyArray<TargetResult>): StatusCounts => ({
  hit: results.filter((result) => result.status === "hit").length,
  ran: results.filter((result) => result.status === "ran").length,
  failed: results.filter((result) => result.status === "failed").length,
  skipped: results.filter((result) => result.status === "skipped").length
})

/**
 * The run record of one commit in one way of running it.
 *
 * @category results
 * @throws {never}
 * @since 0.1.0
 */
export const recordOf = (
  results: ReadonlyArray<TargetResult>,
  commit: string,
  durationMs: number,
  mode?: Mode
): RunRecord => {
  const counts = countsOf(results)
  return {
    ok: counts.failed === 0,
    counts,
    results,
    version: 1,
    commit,
    durationMs,
    cache: mode !== undefined,
    ...(mode === undefined ? {} : { mode })
  }
}

/**
 * Wall time, work time, counts and failures of one run. The reruns that label
 * flaky targets are measurement, not CI, so neither time includes them. `names`
 * says what the failed results are called in the report.
 *
 * @category report
 * @throws {never}
 * @since 0.1.0
 */
export const totalsOf = (record: RunRecord, names: StepNames = new Map()): RunTotals => {
  const failures = failuresOf(record.results, names)
  return {
    ok: record.ok,
    wallMs: record.durationMs ?? 0,
    workMs: record.results.reduce((sum, result) => sum + result.durationMs, 0),
    counts: record.counts,
    ...(failures.length === 0 ? {} : { failures })
  }
}

/** `pass` and `flaky` agree: the step passed in the end. */
const agree = (one: Verdict, other: Verdict): boolean =>
  one === other || (one !== "fail" && one !== "skipped" && other !== "fail" && other !== "skipped")

/**
 * Every baseline step whose verdict differs in a mode. `pass` and `flaky`
 * agree; flaky verdicts are counted by `flakyOf`. A step that was split
 * (`split` names its targets) has the combined verdict of its targets, and
 * is a mismatch when the mode never reported one of them. A target the mode
 * never reported counts as skipped, so a mode that ran nothing cannot agree.
 * `predicted-safe` skips differ only from a baseline failure: the targets
 * that did run must then show it.
 *
 * @category report
 * @throws {never}
 * @since 0.1.0
 */
export const mismatchesOf = (
  mode: Mode,
  baseline: RunRecord,
  got: RunRecord,
  split: ReadonlyMap<string, ReadonlyArray<string>> = new Map(),
  causes: ReadonlyMap<string, string> = new Map()
): ReadonlyArray<Mismatch> => {
  const byLabel = new Map(got.results.map((result) => [result.label, result]))
  // A step that failed only in the mode, over a file Smithers CI wrote: the first of its targets that says so.
  // `causes` holds that line by target label (`seenIn` of what the target printed).
  const causeOf = (expected: Verdict, verdict: Verdict, others: ReadonlyArray<TargetResult | undefined>) => {
    if (expected === "fail" || verdict !== "fail") return {}
    const cause = others.flatMap((other) => other?.status === "failed" ? [causes.get(other.label)] : [])
      .find((found) => found !== undefined)
    return cause === undefined ? {} : { cause }
  }
  return baseline.results.flatMap((result) => {
    const expected = verdictOf(result)
    const others = (split.get(result.label) ?? [result.label]).map((label) => byLabel.get(label))
    const judged = others.filter((other) => other?.skipReason !== "predicted-safe")
    const verdictOfAll = (all: typeof others) =>
      combine(all.map((other) => other === undefined ? "skipped" : verdictOf(other)))
    if (others.length > 1 && others.includes(undefined)) {
      return [{ label: result.label, mode, baseline: expected, got: "skipped" as const }]
    }
    const verdict = verdictOfAll(others)
    const same = judged.length === others.length
      ? agree(verdict, expected)
      : expected === "fail"
      ? verdictOfAll(judged) === "fail"
      : judged.length === 0 || agree(verdictOfAll(judged), expected)
    return same
      ? []
      : [{ label: result.label, mode, baseline: expected, got: verdict, ...causeOf(expected, verdict, others) }]
  })
}

/**
 * How many verdicts of these runs are `flaky`: a step or target that failed
 * and then passed on a rerun.
 *
 * @category report
 * @throws {never}
 * @since 0.1.0
 */
export const flakyOf = (records: ReadonlyArray<RunRecord>): number =>
  records.reduce(
    (total, record) => total + record.results.filter((result) => verdictOf(result) === "flaky").length,
    0
  )

/**
 * What fast mode does with one change's scores: the targets it selected, and
 * the scored targets it skips. A target without a score is never skipped.
 *
 * @category selection
 * @throws {never}
 * @since 0.1.0
 */
export const choose = (
  scores: ReadonlyArray<Score>,
  settings: Settings
): { readonly selected: ReadonlyArray<string>; readonly skipped: ReadonlySet<string> } => {
  const selected = select(scores, settings)
  return { selected, skipped: new Set(scores.map((score) => score.target).filter((t) => !selected.includes(t))) }
}

/**
 * The selection metrics over every replayed commit.
 *
 * @category selection
 * @throws {never}
 * @since 0.1.0
 */
export const selectionOf = (rows: ReadonlyArray<Row>, selected: ReadonlyMap<string, ReadonlyArray<string>>): Metrics =>
  metrics(rows, selected)

/**
 * What a replay found besides its commits.
 *
 * @category models
 * @since 0.1.0
 */
export interface Findings {
  /** Fast mode's metrics, when fast mode ran. */
  readonly selection?: Metrics | undefined
  /** The jobs and variants not replayed. */
  readonly left: ReadonlyArray<NotReplayed>
  /** How many verdicts were flaky, in the baseline and in every mode. */
  readonly flaky: number
  /** The commits whose own CI could not be replayed. */
  readonly commitsLeft?: ReadonlyArray<NotReplayedCommit> | undefined
  /** Why fast mode has no numbers, when the model stopped answering during the replay. */
  readonly fastNotMeasured?: string | undefined
  /** How many of the CI's jobs the numbers cover. */
  readonly jobs?: { readonly replayed: number; readonly total: number } | undefined
  /** How long the run that found the jobs that pass here took, when there was one. */
  readonly trialMs?: number | undefined
  /** The run of each way before the first counted commit, when there was one. */
  readonly firstRun?: FirstRun | undefined
  /** Why the first counted commit started with an empty cache, when a run before it was asked for. */
  readonly cold?: string | undefined
}

/**
 * A commit with every fast-mode number taken out, for a replay whose fast
 * mode could not be measured to the end.
 *
 * @category report
 * @throws {never}
 * @since 0.1.0
 */
export const withoutFast = ({ fast: _fast, ...commit }: ReplayCommit): ReplayCommit => ({
  ...commit,
  mismatches: commit.mismatches.filter((mismatch) => mismatch.mode !== "fast")
})

/**
 * The replay report of `inventory`'s repository. `speedup` is baseline wall
 * time over normal-mode wall time, and 0 when nothing ran in normal mode. It
 * and the wall times cover the commits whose baseline passed: a failed
 * baseline stops at its failure, so its time says nothing about the CI, and
 * `speedupCommits` counts the commits covered. What the inventory could not
 * read is listed as `notRead`, and each tool this machine has at another
 * version than a job asks for as `toolVersions`. The cache credentials a kept
 * job ran without are named in `withheld`.
 *
 * @category report
 * @throws {never}
 * @since 0.1.0
 */
export const reportOf = (
  inventory: Inventory,
  commits: ReadonlyArray<ReplayCommit>,
  found: Findings
): ReplayReport => {
  const measured = commits.filter((commit) => commit.baseline.ok)
  const sum = (wall: (commit: ReplayCommit) => number): number =>
    measured.reduce((total, commit) => total + wall(commit), 0)
  const baselineWallMs = sum((commit) => commit.baseline.wallMs)
  const normalWallMs = sum((commit) => commit.normal.wallMs)
  const unread = notRead(inventory)
  const empty = withheldOf(inventory)
  return {
    version: 1,
    repository: inventory.repository,
    commits,
    baselineWallMs,
    normalWallMs,
    speedup: normalWallMs === 0 ? 0 : baselineWallMs / normalWallMs,
    speedupCommits: measured.length,
    ...(found.jobs === undefined ? {} : { jobs: found.jobs }),
    ...(found.trialMs === undefined ? {} : { trialMs: found.trialMs }),
    ...(found.firstRun === undefined ? {} : { firstRun: found.firstRun }),
    ...(found.cold === undefined ? {} : { cold: found.cold }),
    mismatches: commits.reduce((total, commit) => total + commit.mismatches.length, 0),
    flaky: found.flaky,
    ...(found.selection === undefined
      ? {}
      : { fastWallMs: sum((commit) => commit.fast?.wallMs ?? 0), selection: found.selection }),
    ...(found.fastNotMeasured === undefined ? {} : { fastNotMeasured: found.fastNotMeasured }),
    ...(found.left.length === 0 ? {} : { notReplayed: found.left }),
    ...(found.commitsLeft === undefined || found.commitsLeft.length === 0
      ? {}
      : { notReplayedCommits: found.commitsLeft }),
    ...(unread.length === 0 ? {} : { notRead: unread }),
    ...(inventory.toolVersions === undefined ? {} : { toolVersions: inventory.toolVersions }),
    ...(empty.length === 0 ? {} : { withheld: empty })
  }
}

/**
 * What fast mode's run of one commit adds to the report. `fast` is what it
 * ran, and a target of `normal` it did not run was skipped as predicted safe.
 *
 * @category report
 * @throws {never}
 * @since 0.1.0
 */
export const fastRunOf = (
  normal: ReadonlyArray<TargetResult>,
  fast: ReadonlyArray<TargetResult>,
  commit: string,
  wallMs: number,
  baseline: RunRecord,
  names: StepNames = new Map(),
  split: ReadonlyMap<string, ReadonlyArray<string>> = new Map(),
  causes: ReadonlyMap<string, string> = new Map()
): {
  readonly part: Pick<ReplayCommit, "fast">
  readonly mismatches: ReadonlyArray<Mismatch>
  readonly flaky: number
} => {
  const byLabel = new Map(fast.map((result) => [result.label, result]))
  const merged = normal.map((result) => byLabel.get(result.label) ?? predictedSafe(result.label))
  const record = recordOf(merged, commit, wallMs, "fast")
  return {
    part: { fast: totalsOf(record, names) },
    mismatches: mismatchesOf("fast", baseline, record, split, causes),
    flaky: flakyOf([record])
  }
}

/**
 * What a replay gathered over its commits, for its report.
 *
 * @category models
 * @since 0.1.0
 */
export interface Gathered {
  /** Whether the replay was asked for fast mode. */
  readonly fastAsked: boolean
  readonly rows: ReadonlyArray<Row>
  readonly selected: ReadonlyMap<string, ReadonlyArray<string>>
  readonly left: ReadonlyArray<NotReplayed>
  /** Flaky verdicts in the baseline and in normal mode. */
  readonly flaky: number
  /** Flaky verdicts in fast mode. */
  readonly fastFlaky: number
  readonly commitsLeft?: ReadonlyArray<NotReplayedCommit> | undefined
  readonly fastNotMeasured: string | undefined
  /** How many of the CI's jobs the numbers cover. */
  readonly jobs?: { readonly replayed: number; readonly total: number } | undefined
  /** How long the run that found the jobs that pass here took, when there was one. */
  readonly trialMs?: number | undefined
  /** The run of each way before the first counted commit, when there was one. */
  readonly firstRun?: FirstRun | undefined
  /** Why the first counted commit started with an empty cache, when a run before it was asked for. */
  readonly cold?: string | undefined
}

/**
 * The report of a finished replay. When the model stopped answering, part of
 * a measurement is not one: every fast-mode number is left out and the report
 * says why.
 *
 * @category report
 * @throws {never}
 * @since 0.1.0
 */
export const finishedReport = (
  inventory: Inventory,
  commits: ReadonlyArray<ReplayCommit>,
  gathered: Gathered
): ReplayReport => {
  const measured = gathered.fastNotMeasured === undefined
  return reportOf(inventory, measured ? commits : commits.map(withoutFast), {
    selection: gathered.fastAsked && measured ? selectionOf(gathered.rows, gathered.selected) : undefined,
    left: gathered.left,
    flaky: measured ? gathered.flaky + gathered.fastFlaky : gathered.flaky,
    commitsLeft: gathered.commitsLeft,
    fastNotMeasured: gathered.fastNotMeasured,
    jobs: gathered.jobs,
    trialMs: gathered.trialMs,
    firstRun: gathered.firstRun,
    cold: gathered.cold
  })
}
