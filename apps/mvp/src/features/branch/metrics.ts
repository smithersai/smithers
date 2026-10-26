import { Metric } from "effect"

// What the branch workspace counts in the browser (docs/observability.md#browser). No attribute carries an id or a
// branch's name.

/** `branch/track` requests, by `outcome`: `tracked`, the refusal's reason, or `unavailable`. */
export const tracks = Metric.counter("smithers_web_branch_tracks", {
  description: "Branch track requests from this browser, by outcome",
  incremental: true,
})

/**
 * Branch pages by `outcome`: `reopened` after the connection recovers, or `abandoned` when navigation is aborted
 * while opening or waiting for recovery.
 */
export const reopens = Metric.counter("smithers_web_branch_reopens", {
  description: "Branch pages opened offline, once the browser is back online, by outcome",
  incremental: true,
})

/** Branch pages opened, by `outcome`: `ready`, `missing`, `sign_in`, `forbidden`, `failed` or `offline`. */
export const opens = Metric.counter("smithers_web_branch_opens", {
  description: "Branch pages opened in this browser, by outcome",
  incremental: true,
})

/** Publish presses on a branch page, by `outcome`: `sent`, the refusal's reason, or `unavailable`. */
export const publishes = Metric.counter("smithers_web_branch_publishes", {
  description: "Publish presses on a branch page, by outcome",
  incremental: true,
})

/** Update branch presses on a branch page, by `outcome`: `sent`, the refusal's reason, or `unavailable`. */
export const updates = Metric.counter("smithers_web_branch_updates", {
  description: "Update branch presses on a branch page, by outcome",
  incremental: true,
})

/** Resync presses on a branch page, by `outcome`: `sent`, the refusal's reason, or `unavailable`. */
export const resyncs = Metric.counter("smithers_web_branch_resyncs", {
  description: "Resync presses on a branch page, by outcome",
  incremental: true,
})
