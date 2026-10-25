import { Effect, Metric } from "effect"
import type { Spend } from "./Repos.ts"

// The repository feature's server metrics, listed with their log lines in docs/observability.md#repositories. Labels
// carry outcomes, statuses and reasons, never a repository's files, commit messages or Code Storage's text.

/** `POST /api/repos` requests, by `outcome`: `requested` (a new attempt), `existing`, or the refusal's code. */
export const cloneRequests = Metric.counter("repo_clone_requests", {
  description: "POST /api/repos requests, by outcome",
  incremental: true,
})

/**
 * `POST /api/repos/launch` requests, by `outcome`: `launched`, `settled` (an attempt the row no longer holds, or one
 * that settled), `conflict` (a start that collided with another payload), or the refusal's code.
 */
export const cloneLaunches = Metric.counter("repo_clone_launches", {
  description: "POST /api/repos/launch requests, by outcome",
  incremental: true,
})

/** `GET /api/shapes/repositories` requests, by HTTP `status` and `live`. */
export const shapes = Metric.counter("repo_shape_requests", {
  description: "GET /api/shapes/repositories requests, by status and live",
  incremental: true,
})

/** Reads RepoApi answered, by `kind` (`tree`, `blob`, `raw`, `refs` or `about`) and HTTP `status`. */
export const reads = Metric.counter("repo_reads", {
  description: "Repository tree and file reads, by kind and status",
  incremental: true,
})

/**
 * About answers, by `cache`: `hit` (fresh from the store), `miss` (read from GitHub now), `stale` (the last good answer),
 * `refusal` (GitHub's kept refusal) or `wait` (another data center's first read in flight).
 */
export const aboutAnswers = Metric.counter("repo_about_answers", {
  description: "About answers, by where they came from",
  incremental: true,
})

/**
 * Reads of GitHub for a repository's About, by `via` (`app`, `deployment` or `anonymous`) and `outcome` (`answered`,
 * `partial`, `not_found`, `rate_limited` or `github_unavailable`).
 */
export const aboutReads = Metric.counter("repo_about_reads", {
  description: "Reads of GitHub for a repository's About, by token and outcome",
  incremental: true,
})

/** The least `x-ratelimit-remaining` GitHub answered the latest About read with, by `via`. */
export const aboutRateRemaining = Metric.gauge("repo_about_rate_remaining", {
  description: "GitHub's rate limit left after the latest About read, by token",
})

/** Bytes RepoApi returned for tree and file reads, from the cache or Code Storage. */
export const readBytes = Metric.counter("repo_read_bytes_total", {
  description: "Bytes of repository trees and files returned",
  incremental: true,
})

/** Clones that settled, by `outcome`: `ready`, `failed` or `capacity`, and `reason` (the failure or budget, or `none`). */
export const clones = Metric.counter("repo_clones", {
  description: "Clones that settled, by outcome and reason",
  incremental: true,
})

/** Clones a budget refused, by `reason`. */
export const capacity = Metric.counter("repo_capacity", {
  description: "Clones a Code Storage budget refused, by reason",
  incremental: true,
})

/** Bytes the cloning and ready repositories hold in Code Storage, as of the last metered write. */
export const storedBytes = Metric.gauge("repo_stored_bytes", {
  description: "Bytes the cloning and ready repositories hold in Code Storage",
})

/** This month's estimated Code Storage spend in US dollars, as of the last metered write. */
export const spendEstimate = Metric.gauge("repo_spend_estimate_usd", {
  description: "This month's estimated Code Storage spend, in US dollars",
})

/** Spend alerts raised, by `pct`: the threshold of `REPO_BUDGET_USD` crossed, once a month each. */
export const spendAlerts = Metric.counter("repo_spend_alerts", {
  description: "Code Storage spend alerts, by threshold percent",
  incremental: true,
})

/**
 * Records a metered write's spend: both gauges, and, when it crossed a threshold for the first time this month, one
 * `repo.spend.alert` error line and a count on `repo_spend_alerts`. Delivering the alert to Will is the token-spend
 * alert's channel (docs/todo.md), which reads this line.
 */
export const recordSpend = (spend: Spend) =>
  Effect.gen(function* () {
    yield* Metric.update(storedBytes, spend.storedBytes)
    yield* Metric.update(spendEstimate, Math.round(spend.estimateUsd * 100) / 100)
    if (spend.alert === null) return
    yield* Metric.update(Metric.withAttributes(spendAlerts, { pct: String(spend.alert) }), 1)
    yield* Effect.logError("repo.spend.alert").pipe(
      Effect.annotateLogs({ pct: spend.alert, estimateUsd: Math.round(spend.estimateUsd * 100) / 100 }),
    )
  })
