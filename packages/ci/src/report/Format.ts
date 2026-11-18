/**
 * The numbers both renderers print: durations, speedups, shares, bars and
 * short commit ids. Shared so the terminal and the page never disagree.
 *
 * @since 0.1.0
 */

import { type NotReplayed, reasonsText, type ToolVersion } from "../contract/Inventory.ts"

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
 * Why a job was left out: each feature once, in the order found, and a
 * missing tool with what to install.
 *
 * @category formatting
 * @since 0.1.0
 */
export const reasons = (entry: NotReplayed): string => reasonsText(entry.reasons)

/**
 * A tool this machine has at another version than a job asks for, as one
 * line after the job's name.
 *
 * @category formatting
 * @since 0.1.0
 */
export const toolVersion = (entry: ToolVersion): string =>
  `asks for ${entry.tool} ${entry.asked}; this machine has ${entry.tool} ${entry.found}`

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
