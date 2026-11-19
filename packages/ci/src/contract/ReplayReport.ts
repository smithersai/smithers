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
import { Mode, Parts, StatusCounts, Verdict } from "./RunRecord.ts"
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
 * One step that ran in a mode that reuses results, and why it was not reused. `reason` is the
 * build's own line: the file the step read that changed (`src/a.ts changed`),
 * or what the step did that keeps any result of it from being used again
 * (`it opened a network connection (npm to 104.16.4.34 port 443)`). `kept`
 * says which: false means the step's result is never kept, so the step runs
 * at every commit.
 *
 * @category models
 * @since 0.1.0
 */
export const StepNotReused = Schema.Struct({
  step: Schema.NonEmptyString,
  reason: Schema.NonEmptyString,
  kept: Schema.Boolean
})

/**
 * A decoded `StepNotReused`.
 *
 * @category models
 * @since 0.1.0
 */
export type StepNotReused = typeof StepNotReused.Type

/**
 * One way of running one commit. `wallMs` is elapsed time; `workMs` is the
 * sum of every target's own time. `failures` names every step that failed in
 * the end, and is absent when none did. `cpuMs` is the CPU time the run's
 * steps used, every process they started included, over the run `wallMs`
 * times; it is absent when this machine's processes could not be read.
 * `notReused` names every step that ran where an earlier result of it was not
 * used, with the reason, and is absent when the build gave none: the baseline
 * reuses nothing and has none.
 *
 * @category models
 * @since 0.1.0
 */
