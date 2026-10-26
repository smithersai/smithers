import { Metric } from "effect"

// What the git loop counts (decision 0012 §8, docs/observability.md#github). No attribute carries a title, a body, a
// login or a token: only operations, outcomes, kinds and codes.

/** Webhook deliveries, by `event` and `outcome` (`applied`, `duplicate`, `ignored`, `refused`, `too_large`, ...). */
export const webhooks = Metric.counter("github_webhooks", {
  description: "GitHub webhook deliveries, by event and outcome",
  incremental: true,
})

/** Milliseconds from a delivery's arrival to its subject's row being written. */
export const deliveryLag = Metric.histogram("github_delivery_lag_ms", {
  description: "Milliseconds from a webhook delivery to its subject's row",
  boundaries: Metric.exponentialBoundaries({ start: 50, factor: 2, count: 12 }),
})

/** Write requests at the route, by `op` and `outcome` (`started`, `existing`, or the refusal's code). */
export const writeRequests = Metric.counter("github_write_requests", {
  description: "Git write requests at the writes route, by operation and outcome",
  incremental: true,
})

/** Writes settled by their flow, by `op`, `outcome` (`done`, `refused`, `failed`) and `token` (`user`, `app`). */
export const writes = Metric.counter("github_writes", {
  description: "Git writes settled, by operation, outcome and token kind",
  incremental: true,
})

/** Milliseconds a write took, from the route to its settling, by `op`. */
export const writeMs = Metric.histogram("github_write_ms", {
  description: "Milliseconds from a write's admission to its settling",
  boundaries: Metric.exponentialBoundaries({ start: 100, factor: 2, count: 14 }),
})

/** Writes whose answer was lost, by `op`: the next attempt looked for its marker. */
export const writeUnknown = Metric.counter("github_write_unknown", {
  description: "Git writes whose outcome was unknown, by operation",
  incremental: true,
})

/** Webhook subjects re-read, by `outcome` (`applied`, `tombstoned`, `not_installed`, `unavailable`). */
export const applies = Metric.counter("github_applies", {
  description: "Subjects github/Apply re-read, by outcome",
  incremental: true,
})

/** Rows a reconcile changed that a webhook should have delivered, by `kind` (`issue`, `comment`). */
export const reconcileChanged = Metric.counter("github_reconcile_changed", {
  description: "Rows a reconcile changed after the first sync, by kind",
  incremental: true,
})

/** Reconcile walks, by `outcome` (`complete`, `partial`, `not_installed`, `refused`, `superseded`). */
export const reconciles = Metric.counter("github_reconciles", {
  description: "Reconcile walks, by outcome",
  incremental: true,
})

/** Seconds since a repository's sync last finished, at each read of its issues. */
export const syncAge = Metric.gauge("github_sync_age_seconds", {
  description: "Seconds since the repository's issues last synced",
})

/**
 * Tokens asked for, by `kind` and `outcome`: a step's (`user`, `app`; worker/github/Tokens.ts), and the deployment's
 * read token (`read`, outcome `minted` or `anonymous`; worker/github/ReadToken.ts).
 */
export const tokenMints = Metric.counter("github_token_mints", {
  description: "GitHub tokens asked for, by kind and outcome",
  incremental: true,
})

/** Shape requests to the git tables, by `table`, then `status` and `live` (`@smthrs/effect-electric` adds those). */
export const shapes = Metric.counter("github_shape_requests", {
  description: "Electric shape requests for the git tables, by table, status and live",
  incremental: true,
})

/** Triage runs, by `outcome` (`skipped`, `abstained`, `dropped`, `labeled`, `commented`, `comment_failed`, `unavailable`). */
export const triageRuns = Metric.counter("triage_runs", {
  description: "Triage runs, by outcome",
  incremental: true,
})

/** Triage decisions, by `decision` (`accept`, `reject`, `abstain`) and `via` (`flow`, `person`). */
export const triageDecisions = Metric.counter("triage_decisions", {
  description: "Triage decisions, by decision and who decided",
  incremental: true,
})

/** Flow decisions that wrote nothing, by `reason` (`pinned`, `relabeled`, `edited`, `paused`, ...). */
export const triageDropped = Metric.counter("triage_dropped", {
  description: "Triage decisions dropped before writing, by reason",
  incremental: true,
})

/** A person's overrides, by the state `from` and the decision `to`: overriding the flow is the flow's error rate. */
export const triageOverrides = Metric.counter("triage_overrides", {
  description: "A person's triage overrides, by the state before and the decision",
  incremental: true,
})

/** Model tokens the triage flow spent. */
export const triageTokens = Metric.counter("triage_tokens", {
  description: "Model tokens triage decisions spent",
  incremental: true,
})

/** Reconcile starts a stale read of the issues awaited, by `outcome`: `started`, `timed_out` or `not_started`. */
export const reconcileStarts = Metric.counter("github_reconcile_starts", {
  description: "github/Reconcile starts a stale issues read awaited, by outcome",
  incremental: true,
})

/** Live anonymous visibility checks, by a bounded outcome. */
export const visibilityReads = Metric.counter("github_visibility_reads", {
  description: "Current anonymous repository visibility checks, by outcome",
  incremental: true,
})

/** Projection failures after a confirmed successful GitHub write, by operation. */
export const projectionFailures = Metric.counter("github_projection_failures", {
  description: "Projection failures after a confirmed GitHub write, by operation",
  incremental: true,
})
