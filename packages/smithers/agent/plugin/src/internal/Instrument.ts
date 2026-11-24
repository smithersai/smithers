/**
 * Spans and counters for hook dispatch, resolution and manifest loading.
 *
 * Attributes carry admitted identifiers and counts only: a plugin name, a hook
 * name, a failure code, a refusal reason. Never a handler argument, a config
 * value or a failure's cause.
 *
 * @since 1.1.0
 */

import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"
import type { PluginError } from "../PluginError.ts"

/**
 * Hook handler runs, by hook and outcome (`success` or a `PluginError` code).
 *
 * @category metrics
 * @since 1.1.0
 */
export const hookRuns = Metric.counter("smithers_plugin_hook_runs", {
  description: "Plugin hook handler runs by hook and outcome",
  incremental: true
})

/**
 * Plugin list resolutions, by outcome (`success` or a `PluginError` code).
 *
 * @category metrics
 * @since 1.1.0
 */
export const resolutions = Metric.counter("smithers_plugin_resolutions", {
  description: "Plugin list resolutions by outcome",
  incremental: true
})

/**
 * Manifests `Load.load` settled, by outcome (`loaded` or a refusal reason).
 *
 * @category metrics
 * @since 1.1.0
 */
export const loads = Metric.counter("smithers_plugin_loads", {
  description: "Plugin manifests loaded or refused, by outcome",
  incremental: true
})

const count = (counter: typeof hookRuns, attributes: Readonly<Record<string, string>>, amount = 1) =>
  Metric.update(Metric.withAttributes(counter, attributes), amount)

/**
 * Runs `effect` in a span named `name`, records a failure's code on the span
 * as `error.code`, and counts the outcome on `counter`.
 *
 * @category combinators
 * @since 1.1.0
 */
export const observe = <A, R>(
  name: string,
  counter: typeof hookRuns,
  attributes: Readonly<Record<string, string>>,
  metricAttributes: Readonly<Record<string, string>>,
  effect: Effect.Effect<A, PluginError, R>
): Effect.Effect<A, PluginError, R> =>
  effect.pipe(
    Effect.tap(() => count(counter, { ...metricAttributes, outcome: "success" })),
    Effect.tapError((error) =>
      Effect.annotateCurrentSpan("error.code", error.code).pipe(
        Effect.andThen(count(counter, { ...metricAttributes, outcome: error.code }))
      )
    ),
    Effect.withSpan(name, { attributes })
  )

/**
 * Counts one `Load.load` outcome `amount` times.
 *
 * @category combinators
 * @since 1.1.0
 */
export const countLoads = (outcome: string, amount: number): Effect.Effect<void> => count(loads, { outcome }, amount)