export const RunTotals = Schema.Struct({
  ok: Schema.Boolean,
  wallMs: Schema.Finite,
  workMs: Schema.Finite,
  counts: StatusCounts,
  failures: Schema.optionalKey(Schema.Array(StepFailure)),
  cpuMs: Schema.optionalKey(Schema.Finite),
  parts: Schema.optionalKey(Parts),
  notReused: Schema.optionalKey(Schema.Array(StepNotReused))
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
 * `cause` is present when the step passed in the baseline and on the
 * commit's files in the mode, and failed in the copy made as `apply` leaves
 * the repository (`ReplayRequest.applied`). It is one line. When the step's
 * output names a file `apply` wrote, a tool of the repository read that file
 * as one of its own, and the line names the tool, the file, and what to add
 * to the tool's ignore list. Otherwise the line says the step fails once
 * those files are committed, and lists them. The mismatch still counts.
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
 * A target fast mode did not run at a commit, because the model predicted
 * the change cannot break it. `score` is the model's estimate of the chance
 * the target fails on the change, from 0 to 1, and `reason` the fact that
 * most decided it. A skip is never a pass: when the target failed in the
 * baseline, the commit lists a mismatch for it too.
 *
 * @category models
 * @since 0.1.0
 */
export const PredictedSafe = Schema.Struct({
  label: Schema.NonEmptyString,
  skipReason: Schema.Literal("predicted-safe"),
  score: Schema.optionalKey(Schema.Finite),
  reason: Schema.optionalKey(Schema.String)
})

/**
 * A decoded `PredictedSafe`.
 *
 * @category models
 * @since 0.1.0
 */
export type PredictedSafe = typeof PredictedSafe.Type

/**
 * What asking fast mode's model cost: how long the replay waited for its
 * answers, and how many questions it answered, when the part that asks keeps
 * count (`ReplayParts.asked`). Entries with equal features share one question.
 *
 * @category models
 * @since 0.1.0
 */
export const ModelUse = Schema.Struct({
  ms: Schema.Finite,
  questions: Schema.optionalKey(Schema.Int)
})

/**
 * A decoded `ModelUse`.
 *
 * @category models
 * @since 0.1.0
 */
export type ModelUse = typeof ModelUse.Type

/**
 * One replayed commit. `skipped` lists the targets fast mode did not run at
 * the commit, each with the model's score and reason. `model` is what asking
 * the model about the commit cost; its time is in `fast.wallMs`, because a
 * fast-mode run waits for the model before it starts. Both are absent when
 * fast mode did not run the commit.
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
  fast: Schema.optionalKey(RunTotals),
  skipped: Schema.optionalKey(Schema.Array(PredictedSafe)),
  model: Schema.optionalKey(ModelUse)
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
 * The run of each way before the first counted commit, at `commit`: the
 * parent of the oldest replayed commit. It starts with an empty cache and
 * fills what the way keeps from one commit to the next, as the CI run before
 * a change has. Each time is the wall time of that run in one way, and is in
 * no other time of the report. A mode whose run did not finish has no time.
 *
 * @category models
 * @since 0.1.0
 */
export const FirstRun = Schema.Struct({
  commit: Schema.NonEmptyString,
  baselineMs: Schema.Finite,
  normalMs: Schema.optionalKey(Schema.Finite),
  fastMs: Schema.optionalKey(Schema.Finite)
})

/**
 * A decoded `FirstRun`.
 *
 * @category models
 * @since 0.1.0
 */
export type FirstRun = typeof FirstRun.Type

/**
 * The whole replay. Each commit in `commits` ran its own CI, read from its
 * own tree; a commit whose CI could not be replayed is in
 * `notReplayedCommits` and in no time. `speedup` is baseline wall time
 * divided by normal-mode wall time. It and the three wall times cover only the
 * commits whose baseline passed, because a failed baseline stops early and its
 * time measures nothing; `speedupCommits` says how many that is, and when it
 * is 0 there is no speedup and `speedup` is 0. A document without it covers
 * every commit. A report where normal mode's verdict differs from the
 * baseline's at any commit covers none: it has mismatches and no speedup. A
 * mismatch with a `cause` is not such a difference: normal mode gave the
 * baseline's verdict on the commit's files, so the commits still count. `flaky` is how many verdicts were
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
 * `model` is what asking fast mode's model cost over every replayed commit
 * (`ModelUse`), whether or not the wall times cover the commit. Each
 * commit's share is in its own `model` and in its fast-mode wall time.
 *
 * `fastNotMeasured` says why fast mode has no numbers, when it was asked for
 * and the model it needs stopped answering during the replay. Every commit
 * then still has its baseline and normal-mode results, and no commit, total
 * or mismatch holds a fast-mode number: part of a measurement is not one.
 *
 * `jobs` says how many of the CI's jobs the numbers cover: those replayed, of
 * those replayed and those in `notReplayed`. `trialMs` is how long the run
 * that found the jobs that pass on this machine took, when there was one. It
 * is in no other time. `appliedMs` is how long the run of the newest commit
 * took in a copy made as `apply` leaves the repository
 * (`ReplayRequest.applied`), when there was one. It is in no other time.
 *
 * `baselineCpuMs`, `normalCpuMs` and `fastCpuMs` are the CPU time each way's
 * steps used over the commits the wall times cover. A way has the number
 * when each of those commits has one (`RunTotals.cpuMs`).
 *
 * `reruns` says how many times a failed step ran again to tell a flaky
 * failure from a broken one, in every way and in the first run, and how long
 * those runs took together. That time is in no other time. It is absent when
 * no step ran again.
 *
 * `firstRun` is present when every way ran once before the first counted
 * commit (`FirstRun`), so that commit started with the caches a CI run finds.
 * Without it the first counted commit started with an empty cache. `cold`
 * says why when that was not asked for: there was no commit before it to run.
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
  jobs: Schema.optionalKey(Schema.Struct({ replayed: Schema.Int, total: Schema.Int })),
  trialMs: Schema.optionalKey(Schema.Finite),
  appliedMs: Schema.optionalKey(Schema.Finite),
  reruns: Schema.optionalKey(Schema.Struct({ count: Schema.Int, ms: Schema.Finite })),
  firstRun: Schema.optionalKey(FirstRun),
  cold: Schema.optionalKey(Schema.NonEmptyString),
  mismatches: Schema.Int,
  fastWallMs: Schema.optionalKey(Schema.Finite),
  baselineCpuMs: Schema.optionalKey(Schema.Finite),
  normalCpuMs: Schema.optionalKey(Schema.Finite),
  fastCpuMs: Schema.optionalKey(Schema.Finite),
  selection: Schema.optionalKey(Metrics),
  model: Schema.optionalKey(ModelUse),
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
