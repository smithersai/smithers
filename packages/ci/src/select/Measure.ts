/**
 * Measures fast mode against rows whose outcomes are known, the way
 * Machalica, Samylkin, Porth and Chandra measure theirs (arXiv:1810.05286,
 * sections III, IV-C and VI-A): split by time, sweep the two settings, and
 * report test recall, change recall and selection rate with their counts.
 *
 * @since 0.1.0
 */

import * as Selection from "../contract/Selection.ts"
import { day, type Observation } from "./Features.ts"

/**
 * The test set is the rows of this many days up to the newest row.
 *
 * @category constants
 * @since 0.1.0
 */
export const testDays = 7

/**
 * The bar the paper holds its model to before a merge: test recall above
 * 0.95 and change recall above 0.999.
 *
 * @category constants
 * @since 0.1.0
 */
export const bar = { testRecall: 0.95, changeRecall: 0.999 } as const

/**
 * The paper's weekly check of a new model: at a test recall of at least 0.9
 * with the count cutoff at 0, the selection rate must be below 0.3.
 *
 * @category constants
 * @since 0.1.0
 */
export const weekly = { testRecall: 0.9, selectionRate: 0.3 } as const

/**
 * The settings fast mode starts with, before an eval on the repository's own
 * history calibrates them.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaults: Selection.Settings = { scoreCutoff: 0.05, countCutoff: 5 }

/**
 * The score cutoffs swept with the count cutoff at 0, highest first.
 *
 * @category constants
 * @since 0.1.0
 */
export const scoreCutoffs: ReadonlyArray<number> = [1, 0.9, 0.7, 0.5, 0.3, 0.2, 0.1, 0.05, 0.02, 0.01, 0]

/**
 * The count cutoffs swept with the score cutoff at 1, lowest first.
 *
 * @category constants
 * @since 0.1.0
 */
export const countCutoffs: ReadonlyArray<number> = [0, 1, 2, 5, 10, 20, 50, 100]

/**
 * Rows split by time: the newest {@link testDays} days are the test set, and
 * the rows before them are the history the test set's features were built
 * from.
 *
 * @category models
 * @since 0.1.0
 */
export interface Split {
  /** The first instant of the test set, in milliseconds since the epoch. */
  readonly from: number
  /** The time of the newest row. */
  readonly to: number
  readonly history: ReadonlyArray<Observation>
  readonly test: ReadonlyArray<Observation>
}

/**
 * Splits rows by the time of their change.
 *
 * @category measuring
 * @since 0.1.0
 * @throws {never}
 */
export const split = (observations: ReadonlyArray<Observation>): Split => {
  const to = observations.reduce((newest, observation) => Math.max(newest, observation.at), 0)
  const from = to - testDays * day
  return {
    from,
    to,
    history: observations.filter((observation) => observation.at <= from),
    test: observations.filter((observation) => observation.at > from)
  }
}

/**
 * At most `count` of the test set's changes, evenly spaced through its time
 * order, with all of their rows. Every change has the same chance, so the
 * metrics of the sample estimate the metrics of the test set.
 *
 * @category measuring
 * @since 0.1.0
 * @throws {never}
 */
export const sample = (test: ReadonlyArray<Observation>, count: number): ReadonlyArray<Observation> => {
  const times = new Map<string, number>()
  for (const observation of test) times.set(observation.row.commit, observation.at)
  const ordered = [...times].sort(([a, first], [b, second]) => first - second || (a < b ? -1 : 1)).map(([commit]) =>
    commit
  )
  if (count >= ordered.length) return test
  const kept = new Set(
    Array.from({ length: count }, (_, index) => ordered[Math.floor((index * ordered.length) / count)]!)
  )
  return test.filter((observation) => kept.has(observation.row.commit))
}

/**
 * The targets selected for each change under `settings`.
 *
 * @category measuring
 * @since 0.1.0
 * @throws {never}
 */
export const selected = (
  scores: ReadonlyArray<Selection.Score>,
  settings: Selection.Settings
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const changes = new Map<string, Array<Selection.Score>>()
  for (const score of scores) {
    const known = changes.get(score.commit)
    if (known === undefined) changes.set(score.commit, [score])
    else known.push(score)
  }
  return new Map([...changes].map(([commit, own]) => [commit, Selection.select(own, settings)]))
}

/**
 * One setting and what it measured.
 *
 * @category models
 * @since 0.1.0
 */
export interface Point {
  readonly settings: Selection.Settings
  readonly metrics: Selection.Metrics
}

/**
 * The paper's three metrics for `settings`, by `Selection.metrics`.
 *
 * @category measuring
 * @since 0.1.0
 * @throws {never}
 */
export const measure = (
  rows: ReadonlyArray<Selection.Row>,
  scores: ReadonlyArray<Selection.Score>,
  settings: Selection.Settings
): Point => ({ settings, metrics: Selection.metrics(rows, selected(scores, settings)) })

/**
 * The lowest recall a measurement supports at 95% confidence, by Wilson's
 * one-sided bound: `caught` of `total`. A small `total` supports little, and
 * that is the limit a small history puts on a recall claim.
 *
 * @category measuring
 * @since 0.1.0
 * @throws {never}
 */
export const lowerBound = (caught: number, total: number): number => {
  const z = 1.6448536269514722
  const share = caught / total
  const centre = share + (z * z) / (2 * total)
  const spread = z * Math.sqrt((share * (1 - share)) / total + (z * z) / (4 * total * total))
  return Math.max(0, (centre - spread) / (1 + (z * z) / total))
}

