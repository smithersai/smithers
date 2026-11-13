/**
 * Telemetry for an operation whose failure may quote a provider: its span
 * ends with the outcome alone, and only the failure's tag is recorded.
 *
 * @since 1.0.0-rc.17
 */

import { RetryPolicy } from "@smthrs/flow"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Metric from "effect/Metric"

/**
 * Runs `effect` in a span named `span`, then records its outcome: the success
 * value, or `failed` with the failure's tag, as the span attribute
 * `attribute`, the counter `counter`'s `outcome`, and the log line `log`,
 * which also says how long it took (`durationMs`). The span ends with the
 * outcome alone; the failure is returned outside it, so a provider's error
 * text never reaches the exported span.
 *
 * @category telemetry
 * @since 1.0.0-rc.17
 */
export const observed = <A extends string, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: {
    readonly span: string
    readonly attributes: Record<string, unknown>
    readonly attribute: string
    readonly counter: Metric.Metric<number, Metric.CounterState<number>>
    readonly log: string
  }
): Effect.Effect<A, E, R> =>
  Effect.flatMap(Clock.currentTimeMillis, (startedAt) =>
    effect.pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.gen(function*() {
          const outcome = Exit.isSuccess(exit) ? exit.value : "failed"
          const failure = Exit.isFailure(exit) ? { "error.type": RetryPolicy.failureType(exit.cause) } : {}
          const durationMs = (yield* Clock.currentTimeMillis) - startedAt
          yield* Effect.annotateCurrentSpan({ [options.attribute]: outcome, ...failure })
          yield* Metric.update(Metric.withAttributes(options.counter, { outcome }), 1)
          yield* (Exit.isFailure(exit) ? Effect.logWarning : Effect.logInfo)(options.log).pipe(
            Effect.annotateLogs({ outcome, durationMs, ...failure })
          )
        })
      ),
      Effect.withSpan(options.span, { attributes: options.attributes }),
      Effect.flatMap((exit) => exit)
    ))
