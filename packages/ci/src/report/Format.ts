/**
 * The numbers both renderers print: durations, speedups, shares, bars and
 * short commit ids. Shared so the terminal and the page never disagree.
 *
 * @since 0.1.0
 */

import type { NotReplayed, ToolVersion, Unsupported } from "../contract/Inventory.ts"
import { reasonsSentence } from "../contract/Reasons.ts"
import type { FirstRun, ReplayCommit, ReplayReport, StepFailure } from "../contract/ReplayReport.ts"

/**
 * Elapsed time in the largest units that keep it short: `850ms`, `12.3s`,
 * `7m 20s`, `1h 05m`.
 *
 * @since 0.1.0
 * @private
 */
export const duration = (ms: number): string => {
  if (ms < 950) return `${Math.round(ms)}ms`
  if (ms < 59_950) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`
  const seconds = Math.round(ms / 1000)
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`
  const minutes = Math.round(seconds / 60)
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`
}

const pad = (value: number): string => String(value).padStart(2, "0")

/**
 * A ratio as a multiplier: one decimal below 100, whole above, and two
 * significant digits below a tenth, so a mode 26 times slower reads `0.038×`
 * and not `0.0×`.
 *
 * @since 0.1.0
 * @private
 */
export const times = (ratio: number): string => {
  if (ratio > 0 && ratio < 0.095) return `${Number(ratio.toPrecision(2))}×`
  return `${ratio < 100 ? ratio.toFixed(1) : Math.round(ratio)}×`
}

/**
 * The line that says fast mode has no numbers, and why.
 *
 * @since 0.1.0
 * @private
 */
export const fastNotMeasured = (reason: string): string => `Fast mode was not measured. ${reason}`

/**
 * Whether a run passed, as one word.
 *
 * @category formatting
 * @since 0.1.0
 */
export const verdict = (ok: boolean): string => ok ? "pass" : "fail"

/**
 * The headline: `6.0× faster`, or `1.3× slower` when the ratio is below one.
 *
 * @since 0.1.0
 * @private
 */
export const speedup = (ratio: number): string =>
  ratio > 0 && ratio < 1 ? `${times(1 / ratio)} slower` : `${times(ratio)} faster`

/**
 * Baseline time over a mode's time, or nothing when the mode took no time.
 *
 * @since 0.1.0
 * @private
 */
export const ratio = (baselineMs: number, modeMs: number): number | undefined =>
  modeMs > 0 ? baselineMs / modeMs : undefined

/**
 * A share from 0 to 1 as a whole percentage.
 *
 * @since 0.1.0
 * @private
 */
export const percent = (share: number): string => `${Math.round(share * 100)}%`

/**
 * A count and its noun, plural unless the count is one.
 *
 * @since 0.1.0
 * @private
 */
export const count = (value: number, one: string, many = `${one}s`): string => `${value} ${value === 1 ? one : many}`

/**
 * `1 mismatch`, `2 mismatches`.
 *
 * @since 0.1.0
 * @private
 */
export const mismatches = (value: number): string => count(value, "mismatch", "mismatches")

/**
 * A commit id cut to the seven characters a person reads.
 *
 * @since 0.1.0
 * @private
 */
export const shortCommit = (commit: string): string => commit.slice(0, 7)

const eighths = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"]

/**
 * A horizontal bar `width` cells wide at most, drawn in eighths of a cell.
 * Any time above zero shows at least one eighth.
 *
 * @since 0.1.0
 * @private
 */
export const bar = (value: number, max: number, width: number): string => {
  const total = max > 0 ? Math.round((value / max) * width * 8) : 0
  const drawn = value > 0 ? Math.max(total, 1) : 0
  return "█".repeat(Math.floor(drawn / 8)) + eighths[drawn % 8]
}

/**
 * How many CI jobs were left out, or nothing when none was.
 *
 * @category formatting
 * @since 0.1.0
 */
export const leftOut = (jobs: number): string => jobs === 0 ? "" : ` · ${count(jobs, "job")} not replayed`

/**
 * How many verdicts were flaky, or nothing when none was. They stand beside
 * the mismatches and are not among them: a flaky step passed in the end.
 *
 * @category formatting
 * @since 0.1.0
 */
export const flaky = (verdicts: number): string => verdicts === 0 ? "" : ` · ${verdicts} flaky`

/**
 * How many things the inventory could not read, or nothing when it read all.
 *
 * @category formatting
 * @since 0.1.0
 */
export const unread = (entries: number): string => entries === 0 ? "" : ` · ${entries} not read`

/**
 * How many commits were not replayed, or nothing when every one was.
 *
 * @category formatting
 * @since 0.1.0
 */
export const commitsLeftOut = (commits: number): string =>
  commits === 0 ? "" : ` · ${count(commits, "commit")} not replayed`

/**
 * The first line of why a commit was not replayed; the rest lists jobs.
 *
 * @category formatting
 * @since 0.1.0
 */
export const firstLine = (reason: string): string => reason.split("\n")[0] as string

/**
 * Why a job was left out, in sentences a person can act on.
 *
 * @category formatting
 * @since 0.1.0
 */
export const reasons = (entry: NotReplayed): string => reasonsSentence(entry.reasons)

/**
 * What could not be read, as a person reads it: the entry's own words, or the
 * sentence for its reason when it has none.
 *
 * @category formatting
 * @since 0.1.0
 */
export const unreadText = (entry: Unsupported): string => entry.detail === "" ? reasonsSentence([entry]) : entry.detail

/**
 * A tool this machine has at another version than a job asks for, as one
 * line after the job's name.
 *
 * @category formatting
 * @since 0.1.0
 */
export const toolVersion = (entry: ToolVersion): string =>
  `asks for ${entry.tool} ${entry.asked}; this machine has ${entry.tool} ${entry.found}`

/**
 * The variables a replayed job ran with empty, and what that means for the
 * baseline's time, as one line.
 *
 * @category formatting
 * @since 0.1.0
 */
export const leftEmpty = (names: ReadonlyArray<string>): string =>
  `${names.join(", ")} left empty: the baseline ran without the remote cache ${
    names.length === 1 ? "it opens" : "they open"
  }`

const shownTargets = 3

/**
 * The Smithers build patterns a replay ran, on a repository that already
 * builds with Smithers build: the first three, and how many more.
 *
 * @category formatting
 * @since 0.1.0
 */
export const ownTargets = (targets: ReadonlyArray<string>): string =>
  `own targets  ${targets.slice(0, shownTargets).join(" ")}${
    targets.length > shownTargets ? ` +${targets.length - shownTargets}` : ""
  }`

/**
 * How many commits the speedup covers: those whose baseline passed. A report
 * that does not say covers every commit.
 *
 * @category formatting
 * @since 0.1.0
 */
export const speedupCommits = (report: ReplayReport): number => report.speedupCommits ?? report.commits.length

/**
 * What stands in the place of the speedup when no commit's baseline passed.
 *
 * @category constants
 * @since 0.1.0
 */
export const noSpeedup = "no speedup: the CI failed at every replayed commit"

/**
 * What stands in the place of the speedup when normal mode's result differed
 * from the CI's: why there is none, and what to do.
 *
 * @category constants
 * @since 0.1.0
 */
export const noSpeedupMismatch =
  "no speedup: normal mode gave another result than your CI, so its time measures nothing. Each mismatch is listed below with its commit; fix what it names, or report it, and run this again."

/**
 * True when normal mode's result differs from the baseline's at a commit of
 * the report. A mismatch that says why (`Mismatch.cause`) is of the run as
 * `apply` leaves the repository: normal mode gave the baseline's result on
 * the commit's files.
 *
 * @category formatting
 * @since 0.1.0
 */
export const normalDiffers = (report: ReplayReport): boolean =>
  report.commits.some((commit) =>
    commit.mismatches.some((mismatch) => mismatch.mode === "normal" && mismatch.cause === undefined)
  )

/**
 * How many of the CI's jobs the numbers cover, or nothing when they cover
 * them all: `3 of 5 jobs`.
 *
 * @category formatting
 * @since 0.1.0
 */
export const jobsCovered = (report: ReplayReport): string =>
  report.jobs === undefined || report.jobs.replayed === report.jobs.total
    ? ""
    : `${report.jobs.replayed} of ${count(report.jobs.total, "job")}`

/**
 * The commits and jobs the speedup covers, or nothing when it covers them
 * all: `over 2 of 3 commits and 3 of 5 jobs`.
 *
 * @category formatting
 * @since 0.1.0
 */
export const coverage = (report: ReplayReport): string => {
  const covered = speedupCommits(report)
  const parts = [
    ...(covered === report.commits.length ? [] : [`${covered} of ${count(report.commits.length, "commit")}`]),
    ...(jobsCovered(report) === "" ? [] : [jobsCovered(report)])
  ]
  return parts.length === 0 ? "" : `over ${parts.join(" and ")}`
}

/**
 * The jobs replayed, for the line that counts commits, or nothing when every
 * job was.
 *
 * @category formatting
 * @since 0.1.0
 */
export const jobsCount = (report: ReplayReport): string => jobsCovered(report) === "" ? "" : ` · ${jobsCovered(report)}`

/**
 * How many jobs were not replayed at all. A job with only some matrix
 * variants left out is listed, and was replayed, so it is not counted when
 * the report says how many jobs it covers.
 *
 * @category formatting
 * @since 0.1.0
 */
export const jobsLeftOut = (report: ReplayReport): number =>
  report.jobs === undefined ? (report.notReplayed ?? []).length : report.jobs.total - report.jobs.replayed

/**
 * What finding the jobs that pass on this machine cost, as one line.
 *
 * @category formatting
 * @since 0.1.0
 */
export const trialTime = (ms: number): string =>
  `found the jobs that pass on this machine in ${duration(ms)}, which is in none of these times`

/**
 * What the run of the newest commit with the files `apply` writes cost, as
 * one line.
 *
 * @category formatting
 * @since 0.1.0
 */
export const appliedTime = (ms: number): string =>
  `ran the newest commit once more with the files apply writes in ${duration(ms)}, which is in none of these times`

/**
 * What the run before the first counted commit took in each way, as one
 * line: `the first run, with an empty cache, took 4m 10s as the baseline and
 * 5m 02s in normal mode; it happens once and is in none of these times`.
 *
 * @category formatting
 * @since 0.1.0
 */
export const firstRunTime = (run: FirstRun): string => {
  const ways = [
    `${duration(run.baselineMs)} as the baseline`,
    ...(run.normalMs === undefined ? [] : [`${duration(run.normalMs)} in normal mode`]),
    ...(run.fastMs === undefined ? [] : [`${duration(run.fastMs)} in fast mode`])
  ]
  const listed = ways.length === 1 ? ways[0] : `${ways.slice(0, -1).join(", ")} and ${ways.at(-1)}`
  return `the first run, with an empty cache, took ${listed}; it happens once and is in none of these times`
}

/** How a mode's CPU time compares with the baseline's: ` (6.5× less)`, or nothing when the mode used none. */
const beside = (baselineMs: number, modeMs: number): string => {
  const less = ratio(baselineMs, modeMs)
  if (less === undefined) return ""
  return less >= 1 ? ` (${times(less)} less)` : ` (${times(1 / less)} more)`
}

/**
 * The CPU time each way's steps used, as one line, or nothing when it could
 * not be read: `the steps used 26m 10s of CPU time as the baseline and 4m 02s
 * in normal mode (6.5× less)`.
 *
 * @category formatting
 * @since 0.1.0
 */
export const cpuTime = (report: ReplayReport): string | undefined => {
  const { baselineCpuMs: baseline, normalCpuMs: normal, fastCpuMs: fast } = report
  if (baseline === undefined || normal === undefined) return undefined
  const modes = [
    `${duration(normal)} in normal mode${beside(baseline, normal)}`,
    ...(fast === undefined ? [] : [`${duration(fast)} in fast mode${beside(baseline, fast)}`])
  ]
  return `the steps used ${duration(baseline)} of CPU time as the baseline${modes.length === 1 ? " and" : ","} ${
    modes.join(" and ")
  }`
}

/**
 * How many times failed steps ran again and what that took, as one line:
 * `2 failed steps ran again, which took 50m 10s and is in none of these times`.
 *
 * @category formatting
 * @since 0.1.0
 */
export const rerunTime = (reruns: { readonly count: number; readonly ms: number }): string =>
  `${count(reruns.count, "failed step")} ran again, which took ${duration(reruns.ms)} and is in none of these times`

/**
 * Why the first counted commit started with an empty cache, as one line.
 *
 * @category formatting
 * @since 0.1.0
 */
export const coldStart = (reason: string): string => `started with an empty cache: ${reason}`

/**
 * One failed step of a commit, with the ways of running it that it failed in.
 *
 * @category models
 * @since 0.1.0
 */
export interface FailedStep {
  readonly ways: ReadonlyArray<string>
  readonly failure: StepFailure
}

/**
 * The steps that failed at a commit. A step that failed with the same exit
 * code in the baseline and in a mode is one entry, with the reason of the
 * first way it failed in: the two take their reason from the same output,
 * and not always from the same line of it. Without an exit code, the reason
 * tells one failure from another.
 *
 * @category formatting
 * @since 0.1.0
 */
export const failedSteps = (commit: ReplayCommit): ReadonlyArray<FailedStep> => {
  const found = new Map<string, { readonly ways: Array<string>; readonly failure: StepFailure }>()
  const runs = [["baseline", commit.baseline], ["normal", commit.normal], ["fast", commit.fast]] as const
  for (const [way, totals] of runs) {
    for (const failure of totals?.failures ?? []) {
      const key = JSON.stringify([failure.step, failure.exitCode ?? failure.reason])
      const entry = found.get(key) ?? { ways: [], failure }
      if (!entry.ways.includes(way)) entry.ways.push(way)
      found.set(key, entry)
    }
  }
  return [...found.values()]
}

/**
 * A failure's exit code and reason: `exit 127: docker is not installed`.
 *
 * @category formatting
 * @since 0.1.0
 */
export const failureText = (failure: StepFailure): string =>
  `${failure.exitCode === undefined ? "" : `exit ${failure.exitCode}: `}${failure.reason}`
