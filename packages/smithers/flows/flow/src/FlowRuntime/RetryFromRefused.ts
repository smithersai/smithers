/**
 * Failure raised when a runtime will not retry an execution from one of its
 * steps.
 *
 * @since 1.0.0
 */

import * as Schema from "effect/Schema"

/**
 * Why a retry from a step was refused.
 *
 * - `unsupported`: the runtime keeps no history to replay, so it cannot retry
 *   from a step (`FlowRuntime.retryFrom` is absent).
 * - `not_found`: no execution is recorded under the source id.
 * - `other_flow`: the source is an execution of another flow.
 * - `not_settled`: the source has not settled, so its history is still moving.
 * - `step_not_found`: the source recorded no node with this id.
 * - `step_not_run`: the node never settled with work of its own in the source:
 *   it was skipped, interrupted, or dispatched nothing.
 *
 * @category models
 * @since 1.0.0
 */
export const RetryFromRefusalCode = Schema.Literals([
  "unsupported",
  "not_found",
  "other_flow",
  "not_settled",
  "step_not_found",
  "step_not_run"
])

/**
 * The value form of {@link RetryFromRefusalCode}.
 *
 * @category models
 * @since 1.0.0
 */
export type RetryFromRefusalCode = typeof RetryFromRefusalCode.Type

/**
 * Raised when a retry from a step cannot start, before anything is written.
 *
 * A typed failure: every code describes the request, and the same request is
 * refused the same way until the source or the runtime changes. A refused
 * retry admits no execution.
 *
 * @category errors
 * @since 1.0.0
 */
export class RetryFromRefused extends Schema.TaggedError<RetryFromRefused>()(
  "@smthrs/flow/FlowRuntime/RetryFromRefused",
  {
    /** Why the retry was refused. */
    code: RetryFromRefusalCode,
    /** The source execution the retry named. */
    executionId: Schema.String,
    /** The node id the retry named. */
    step: Schema.String
  }
) {
  /** @since 1.0.0 */
  override get message(): string {
    return `Cannot retry execution "${this.executionId}" from step "${this.step}": ${this.code}`
  }
}
