/**
 * Contract 1: the record of one run.
 *
 * It is the summary `smthrs ci --format json` already prints, with three
 * optional additions: rerun attempts, the reason a target was skipped, and
 * where the run happened. Every producer of run results writes this shape and
 * every consumer (replay, report, selection data, shard merge) reads it.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * How one target settled. `hit` came from the cache, `ran` executed and
 * passed, `failed` executed and failed, `skipped` never ran.
 *
 * @category models
 * @since 0.1.0
 */
export const TargetStatus = Schema.Literals(["hit", "ran", "failed", "skipped"])

/**
 * A decoded `TargetStatus`.
 *
 * @category models
 * @since 0.1.0
 */
export type TargetStatus = typeof TargetStatus.Type

/**
 * Why a `skipped` target did not run. `dependency-failed` is normal mode: a
 * dependency was red. `predicted-safe` is fast mode: the model predicted the
 * target safe to skip. A `predicted-safe` skip is never a pass and is never
 * written to a cache.
 *
 * @category models
 * @since 0.1.0
 */
export const SkipReason = Schema.Literals(["dependency-failed", "predicted-safe"])

/**
 * A decoded `SkipReason`.
 *
 * @category models
 * @since 0.1.0
 */
export type SkipReason = typeof SkipReason.Type

/**
 * One execution of a target. A failed target reruns up to the limit the
 * program sets (once, unless `--reruns` says otherwise) or until it passes;
 * each execution is one attempt, in order.
 *
 * @category models
 * @since 0.1.0
 */
export const Attempt = Schema.Struct({
  passed: Schema.Boolean,
  durationMs: Schema.Finite
})

/**
 * A decoded `Attempt`.
 *
 * @category models
 * @since 0.1.0
 */
export type Attempt = typeof Attempt.Type

/**
 * What a run spent its time on, part by part: wall time in milliseconds by
 * the part's name (`ms`), and CPU time the same way (`cpuMs`) where the
 * machine's processes can be read. Smithers build times the parts of a
 * target's run (`machine`, `putBack`, `check`, `step`, `reads`, `keep`,
 * `store`) and of the run itself (`start`, `plan`, `answer`,
 * `machinesRemoved`); a replay adds its own (`checkout`, `around`).
 *
 * @category models
 * @since 0.1.0
 */
export const Parts = Schema.Struct({
  ms: Schema.Record(Schema.String, Schema.Finite),
  cpuMs: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite))
})

/**
 * A decoded `Parts`.
 *
 * @category models
 * @since 0.1.0
 */
export type Parts = typeof Parts.Type

/**
 * One target's outcome in a run. `tests` is how many tests the target ran,
 * when its runner reports that. A failed target can say why: `error` is the
 * reason, `exitCode` what its command exited with, `command` what it ran, and
 * `fix` what a person does about it, when whoever ran the target knows.
 * A target that ran can say why no earlier result answered it: `notReused` is
 * what differed from the stored result (`src/a.ts changed`), and `notStored`
 * why this run's result is not stored either.
 *
 * @category models
 * @since 0.1.0
 */
export const TargetResult = Schema.Struct({
  label: Schema.NonEmptyString,
  status: TargetStatus,
  key: Schema.String,
  durationMs: Schema.Finite,
  target: Schema.optionalKey(Schema.String),
  blockedBy: Schema.optionalKey(Schema.String),
  skipReason: Schema.optionalKey(SkipReason),
  attempts: Schema.optionalKey(Schema.Array(Attempt)),
  error: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Int),
  command: Schema.optionalKey(Schema.String),
  fix: Schema.optionalKey(Schema.String),
  failureDigest: Schema.optionalKey(Schema.String),
  tests: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  parts: Schema.optionalKey(Parts),
  notReused: Schema.optionalKey(Schema.String),
  notStored: Schema.optionalKey(Schema.String)
})

/**
 * A decoded `TargetResult`.
 *
 * @category models
 * @since 0.1.0
 */
export type TargetResult = typeof TargetResult.Type

/**
 * Result counts by status.
 *
 * @category models
 * @since 0.1.0
 */
export const StatusCounts = Schema.Struct({
  hit: Schema.Int,
  ran: Schema.Int,
  failed: Schema.Int,
  skipped: Schema.Int
})

/**
 * A decoded `StatusCounts`.
 *
 * @category models
 * @since 0.1.0
 */
export type StatusCounts = typeof StatusCounts.Type

/**
 * Which selection a run used. `normal` runs every affected target; `fast`
 * also skips targets the model predicted safe.
 *
 * @category models
 * @since 0.1.0
 */
export const Mode = Schema.Literals(["normal", "fast"])

/**
 * A decoded `Mode`.
 *
 * @category models
 * @since 0.1.0
 */
export type Mode = typeof Mode.Type

/**
 * One run: every selected target's outcome in plan order, plus the verdict
 * `ok`, false when any target failed.
 *
 * @category models
 * @since 0.1.0
 */
export const RunRecord = Schema.Struct({
  ok: Schema.Boolean,
  counts: StatusCounts,
  results: Schema.Array(TargetResult),
  version: Schema.optionalKey(Schema.Int),
  verb: Schema.optionalKey(Schema.String),
  pattern: Schema.optionalKey(Schema.String),
  jobs: Schema.optionalKey(Schema.Int),
  durationMs: Schema.optionalKey(Schema.Finite),
  commit: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(Mode),
  cache: Schema.optionalKey(Schema.Boolean),
  machine: Schema.optionalKey(Schema.String),
  parts: Schema.optionalKey(Parts),
  shard: Schema.optionalKey(Schema.Struct({ index: Schema.Int, count: Schema.Int }))
})

/**
 * A decoded `RunRecord`.
 *
 * @category models
 * @since 0.1.0
 */
export type RunRecord = typeof RunRecord.Type

/**
 * What a target's attempts say about it, as the Facebook paper labels them:
 * `pass` when the first attempt passed, `fail` when every attempt failed, and
 * `flaky` when attempts disagree. A target with no recorded attempts is read
 * by its status.
 *
 * @category models
 * @since 0.1.0
 */
export const Verdict = Schema.Literals(["pass", "fail", "flaky", "skipped"])

/**
 * A decoded `Verdict`.
 *
 * @category models
 * @since 0.1.0
 */
export type Verdict = typeof Verdict.Type

/**
 * The verdict of one target result.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const verdictOf = (result: TargetResult): Verdict => {
  if (result.status === "skipped") return "skipped"
  const attempts = result.attempts ?? []
  if (attempts.length === 0) return result.status === "failed" ? "fail" : "pass"
  const passes = attempts.filter((attempt) => attempt.passed).length
  if (passes === attempts.length) return "pass"
  return passes === 0 ? "fail" : "flaky"
}

/**
 * One verdict for several: `fail` if any failed, else `flaky` if any was
 * flaky, else `pass` if any passed, else `skipped`. It is how the verdicts
 * of the targets a step was split into compare with the step's own.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const combine = (verdicts: ReadonlyArray<Verdict>): Verdict => {
  for (const verdict of ["fail", "flaky", "pass"] as const) if (verdicts.includes(verdict)) return verdict
  return "skipped"
}
