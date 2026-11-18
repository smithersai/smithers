/**
 * The numbers both renderers print: durations, speedups, shares, bars and
 * short commit ids. Shared so the terminal and the page never disagree.
 *
 * @since 0.1.0
 */

import type { NotReplayed } from "../contract/Inventory.ts"

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
 * A ratio as a multiplier: one decimal below 100, whole above.
 *
 * @since 0.1.0
 * @private
 */
export const times = (ratio: number): string => `${ratio < 100 ? ratio.toFixed(1) : Math.round(ratio)}×`

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
 * Why a job was left out: each feature once, in the order found.
 *
 * @category formatting
 * @since 0.1.0
 */
export const reasons = (entry: NotReplayed): string =>
  [...new Set(entry.reasons.map((reason) => reason.feature))].join(", ")
