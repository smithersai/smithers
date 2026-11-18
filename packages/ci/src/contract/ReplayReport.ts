/**
 * Contract 5: the replay report.
 *
 * The replay runs past commits three ways and compares them: the baseline is
 * the repository's CI as it is today, normal mode runs only affected targets
 * with the cache, and fast mode also skips what the scorer judged safe. The
 * report renderer, the splash page's numbers and the cache acceptance test all
 * read this one document.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import { NotReplayed } from "./Inventory.ts"
import { Mode, StatusCounts, Verdict } from "./RunRecord.ts"
import { Metrics } from "./Selection.ts"

/**
 * One way of running one commit. `wallMs` is elapsed time; `workMs` is the
 * sum of every target's own time.
 *
 * @category models
 * @since 0.1.0
 */
export const RunTotals = Schema.Struct({
  ok: Schema.Boolean,
  wallMs: Schema.Finite,
  workMs: Schema.Finite,
  counts: StatusCounts
})

/**
 * A decoded `RunTotals`.
 *
 * @category models
 * @since 0.1.0
 */
export type RunTotals = typeof RunTotals.Type

/**
 * A target whose verdict in a mode differs from its baseline verdict. A
 * `predicted-safe` skip of a target that failed in the baseline is a
 * mismatch; a skip of one that passed is not.
 *
 * @category models
 * @since 0.1.0
 */
export const Mismatch = Schema.Struct({
  label: Schema.NonEmptyString,
  mode: Mode,
  baseline: Verdict,
  got: Verdict
})

/**
 * A decoded `Mismatch`.
 *
 * @category models
 * @since 0.1.0
 */
export type Mismatch = typeof Mismatch.Type

/**
 * One replayed commit.
 *
 * @category models
 * @since 0.1.0
 */
export const ReplayCommit = Schema.Struct({
  commit: Schema.NonEmptyString,
  changedFiles: Schema.Int,
  baseline: RunTotals,
  normal: RunTotals,
  mismatches: Schema.Array(Mismatch),
  fast: Schema.optionalKey(RunTotals)
})

/**
 * A decoded `ReplayCommit`.
 *
 * @category models
 * @since 0.1.0
 */
export type ReplayCommit = typeof ReplayCommit.Type

/**
 * The whole replay. `speedup` is baseline wall time divided by normal-mode
 * wall time, summed over every commit.
 *
 * @category models
 * @since 0.1.0
 */
export const ReplayReport = Schema.Struct({
  version: Schema.Literal(1),
  repository: Schema.NonEmptyString,
  commits: Schema.Array(ReplayCommit),
  baselineWallMs: Schema.Finite,
  normalWallMs: Schema.Finite,
  speedup: Schema.Finite,
  mismatches: Schema.Int,
  fastWallMs: Schema.optionalKey(Schema.Finite),
  selection: Schema.optionalKey(Metrics),
  notReplayed: Schema.optionalKey(Schema.Array(NotReplayed)),
  targets: Schema.optionalKey(Schema.Array(Schema.NonEmptyString))
})

/**
 * A decoded `ReplayReport`.
 *
 * @category models
 * @since 0.1.0
 */
export type ReplayReport = typeof ReplayReport.Type
