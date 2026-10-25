import { Metric } from "effect"

// What your conversations count in the browser (docs/observability.md#browser). No attribute carries an id, a
// repository, a branch's name or a search.

/** `conversation/archive` requests, by `archived` and `outcome`: `sent`, `refused` or `unsent`. */
export const archives = Metric.counter("smithers_web_conversation_archives", {
  description: "Archive and restore requests from this browser, by archived and outcome",
  incremental: true,
})

/** `conversation/new` requests, by `outcome`: `made`, the refusal's reason, or `unavailable`. */
export const news = Metric.counter("smithers_web_conversation_news", {
  description: "New conversation requests from this browser, by outcome",
  incremental: true,
})

/** Archives and restores this device took back because they couldn't land, by `reason`: the failure's tag. */
export const dropped = Metric.counter("smithers_web_conversation_archives_dropped", {
  description: "Archives and restores this device took back because they couldn't land, by reason",
  incremental: true,
})

/** Meaningful states of the personal conversation shape: first request, answer, failure and recovery. */
export const shapeTransitions = Metric.counter("smithers_conversation_shape_transitions", {
  description: "Meaningful browser conversation shape states, by phase",
  incremental: true,
})

/** Changes in the counts the conversation list projects, by archived and loaded state. */
export const listUpdates = Metric.counter("smithers_conversation_list_updates", {
  description: "Conversation list projection changes, by archived and loaded state",
  incremental: true,
})
