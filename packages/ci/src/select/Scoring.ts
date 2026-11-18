/**
 * What the scorer asks the judge and how it reads the answers, as pure
 * functions.
 *
 * The judge reads only a row's features, so rows with equal features share
 * one question and one answer.
 *
 * @since 0.1.0
 */

import { Classifier } from "@smthrs/model"
import * as Schema from "effect/Schema"
import type { Features, Row, Score } from "../contract/Selection.ts"
import { unreachable } from "./Features.ts"

/**
 * How many distinct feature sets one request to the judge holds.
 *
 * @category constants
 * @since 0.1.0
 */
export const batchSize = 16

/**
 * How many requests to the judge run at once.
 *
 * @category constants
 * @since 0.1.0
 */
export const concurrency = 4

/**
 * The facts the judge can name as what most decides a score, each with the
 * one-line reason a score carries.
 *
 * @category constants
 * @since 0.1.0
 */
export const reasons = {
  history: "The target failed in recent runs.",
  distance: "The change is close to the target in the dependency graph.",
  churn: "The changed files have changed often lately.",
  kind: "The kind of file changed tends to break this target.",
  size: "The target holds many tests.",
  none: "Nothing in the features points to a failure."
} as const

/**
 * What the judge is told once per request.
 *
 * @category constants
 * @since 0.1.0
 */
export const about =
  "Each item is one code change and one build target the change affects. Estimate how likely the target is to fail on the change. Most targets pass on most changes. A target's recent failure rate is the strongest sign; then how close the change is to the target in the dependency graph, how often the changed files have changed lately, and what kind of files changed."

/**
 * One item as the judge reads it: the six features under plain names.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Item = Schema.Struct({
  item: Schema.Int,
  changedFileExtensions: Schema.Array(Schema.String),
  commitsToTheChangedFiles: Schema.Struct({ last3Days: Schema.Int, last14Days: Schema.Int, last56Days: Schema.Int }),
  targetFailureRate: Schema.Struct({
    last7Days: Schema.Finite,
    last14Days: Schema.Finite,
    last28Days: Schema.Finite,
    last56Days: Schema.Finite
  }),
  targetProject: Schema.String,
  testsInTarget: Schema.Int,
  dependencyDistance: Schema.Union([Schema.Int, Schema.Literal("no known path")])
})

/**
 * The state of one request: what the items are, then the items.
 *
 * @category schemas
 * @since 0.1.0
 */
export const State = Schema.Struct({ about: Schema.String, items: Schema.Array(Item) })

/**
 * What the judge answered for one feature set: the chance of a failure and
 * the one-line reason.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Reading = Schema.Struct({
  score: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  reason: Schema.String
})

/**
 * A decoded `Reading`.
 *
 * @category models
 * @since 0.1.0
 */
export type Reading = typeof Reading.Type

/**
 * A text equal for equal features and different otherwise.
 *
 * @category grouping
 * @since 0.1.0
 * @throws {never}
 */
export const keyOf = (features: Features): string =>
  JSON.stringify([
    features.extensions,
    [features.fileChanges.d3, features.fileChanges.d14, features.fileChanges.d56],
    [features.failureRates.d7, features.failureRates.d14, features.failureRates.d28, features.failureRates.d56],
    features.project,
    features.testCount,
    features.graphDistance
  ])

/**
 * The distinct feature sets of `rows`, ordered by {@link keyOf} and cut into
 * batches of at most {@link batchSize}. Equal rows give equal batches, so a
 * request already answered is not asked again.
 *
 * @category grouping
 * @since 0.1.0
 * @throws {never}
 */
export const batches = (rows: ReadonlyArray<Row>): ReadonlyArray<ReadonlyArray<Features>> => {
  const distinct = new Map<string, Features>()
  for (const row of rows) distinct.set(keyOf(row.features), row.features)
  const ordered = [...distinct.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, features]) => features)
  const cut: Array<ReadonlyArray<Features>> = []
  for (let start = 0; start < ordered.length; start += batchSize) cut.push(ordered.slice(start, start + batchSize))
  return cut
}

/**
 * The state the judge reads for one batch.
 *
 * @category asking
 * @since 0.1.0
 * @throws {never}
 */
export const stateOf = (items: ReadonlyArray<Features>): typeof State.Type => ({
  about,
  items: items.map((features, item) => ({
    item,
    changedFileExtensions: features.extensions,
    commitsToTheChangedFiles: {
      last3Days: features.fileChanges.d3,
      last14Days: features.fileChanges.d14,
      last56Days: features.fileChanges.d56
    },
    targetFailureRate: {
      last7Days: features.failureRates.d7,
      last14Days: features.failureRates.d14,
      last28Days: features.failureRates.d28,
      last56Days: features.failureRates.d56
    },
    targetProject: features.project,
    testsInTarget: features.testCount,
    dependencyDistance: features.graphDistance === unreachable ? "no known path" : features.graphDistance
  }))
})

/** The question ids of one item. */
const ids = (item: number): { readonly fails: string; readonly why: string } => ({
  fails: `fails${item}`,
  why: `why${item}`
})

/**
 * The classifier for a batch of `count` items: for each item, whether its
 * target fails on its change, and which fact most decides that.
 *
 * @category asking
 * @since 0.1.0
 * @throws {never}
 */
export const classifier = (count: number) =>
  Classifier.make("ci/select/risk", {
    description: "How likely each build target is to fail on its change, and why.",
    state: State,
    questions: Object.fromEntries(
      Array.from({ length: count }, (_, item) => [
        [
          ids(item).fails,
          Classifier.boolean({
            instructions: `Item ${item}: does this target fail on this change?`,
            criteria: {
              true: "The target fails on every attempt: the change broke it.",
              false: "The target passes, or fails only on some attempts."
            }
          })
        ],
        [
          ids(item).why,
          Classifier.choice({
            instructions: `Item ${item}: which fact most decides how likely this target is to fail on this change?`,
            criteria: reasons
          })
        ]
      ]).flat()
    ) as Classifier.Questions,
    seatNote:
      "A boolean answer's probability is your estimate of the chance the target fails, from 0 to 1. With a failure rate of 0 in every window and no other sign, answer below 0.05. A recent failure rate is a base rate: do not answer far below it."
  })

/**
 * The readings in a batch's answers, one per item, in order.
 *
 * @category reading
 * @since 0.1.0
 * @throws {never}
 */
export const readingsOf = (
  count: number,
  answers: Readonly<Record<string, Classifier.Answer>>
): ReadonlyArray<Reading> =>
  Array.from({ length: count }, (_, item) => {
    const fails = answers[ids(item).fails] as Classifier.BooleanAnswer
    const why = answers[ids(item).why] as Classifier.ChoiceAnswer<keyof typeof reasons>
    return { score: fails.probability, reason: reasons[why.value] }
  })

/**
 * One score per row: the reading of the row's feature set.
 *
 * @category reading
 * @since 0.1.0
 * @throws {never}
 */
export const scoresOf = (
  rows: ReadonlyArray<Row>,
  asked: ReadonlyArray<ReadonlyArray<Features>>,
  answered: ReadonlyArray<ReadonlyArray<Reading>>
): ReadonlyArray<Score> => {
  const readings = new Map<string, Reading>()
  for (const [batch, items] of asked.entries()) {
    for (const [item, features] of items.entries()) readings.set(keyOf(features), answered[batch]![item]!)
  }
  return rows.map((row) => {
    const reading = readings.get(keyOf(row.features))!
    return { commit: row.commit, target: row.target, score: reading.score, reason: reading.reason }
  })
}
