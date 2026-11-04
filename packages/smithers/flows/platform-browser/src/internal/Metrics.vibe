/**
 * The leader's metrics, in a module of their own so `BrowserRuntime` exports
 * them without loading the engine.
 *
 * @since 1.0.0
 */

import * as Metric from "effect/Metric"

/**
 * Times a worker became leader.
 *
 * @category metrics
 * @since 1.0.0
 */
export const leaderships = Metric.counter("smithers_browser_runtime_leaderships", {
  description: "Times a browser worker took the engine lock and started the engine",
  incremental: true
})

/**
 * Unfinished runs a new leader found, by `outcome`: `settled`, `parked`,
 * `unfinished` or `failed` for a run it drove, `unknown-flow` for one whose
 * flow it was not given.
 *
 * @category metrics
 * @since 1.0.0
 */
export const wakes = Metric.counter("smithers_browser_runtime_wakes", {
  description: "Unfinished runs a new browser leader drove, by outcome",
  incremental: true
})

/**
 * Preparations of the app's shared database a new leader ran before serving
 * it, by `outcome`: `prepared`, `failed`, or `skipped` when the engine serves
 * no app database.
 *
 * @category metrics
 * @since 1.0.0
 */
export const preparations = Metric.counter("smithers_browser_runtime_preparations", {
  description: "Preparations of the app's shared database a new browser leader ran before serving it, by outcome",
  incremental: true
})

/**
 * Follower requests the leader handled, by `request` and `outcome`
 * (`replied` or `refused`).
 *
 * @category metrics
 * @since 1.0.0
 */
export const requests = Metric.counter("smithers_browser_runtime_requests", {
  description: "Follower requests the browser leader handled, by request and outcome",
  incremental: true
})

/**
 * Statements the leader ran on the app's shared database, by `outcome`
 * (`executed`, `failed` or `lost`), statements of a transaction an earlier
 * leader committed with them (`committed`), statements it refused because
 * this build could not prepare the database (`fenced`), and transactions it
 * rolled back because their tab ended (`abandoned`).
 *
 * @category metrics
 * @since 1.0.0
 */
export const statements = Metric.counter("smithers_browser_runtime_statements", {
  description: "Statements the browser leader ran on the app's shared database, by outcome",
  incremental: true
})
