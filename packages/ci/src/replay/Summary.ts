/**
 * The pure half of the replay: which steps a baseline runs, how attempts settle
 * a target, and how run records become the replay report.
 *
 * @throws {never}
 * @since 0.1.0
 */

import { type Ci, type NotReplayed, withVariant } from "../contract/Inventory.ts"
import type { Failure } from "../contract/Parts.ts"
import type { Mismatch, ReplayCommit, ReplayReport, RunTotals } from "../contract/ReplayReport.ts"
import { type Mode, type RunRecord, type StatusCounts, type TargetResult, verdictOf } from "../contract/RunRecord.ts"
import { type Metrics, metrics, type Row, type Score, select, type Settings } from "../contract/Selection.ts"
import { labelOf, type TargetMap } from "../contract/TargetMap.ts"

/**
 * How many times a failed target reruns after its first run.
 *
 * @category constants
 * @throws {never}
 * @since 0.1.0
 */
export const maxReruns = 10

/**
 * One step of a baseline unit, with its matrix values filled in. `label` is the
 * target it became; a step with none still runs, because later steps may need
 * what it did, but has no verdict to compare.
 *
 * @category models
 * @since 0.1.0
 */
export interface UnitStep {
  readonly id: string
  readonly label: string | undefined
  readonly command: string
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

/**
 * One job on one matrix variant: the steps one machine runs in order.
 *
 * @category models
 * @since 0.1.0
 */
export interface Unit {
  readonly job: string
  readonly needs: ReadonlyArray<string>
  readonly steps: ReadonlyArray<UnitStep>
}

/**
 * A failure of the replay part.
 *
 * @category constructors
 * @throws {never}
 * @since 0.1.0
 */
export const failure = (code: Failure["code"], message: string): Failure => ({ code, message, part: "replay" })

/**
 * Why nothing can be replayed: the repository has no CI, or every CI job was
 * left out.
 *
 * @category constructors
 * @throws {never}
 * @since 0.1.0
 */
export const nothingToReplay = (left: ReadonlyArray<NotReplayed>): Failure =>
  failure(
    "unsupported",
    left.length === 0
      ? "no job runs on a push or a pull request, and the repository root has no `ci` recipe or script"
      : `none of the ${left.length} CI jobs can be reproduced on this machine: ${
        left.map((entry) => `${entry.job} (${[...new Set(entry.reasons.map((reason) => reason.feature))].join(", ")})`)
          .join("; ")
      }`
  )

/**
 * The units a change runs: every job of the CI (`Inventory.ci`), once per
 * matrix variant.
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const unitsOf = (inventory: Ci, map: TargetMap): ReadonlyArray<Unit> =>
  inventory.jobs.flatMap((job) => {
    const variants: ReadonlyArray<Readonly<Record<string, string>>> = job.matrix.length === 0 ? [{}] : job.matrix
    return variants.map((variant) => ({
      job: job.id,
      needs: job.needs,
      steps: job.steps.map((step) => {
        const filled = withVariant(step, variant)
        return {
          id: step.id,
          label: labelOf(map, job.id, step.id, variant),
          command: filled.command,
          cwd: filled.cwd,
          env: filled.env
        }
      })
    }))
  })

/**
 * The target labels of a unit, limited to `wanted` when it is given.
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const labelsOf = (unit: Unit, wanted: ReadonlySet<string> | undefined): ReadonlyArray<string> =>
  unit.steps.flatMap((step) =>
    step.label !== undefined && (wanted === undefined || wanted.has(step.label)) ? [step.label] : []
  )

/**
 * One job's units, which share its needs.
 *
 * @category models
 * @since 0.1.0
 */
export interface JobGroup {
  readonly job: string
  readonly needs: ReadonlyArray<string>
  readonly units: ReadonlyArray<Unit>
}

/**
 * Groups units by job, in order of first appearance.
 *
 * @category baseline
 * @throws {never}
 * @since 0.1.0
 */
export const groupByJob = (units: ReadonlyArray<Unit>): ReadonlyArray<JobGroup> =>
  [...new Set(units.map((unit) => unit.job))].map((job) => {
    const members = units.filter((unit) => unit.job === job)
    return { job, needs: members.flatMap((unit) => unit.needs), units: members }
  })

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
  const { error: _error, failureDigest: _failureDigest, ...rest } = result
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
 * Wall time, work time and counts of one run. The reruns that label flaky
 * targets are measurement, not CI, so neither time includes them.
 *
 * @category report
 * @throws {never}
 * @since 0.1.0
 */
export const totalsOf = (record: RunRecord): RunTotals => ({
  ok: record.ok,
  wallMs: record.durationMs ?? 0,
  workMs: record.results.reduce((sum, result) => sum + result.durationMs, 0),
  counts: record.counts
})

/**
 * Every baseline target whose verdict differs in a mode. A target the mode
 * never reported counts as skipped, so a mode that ran nothing cannot agree.
 * A `predicted-safe` skip differs only from a baseline failure.
 *
 * @category report
 * @throws {never}
 * @since 0.1.0
 */
export const mismatchesOf = (mode: Mode, baseline: RunRecord, got: RunRecord): ReadonlyArray<Mismatch> => {
  const byLabel = new Map(got.results.map((result) => [result.label, result]))
  return baseline.results.flatMap((result) => {
    const expected = verdictOf(result)
    const other = byLabel.get(result.label)
    const verdict = other === undefined ? "skipped" : verdictOf(other)
    const same = other?.skipReason === "predicted-safe" ? expected !== "fail" : verdict === expected
    return same ? [] : [{ label: result.label, mode, baseline: expected, got: verdict }]
  })
}

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
 * The replay report. `speedup` is baseline wall time over normal-mode wall
 * time, and 0 when nothing ran in normal mode.
 *
 * @category report
 * @throws {never}
 * @since 0.1.0
 */
export const reportOf = (
  repository: string,
  commits: ReadonlyArray<ReplayCommit>,
  selection: Metrics | undefined,
  left: ReadonlyArray<NotReplayed>
): ReplayReport => {
  const sum = (wall: (commit: ReplayCommit) => number): number =>
    commits.reduce((total, commit) => total + wall(commit), 0)
  const baselineWallMs = sum((commit) => commit.baseline.wallMs)
  const normalWallMs = sum((commit) => commit.normal.wallMs)
  return {
    version: 1,
    repository,
    commits,
    baselineWallMs,
    normalWallMs,
    speedup: normalWallMs === 0 ? 0 : baselineWallMs / normalWallMs,
    mismatches: commits.reduce((total, commit) => total + commit.mismatches.length, 0),
    ...(selection === undefined ? {} : { fastWallMs: sum((commit) => commit.fast?.wallMs ?? 0), selection }),
    ...(left.length === 0 ? {} : { notReplayed: left })
  }
}
