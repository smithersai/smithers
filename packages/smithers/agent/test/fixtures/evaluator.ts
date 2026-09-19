/**
 * The Jev these cases run against.
 *
 * The harness's completion brake never falls back: a claim nothing could
 * judge fails the run as `completion_unjudged`, so `Agent.run` requires an
 * `Evaluator` and a composition that binds none does not compile. Almost
 * every case here is about something else and expects its completion to
 * stand, so it binds {@link confident}. A case about the brake binds
 * `Evaluator.layerUnavailable()` or scripts its own probabilities.
 *
 * @since 1.0.0-rc.0
 */
import * as Evaluator from "@smthrs/model/Evaluator"
import type * as Layer from "effect/Layer"

/**
 * A Jev that reads every claim as done, modest, and reporting nothing the
 * record does not record, so the sixth brake lets the completion stand.
 *
 * All three of the classifier's questions are answered. An answer the
 * classifier's questions do not all cover is an `invalid_answer` at the
 * transport, which reaches a case as `completion_unjudged` and reads like a
 * defect in whatever that case was actually about.
 *
 * @category fixtures
 * @since 1.0.0-rc.0
 */
export const confident: Layer.Layer<Evaluator.Evaluator> = Evaluator.layerScripted(() => ({
  complete: { probability: 0.99 },
  overclaims: { probability: 0.01 },
  invented: { probability: 0.01 }
}))
