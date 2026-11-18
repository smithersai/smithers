/**
 * Contract 6: fast mode's data, scorer and metrics.
 *
 * The definitions follow Machalica, Samylkin, Porth and Chandra, "Predictive
 * Test Selection" (arXiv:1810.05286), sections III and IV. A row is one change
 * and one target the dependency graph selects for it. The scorer returns a
 * number from 0 to 1 per row. Selection keeps every target at or above a
 * score cutoff, plus the highest-scoring few.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * What the scorer reads about one change and one target: the paper's best
 * feature set.
 *
 * @category models
 * @since 0.1.0
 */
export const Features = Schema.Struct({
  extensions: Schema.Array(Schema.String),
  fileChanges: Schema.Struct({ d3: Schema.Int, d14: Schema.Int, d56: Schema.Int }),
  failureRates: Schema.Struct({ d7: Schema.Finite, d14: Schema.Finite, d28: Schema.Finite, d56: Schema.Finite }),
  project: Schema.String,
  testCount: Schema.Int,
  graphDistance: Schema.Int
})

/**
 * A decoded `Features`.
 *
 * @category models
 * @since 0.1.0
 */
export type Features = typeof Features.Type

/**
 * One change and one target that depends on it. `failed` is true only when
 * every attempt failed; `flaky` is true when attempts disagreed. A flaky row
 * is never a positive.
 *
 * @category models
 * @since 0.1.0
 */
export const Row = Schema.Struct({
  commit: Schema.NonEmptyString,
  target: Schema.NonEmptyString,
  features: Features,
  attempts: Schema.Array(Schema.Boolean),
  failed: Schema.Boolean,
  flaky: Schema.Boolean
})

/**
 * A decoded `Row`.
 *
 * @category models
 * @since 0.1.0
 */
export type Row = typeof Row.Type

/**
 * The scorer's answer for one row: the estimated chance the target fails on
 * the change, from 0 to 1.
 *
 * @category models
 * @since 0.1.0
 */
export const Score = Schema.Struct({
  commit: Schema.NonEmptyString,
  target: Schema.NonEmptyString,
  score: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  reason: Schema.optionalKey(Schema.String)
})

/**
 * A decoded `Score`.
 *
 * @category models
 * @since 0.1.0
 */
export type Score = typeof Score.Type

/**
 * The two selection settings. A target is selected when its score is at
 * least `scoreCutoff`, or when it is among the `countCutoff` highest-scoring
 * targets of its change.
 *
 * @category models
 * @since 0.1.0
 */
export const Settings = Schema.Struct({
  scoreCutoff: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  countCutoff: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})

/**
 * A decoded `Settings`.
 *
 * @category models
 * @since 0.1.0
 */
export type Settings = typeof Settings.Type

/**
 * How well a selection did against rows whose outcomes are known.
 *
 * - `testRecall`: of all failures, the share whose target was selected.
 * - `changeRecall`: of all changes with a failure, the share where at least
 *   one failing target was selected.
 * - `selectionRate`: targets selected, divided by targets the dependency
 *   graph selected.
 *
 * Both recalls are absent when no row failed: the paper defines them only
 * over a set with at least one failure. `failures` and `failedChanges` are
 * the counts behind them.
 *
 * @category models
 * @since 0.1.0
 */
export const Metrics = Schema.Struct({
  rows: Schema.Int,
  selected: Schema.Int,
  failures: Schema.Int,
  failedChanges: Schema.Int,
  selectionRate: Schema.Finite,
  testRecall: Schema.optionalKey(Schema.Finite),
  changeRecall: Schema.optionalKey(Schema.Finite)
})

/**
 * A decoded `Metrics`.
 *
 * @category models
 * @since 0.1.0
 */
export type Metrics = typeof Metrics.Type

/**
 * The targets selected for one change, sorted by label. `scores` holds the
 * scores of that one change only.
 *
 * @category selection
 * @since 0.1.0
 */
export const select = (scores: ReadonlyArray<Score>, settings: Settings): ReadonlyArray<string> => {
  const ranked = [...scores].sort((a, b) => b.score - a.score || (a.target < b.target ? -1 : 1))
  const chosen = new Set<string>()
  for (const [index, entry] of ranked.entries()) {
    if (entry.score >= settings.scoreCutoff || index < settings.countCutoff) chosen.add(entry.target)
  }
  return [...chosen].sort()
}

/**
 * The paper's three metrics for a selection over rows with known outcomes.
 * `selected` maps a commit to the targets selected for it; a commit it does
 * not hold selected nothing.
 *
 * @category selection
 * @since 0.1.0
 */
export const metrics = (
  rows: ReadonlyArray<Row>,
  selected: ReadonlyMap<string, ReadonlyArray<string>>
): Metrics => {
  const isSelected = (row: Row): boolean => (selected.get(row.commit) ?? []).includes(row.target)
  const failures = rows.filter((row) => row.failed)
  const failedChanges = new Set(failures.map((row) => row.commit))
  const caughtChanges = new Set(failures.filter(isSelected).map((row) => row.commit))
  const selectedCount = rows.filter(isSelected).length
  return {
    rows: rows.length,
    selected: selectedCount,
    failures: failures.length,
    failedChanges: failedChanges.size,
    selectionRate: rows.length === 0 ? 0 : selectedCount / rows.length,
    ...(failures.length === 0 ? {} : {
      testRecall: failures.filter(isSelected).length / failures.length,
      changeRecall: caughtChanges.size / failedChanges.size
    })
  }
}
