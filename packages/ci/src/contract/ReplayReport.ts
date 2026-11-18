/**
 * Contract 5: the replay report.
 *
 * The replay runs past commits three ways and compares them: the baseline is
 * the repository's CI as it is today, normal mode runs only affected targets
 * with the cache, and fast mode also skips what the model predicted safe. The
 * report renderer, the splash page's numbers and the cache acceptance test all
 * read this one document.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import { NotReplayed, ToolVersion, Unsupported } from "./Inventory.ts"
import { Mode, StatusCounts, Verdict } from "./RunRecord.ts"
import { Metrics } from "./Selection.ts"

/**
 * One step that failed: its name, why, and, when they are known, its exit code
 * and its command. `reason` is the first line of the step's error output, or
 * that a program it runs is not installed. A value shaped like a credential is
 * withheld from `reason` and `command`.
 *
 * @category models
 * @since 0.1.0
 */
export const StepFailure = Schema.Struct({
  step: Schema.NonEmptyString,
  reason: Schema.NonEmptyString,
  exitCode: Schema.optionalKey(Schema.Int),
  command: Schema.optionalKey(Schema.String)
})

/**
 * A decoded `StepFailure`.
 *
 * @category models
 * @since 0.1.0
 */
export type StepFailure = typeof StepFailure.Type

/**
 * One way of running one commit. `wallMs` is elapsed time; `workMs` is the
 * sum of every target's own time. `failures` names every step that failed in
 * the end, and is absent when none did.
 *
 * @category models
 * @since 0.1.0
 */
export const RunTotals = Schema.Struct({
  ok: Schema.Boolean,
  wallMs: Schema.Finite,
  workMs: Schema.Finite,
  counts: StatusCounts,
  failures: Schema.optionalKey(Schema.Array(StepFailure))
})

/**
 * A decoded `RunTotals`.
 *
 * @category models
 * @since 0.1.0
 */
export type RunTotals = typeof RunTotals.Type

/**
 * A target whose verdict in a mode differs from its baseline verdict.
 * `pass` and `flaky` agree: a step that passed in the end passed. A
 * `predicted-safe` skip of a target that failed in the baseline is a
 * mismatch; a skip of one that passed is not. A step that was split is a
 * mismatch when the mode never reported one of its targets.
 *
 * `cause` is present when the step passed in the baseline, failed in the
 * mode, and its output names a file Smithers CI wrote: a tool of the
 * repository read that file as one of its own. It is one line that names the
 * tool, the file, and what to add to the tool's ignore list. The mismatch
 * still counts.
 *
 * @category models
 * @since 0.1.0
 */
export const Mismatch = Schema.Struct({
  label: Schema.NonEmptyString,
  mode: Mode,
  baseline: Verdict,
  got: Verdict,
  cause: Schema.optionalKey(Schema.NonEmptyString)
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
 * A commit that was not replayed because its own CI could not be: it had
 * none, or none of it can be run on this machine. `reason` says which.
 *
 * @category models
 * @since 0.1.0
 */
export const NotReplayedCommit = Schema.Struct({
  commit: Schema.NonEmptyString,
  reason: Schema.String
})

/**
 * A decoded `NotReplayedCommit`.
 *
 * @category models
 * @since 0.1.0
 */
export type NotReplayedCommit = typeof NotReplayedCommit.Type

/**
 * The whole replay. Each commit in `commits` ran its own CI, read from its
 * own tree; a commit whose CI could not be replayed is in
 * `notReplayedCommits` and in no time. `speedup` is baseline wall time
 * divided by normal-mode wall time. It and the three wall times cover only the
 * commits whose baseline passed, because a failed baseline stops early and its
 * time measures nothing; `speedupCommits` says how many that is, and when it
 * is 0 there is no speedup and `speedup` is 0. A document without it covers
 * every commit. `flaky` is how many verdicts were
 * `flaky`, in the baseline and in every mode; they are counted apart from
 * `mismatches`. `notReplayed` lists the CI jobs, or matrix variants, that
 * were not run, and `notRead` what the inventory could not read at all, both
 * at the newest commit, so a speedup is never read as covering them.
 * `toolVersions` lists each tool this machine has at another version than a
 * replayed job's CI sets up, with both versions. `withheld` names the
 * variables a replayed job ran with empty where its CI fills them from a
 * secret (`Inventory.withheldOf`): the baseline ran without the remote
 * build cache they open.
 *
 * `fastNotMeasured` says why fast mode has no numbers, when it was asked for
 * and the model it needs stopped answering during the replay. Every commit
 * then still has its baseline and normal-mode results, and no commit, total
 * or mismatch holds a fast-mode number: part of a measurement is not one.
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
  speedupCommits: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  mismatches: Schema.Int,
  fastWallMs: Schema.optionalKey(Schema.Finite),
  selection: Schema.optionalKey(Metrics),
  fastNotMeasured: Schema.optionalKey(Schema.NonEmptyString),
  flaky: Schema.optionalKey(Schema.Int),
  notReplayed: Schema.optionalKey(Schema.Array(NotReplayed)),
  notRead: Schema.optionalKey(Schema.Array(Unsupported)),
  notReplayedCommits: Schema.optionalKey(Schema.Array(NotReplayedCommit)),
  toolVersions: Schema.optionalKey(Schema.Array(ToolVersion)),
  withheld: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  targets: Schema.optionalKey(Schema.Array(Schema.NonEmptyString))
})

/**
 * A decoded `ReplayReport`.
 *
 * @category models
 * @since 0.1.0
 */
export type ReplayReport = typeof ReplayReport.Type
