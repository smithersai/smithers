/**
 * Predicted durations.
 *
 * The queue remembers how long each check took and predicts from that. A
 * prediction orders work and tells people when to expect a result. It never
 * decides what lands: `step` reads `history` only to append to it.
 *
 * Mirrors `lean/MergeQueue/Predict.lean` definition for definition.
 *
 * @since 0.1.0
 */

import type { Config, Result, Sample } from "./Basic.ts"
import { answered } from "./Step.ts"

/**
 * The remembered durations of one check, oldest first.
 *
 * @category durations
 * @since 0.1.0
 */
export const samples = (history: ReadonlyArray<Sample>, check: number): ReadonlyArray<number> =>
  history.filter((sample) => sample.check === check).map((sample) => sample.duration)

/**
 * The predicted duration of a check: the median of its samples (the upper one
 * of two middles), or the configured default with no samples.
 *
 * @category durations
 * @since 0.1.0
 */
export const estimate = (config: Config, history: ReadonlyArray<Sample>, check: number): number => {
  const sorted = [...samples(history, check)].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? config.defaultDuration
}

/**
 * The required checks in the order to start them: slowest first, so the check
 * that decides how long the run takes starts at once. Ties keep the configured
 * order.
 *
 * @category durations
 * @since 0.1.0
 */
export const schedule = (config: Config, history: ReadonlyArray<Sample>): ReadonlyArray<number> =>
  [...config.required].sort((left, right) => estimate(config, history, right) - estimate(config, history, left))

/**
 * The checks of a run that have no result yet, in schedule order.
 *
 * @category durations
 * @since 0.1.0
 */
export const remaining = (
  config: Config,
  history: ReadonlyArray<Sample>,
  results: ReadonlyArray<Result>
): ReadonlyArray<number> => schedule(config, history).filter((check) => !answered(results, check))

/**
 * The predicted time for a run's remaining checks when they run side by side:
 * the slowest of them.
 *
 * @category durations
 * @since 0.1.0
 */
export const eta = (config: Config, history: ReadonlyArray<Sample>, results: ReadonlyArray<Result>): number =>
  remaining(config, history, results).reduce((slowest, check) => Math.max(slowest, estimate(config, history, check)), 0)
