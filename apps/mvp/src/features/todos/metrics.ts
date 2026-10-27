import { Metric } from "effect"

/** Local admission outcomes, independent of engine startup and network delivery. */
export const admissions = Metric.counter("smithers_todo_write_admissions", { incremental: true })

// The TODOs feature's usage metrics in the browser (docs/observability.md#todos), exported over OTLP with the tab's and
// the engine worker's other records. None carries a title or a prompt.

/** Drafts a `todo/draft` step kept, by `door` and `outcome` (`kept`, `tab_gone`, `not_kept`). */
export const drafts = Metric.counter("smithers_todo_drafts", {
  description: "TODO drafts kept on the device, by door and outcome",
  incremental: true,
})

/** Changes a `todo/commit` or `todo/drop` step queued, by `op`, `door` and `outcome` (`queued`, `tab_gone`, `not_admitted`). */
export const queued = Metric.counter("smithers_todo_queued", {
  description: "Stack changes queued in the device's outbox, by op, door and outcome",
  incremental: true,
})

/** Sends of a queued change, by `op` and `outcome` (`taken`, `existing`, `retry`, `refused`). */
export const sends = Metric.counter("smithers_todo_sends", {
  description: "Stack changes sent to ChatApi, by op and outcome",
  incremental: true,
})

/** Edit and Discard on a change Not sent, and Discard on a draft, by `action`. */
export const pendingActions = Metric.counter("smithers_todo_pending_actions", {
  description: "Edit and Discard on a stack change Not sent, and Discard on a draft, by action",
  incremental: true,
})

/** Agent reads of the shared TODO state, by found, missing or refusal outcome. */
export const statusReads = Metric.counter("smithers_todo_status_reads_client", {
  description: "Shared TODO status reads from the device's durable agent, by outcome",
  incremental: true,
})
