/**
 * One wall-clock budget for model-supplied process invocations.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as StdError from "../StdError.ts"

/**
 * Finite milliseconds greater than zero and at most ten minutes.
 *
 * @since 1.0.0
 * @category schemas
 */
export const TimeoutMs = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(600_000)
)

/**
 * Refuses invalid budgets before any process is started, including when a
 * typed caller bypasses schema decoding or a host supplies the runner budget.
 *
 * @since 1.0.0
 * @category validation
 */
export const validate = (timeoutMs: number): Effect.Effect<void, StdError.StdError> =>
  Schema.is(TimeoutMs)(timeoutMs)
    ? Effect.void
    : Effect.fail(
      new StdError.StdError({
        code: "invalid_input",
        message: "Timeout must be finite milliseconds greater than zero and at most 600000"
      })
    )