/**
 * What an eval reports.
 *
 * `byScore` sweeps the score cutoff with the count cutoff at 0, and `byCount`
 * sweeps the count cutoff with the score cutoff at 1, as the paper's figures
 * 6 and 7 do. `weekly` is the highest swept score cutoff whose test recall
 * reaches {@link weekly}. `calibrated` is the paper's calibration to
 * {@link bar}: the highest swept score cutoff whose test recall passes, then
 * the lowest swept count cutoff that, with it, passes the change recall. With
 * no failure in the rows, `recall` says why no recall is reported, and there
 * is no weekly check and no calibration.
 *
 * @category models
 * @since 0.1.0
 */
export interface Report {
  readonly rows: number
  readonly changes: number
  readonly failures: number
  readonly failedChanges: number
  readonly flaky: number
  readonly recall: "measured" | "refused: no entry failed, so there is no failure to recall"
  readonly start: Point
  readonly byScore: ReadonlyArray<Point>
  readonly byCount: ReadonlyArray<Point>
  readonly weekly?: Point
  readonly calibrated?: Point
}

/**
 * Measures `scores` against `rows`. It refuses to report a recall when no
 * row failed: the paper defines recall only over a set with a failure.
 *
 * @category measuring
 * @since 0.1.0
 * @throws {never}
 */
export const report = (rows: ReadonlyArray<Selection.Row>, scores: ReadonlyArray<Selection.Score>): Report => {
  const byScore = scoreCutoffs.map((scoreCutoff) => measure(rows, scores, { scoreCutoff, countCutoff: 0 }))
  const byCount = countCutoffs.map((countCutoff) => measure(rows, scores, { scoreCutoff: 1, countCutoff }))
  const start = measure(rows, scores, defaults)
  const counted = {
    rows: rows.length,
    changes: new Set(rows.map((row) => row.commit)).size,
    failures: start.metrics.failures,
    failedChanges: start.metrics.failedChanges,
    flaky: rows.filter((row) => row.flaky).length,
    start,
    byScore,
    byCount
  }
  if (start.metrics.failures === 0) {
    return { ...counted, recall: "refused: no entry failed, so there is no failure to recall" }
  }
  // A score cutoff of 0 selects every target, so each search below finds a point.
  const passing = byScore.find((point) => point.metrics.testRecall! > bar.testRecall)!
  let calibrated = passing
  for (const countCutoff of countCutoffs) {
    calibrated = measure(rows, scores, { scoreCutoff: passing.settings.scoreCutoff, countCutoff })
    if (calibrated.metrics.changeRecall! > bar.changeRecall) break
  }
  return {
    ...counted,
    recall: "measured",
    weekly: byScore.find((point) => point.metrics.testRecall! >= weekly.testRecall)!,
    calibrated
  }
}

const whole = (count: number): string => count.toLocaleString("en-US")
const share = (value: number): string => value.toFixed(3)

/** One point as a line: the settings, then each metric with the counts behind it. */
const line = (point: Point): string => {
  const { metrics, settings } = point
  const rate = `selection rate ${share(metrics.selectionRate)} (${whole(metrics.selected)} of ${whole(metrics.rows)})`
  if (metrics.testRecall === undefined || metrics.changeRecall === undefined) {
    return `  score >= ${settings.scoreCutoff}, top ${settings.countCutoff}: ${rate}`
  }
  const caught = Math.round(metrics.testRecall * metrics.failures)
  const caughtChanges = Math.round(metrics.changeRecall * metrics.failedChanges)
  return `  score >= ${settings.scoreCutoff}, top ${settings.countCutoff}: test recall ${share(metrics.testRecall)} (${
    whole(caught)
  } of ${whole(metrics.failures)}), change recall ${share(metrics.changeRecall)} (${whole(caughtChanges)} of ${
    whole(metrics.failedChanges)
  }), ${rate}`
}

/**
 * The report as text: every number with the counts behind it.
 *
 * @category rendering
 * @since 0.1.0
 * @throws {never}
 */
export const render = (name: string, measured: Report): string => {
  const lines = [
    `Fast mode eval: ${name}`,
    `Test set: ${whole(measured.rows)} entries in ${whole(measured.changes)} changes; ${
      whole(measured.failures)
    } failures in ${whole(measured.failedChanges)} changes; ${
      whole(measured.flaky)
    } flaky entries, which are not failures`,
    "",
    "Starting settings",
    line(measured.start),
    "",
    "Score cutoff sweep, count cutoff 0",
    ...measured.byScore.map(line),
    "",
    "Count cutoff sweep, score cutoff 1",
    ...measured.byCount.map(line),
    ""
  ]
  if (measured.weekly === undefined || measured.calibrated === undefined) {
    return [...lines, `Recall ${measured.recall}.`].join("\n")
  }
  return [
    ...lines,
    `Weekly check: at a test recall of at least ${weekly.testRecall} with count cutoff 0, the selection rate must be below ${weekly.selectionRate}: ${
      measured.weekly.metrics.selectionRate < weekly.selectionRate ? "passed" : "not passed"
    }`,
    line(measured.weekly),
    "",
    `Calibrated to test recall above ${bar.testRecall} and change recall above ${bar.changeRecall}`,
    line(measured.calibrated),
    `Failed changes: ${
      whole(measured.failedChanges)
    }. With every one caught, the most that supports at 95% confidence is a change recall above ${
      share(lowerBound(measured.failedChanges, measured.failedChanges))
    }. A change recall above ${bar.changeRecall} needs about 2,700 failed changes, all caught; a history with fewer than 1,000 cannot show it.`
  ].join("\n")
}
