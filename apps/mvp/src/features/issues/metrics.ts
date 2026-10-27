import { Metric } from "effect"

// Usage metrics for issue writes, exported over OTLP with the rest of the browser's telemetry
// (docs/observability.md#browser). Labels carry operations, doors and outcomes, never a title, a body or a login.

/**
 * Write steps, by `op`, `door` (`button`, `slash`, `agent`, or `unknown` when no tab answered) and `outcome`
 * (`queued`, `not_admitted`, `tab_gone`, `no_credential`).
 */
export const writes = Metric.counter("smithers_issue_writes", {
  description: "Issue write steps, by operation, door and outcome",
  incremental: true,
})

/**
 * Sends of queued writes to ChatApi's writes route, by `op` and `outcome`: `started` (202), `existing` (200),
 * `refused` (a 4xx that stays Not sent) or `retry` (sent again).
 */
export const sends = Metric.counter("smithers_issue_write_sends", {
  description: "Sends of issue writes to ChatApi, by operation and outcome",
  incremental: true,
})

/** Edit and Discard on a write that wasn't sent, by `action`. */
export const pendingActions = Metric.counter("smithers_issue_pending_actions", {
  description: "Edit and Discard on issue writes that weren't sent, by action",
  incremental: true,
})

/** Create presses durably admitted, retained for Retry, or refused by device storage; never their text. */
export const admissions = Metric.counter("smithers_issue_write_admissions", {
  description: "Issue-write local admissions by outcome", incremental: true,
})

/** Comment submissions that never obtained a queue receipt, without recording their text. */
export const submissionFailures = Metric.counter("smithers_issue_submission_failures", {
  description: "Failed comment recovery storage", incremental: true,
})
