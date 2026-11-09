/**
 * Blocking scoring inside caller-owned durable flow steps.
 *
 * Package documentation: `packages/smithers/agent/scorers/docs/api.md`.
 *
 * @since 0.1.0
 */

import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Text from "./internal/text.ts"
import type { Result as ScorerResult } from "./Scorer.ts"
import * as Scorer from "./Scorer.ts"
import { ScorerError } from "./ScorerError.vibe"
import { maxReasonBytes, type Observation, type ObservationBase } from "./ScoreStore.ts"
import * as ScoreStore from "./ScoreStore.ts"

/**
 * One scorer execution request.
 *
 * Execute these jobs inside a caller-owned `@smthrs/flow` action. The flow
 * persists the request and re-runs interrupted work; this module never accepts
 * background jobs. Batch inputs must remain stable until execution starts.
 *
 * `identity` is the durable idempotency key: build it with {@link jobIdentity}
 * rather than by joining strings, so two different tuples cannot produce one
 * identity. It must also be
 * stable across a restart, or the retry after a crash records a second
 * observation for work that already happened.
 *
 * @category models
 * @since 0.1.0
 */
export interface Job {
  readonly identity: string
  readonly observation: Pick<ObservationBase, "targetStepKey" | "scorerKey">
  readonly score: Effect.Effect<ScorerResult, unknown>
  readonly at: number
}

/**
 * Batch execution options.
 *
 * @category models
 * @since 0.1.0
 */
export interface BatchOptions {
  readonly concurrency?: number | undefined
}

/**
 * Whether a batch job's observation reached the durable store.
 *
 * @category models
 * @since 0.1.0
 */
export type Recorded = "persisted" | "duplicate" | "failed"

/**
 * One batch result tagged with the job it came from and what the store did with it.
 *
 * The method is named `runBatchCorrelated` because `@smthrs/evals` already
 * declares that optional method on its structural `ScoreBatchRunner` in
 * `packages/smithers/agent/evals/src/Runner.ts`. Its results carry job identities, so these
 * functions let that consumer correlate by identity instead of by position
 * without a change in `@smthrs/evals`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Outcome {
  readonly identity: string
  readonly observation: Observation
  readonly recorded: Recorded
}

/**
 * Builds a {@link Job.identity} from its components.
 *
 * Each component is length-prefixed, so no choice of separator inside a
 * component can make two different tuples collide. Joining components with a
 * delimiter cannot promise that: the only consumer of this package built its
 * identity by `NUL`-joining five unconstrained strings.
 *
 * @category constructors
 * @since 0.1.0
 */
export const jobIdentity = (parts: ReadonlyArray<string>): string =>
  `v1${parts.map((part) => `:${part.length}:${part}`).join("")}`

interface Failure {
  readonly code: ScorerError["code"]
  readonly text: string
}

const failureOf = (cause: unknown): Failure => {
  try {
    const squashed = Cause.isCause(cause) ? Cause.squash(cause) : cause
    return {
      code: squashed instanceof ScorerError ? squashed.code : "inconclusive",
      text: String(squashed)
    }
  } catch {
    return { code: "inconclusive", text: "<uncoercible cause>" }
  }
}

/**
 * Converts a scorer failure into a typed inconclusive observation.
 *
 * The reason names the cause. It is the only prose field that reaches a
 * report, so a fixed sentence made a scorer that threw a `TypeError`, which is
 * a bug to fix, indistinguishable from an unreachable judge, which is an outage
 * to wait out. Three bounds keep naming it safe:
 *
 * - `code` carries the classification, so the distinction survives without
 *   parsing prose.
 * - Coercion is guarded. A cause whose `toString` or `Symbol.toPrimitive`
 *   throws used to raise synchronously inside the batch's `catchCause`
 *   handler and escape as a defect, killing the batch this function exists to
 *   keep alive.
 * - The reason is truncated to `maxReasonBytes`, because the squashed cause is
 *   an arbitrary host-formatted string that can carry a whole response body.
 *
 * @category converting
 * @since 0.1.0
 * @throws {never}
 */
export const inconclusive = (job: Job, cause: unknown): Observation => {
  const failure = failureOf(cause)
  return {
    targetStepKey: job.observation.targetStepKey,
    scorerKey: job.observation.scorerKey,
    kind: "inconclusive",
    code: failure.code,
    reason: Text.truncate(`Scorer execution was inconclusive: ${failure.text}`, maxReasonBytes),
    at: job.at
  }
}

const execute = (job: Job): Effect.Effect<Outcome, never, ScoreStore.ScoreStore> =>
  Effect.gen(function*() {
    const store = yield* ScoreStore.ScoreStore
    return yield* job.score.pipe(
      Effect.flatMap(Scorer.validate),
      Effect.map((result): ScoreStore.ScoreObservation => ({
        targetStepKey: job.observation.targetStepKey,
        scorerKey: job.observation.scorerKey,
        kind: "score",
        score: result.score,
        ...(result.reason === undefined
          ? {}
          : { reason: Text.truncate(result.reason, ScoreStore.maxReasonBytes) }),
        ...(result.meta === undefined ? {} : { meta: result.meta }),
        at: job.at
      })),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.succeed(inconclusive(job, cause))
      ),
      Effect.flatMap((observation) =>
        store.recordOnce(job.identity, observation).pipe(
          Effect.map((recorded): Recorded => recorded ? "persisted" : "duplicate"),
          Effect.catch((error) =>
            Effect.logWarning("Could not record a scorer observation", error).pipe(
              Effect.annotateLogs({
                identity: job.identity,
                targetStepKey: job.observation.targetStepKey,
                scorerKey: job.observation.scorerKey
              }),
              Effect.as<Recorded>("failed")
            )
          ),
          Effect.map((recorded): Outcome => ({ identity: job.identity, observation, recorded }))
        )
      )
    )
  })

const concurrency = (value: number | undefined): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : 1

/**
 * Scores and records a batch in the calling fiber, in input order.
 *
 * Await this effect inside a durable flow action. It never forks background
 * work. Interruption propagates so the flow can resume; recordOnce deduplicates
 * observations by job identity if a crash occurs after the insert commits.
 * Store failures remain visible in each outcome; a caller can fail its action
 * when `recorded` is `failed` so the engine applies its retry policy.
 *
 * @category execution
 * @since 0.1.0
 */
export const runBatchCorrelated = (
  jobs: ReadonlyArray<Job>,
  options?: BatchOptions | undefined
): Effect.Effect<ReadonlyArray<Outcome>, never, ScoreStore.ScoreStore> =>
  Effect.forEach(jobs, (job) =>
    execute({
      identity: job.identity,
      observation: { ...job.observation },
      score: job.score,
      at: job.at
    }), { concurrency: concurrency(options?.concurrency) })

/**
 * Scores and records a batch, returning its observations in input order.
 *
 * Use runBatchCorrelated when a durable action must fail on a store error.
 *
 * @category execution
 * @since 0.1.0
 */
export const runBatch = (
  jobs: ReadonlyArray<Job>,
  options?: BatchOptions | undefined
): Effect.Effect<ReadonlyArray<Observation>, never, ScoreStore.ScoreStore> =>
  runBatchCorrelated(jobs, options).pipe(Effect.map((outcomes) => outcomes.map((outcome) => outcome.observation)))
