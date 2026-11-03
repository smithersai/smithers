import { Metric } from "effect"

// Usage metrics for chat, exported over OTLP with the rest of the browser's telemetry (docs/observability.md).
// Labels carry how or why, never what anyone wrote. The outbox and the device store count their own work
// (`outbox_*`, `persistence_*`, from @smthrs/effect-tanstack-db).

const MILLISECONDS = Metric.exponentialBoundaries({ start: 50, factor: 2, count: 12 })

/** Milliseconds until local drafts and the outbox are initialized, before repository display stores start. */
export const writesReadyMs = Metric.histogram("smithers_web_chat_writes_ready_ms", {
  description: "Milliseconds until drafts and outbox are ready",
  boundaries: MILLISECONDS,
})

/** Device draft writes by stage: waiting, stored or failed. */
export const draftWrites = Metric.counter("smithers_web_draft_writes", {
  description: "Device draft writes by persistence stage",
  incremental: true,
})

/** Composer opens, by `via`: `shortcut` (⌘K or Ctrl+K) or `button`. */
export const composerOpens = Metric.counter("smithers_web_composer_opens", {
  description: "Times a person opened the chat composer",
  incremental: true,
})

/** Questions this tab asked, by `queued`: `true` when the pill showed, so the question waited in the outbox. */
export const questionsAsked = Metric.counter("smithers_web_questions", {
  description: "Questions asked",
  incremental: true,
})

/**
 * Questions that stayed unsent, by `reason`: `refused` (400), `conflict` (409), `too_large` (413) or `not_admitted`
 * (the outbox couldn't store it).
 */
export const askFailures = Metric.counter("smithers_web_ask_failures", {
  description: "Questions that stayed unsent on the device",
  incremental: true,
})

/** What a person did with an unsent question, by `action`: `edit`, `discard` or `retry`. */
export const unsentActions = Metric.counter("smithers_web_unsent_actions", {
  description: "Edits, discards and retries of unsent questions",
  incremental: true,
})

/** From asking to the first text of the answer reaching this tab, time queued included. */
export const firstAnswerText = Metric.histogram("smithers_web_answer_first_text_ms", {
  description: "Milliseconds from asking to the answer's first text on this tab",
  boundaries: MILLISECONDS,
})

/**
 * Times the connection pill showed, by `reason`: `offline` (the browser), `unreachable` (shape requests or sends
 * failing for 10 s), `refused` (Electric refused the shape), `invalid_response` (an answer it couldn't read) or
 * `engine` (this tab's engine worker failed).
 */
export const connectionDrops = Metric.counter("smithers_web_sync_failures", {
  description: "Times chat showed it was offline or its sync failed",
  incremental: true,
})

/** Times a person or the browser asked to sync and send now, by `via`: `button` (Retry) or `online`. */
export const syncRetries = Metric.counter("smithers_web_sync_retries", {
  description: "Times chat synced and sent at once instead of waiting out its backoff",
  incremental: true,
})

/** "Load earlier" presses: the window grows on the device, at once. */
export const historyLoads = Metric.counter("smithers_web_history_loads", {
  description: "Earlier pages of the conversation a person showed",
  incremental: true,
})

/** Whether the browser granted persistent storage at boot, by `granted`: `true` or `false`. */
export const storagePersisted = Metric.counter("smithers_web_storage_persisted", {
  description: "Persistent storage requests at boot, by whether the browser granted them",
  incremental: true,
})

/**
 * Copies of a message to the clipboard (`chat/copy`), by `door` (`button`, `slash`, `agent`), `which` (`message` or
 * `latest`, the latest finished answer) and `outcome` (`COPY_OUTCOMES`).
 */
export const messageCopies = Metric.counter("smithers_web_message_copies", {
  description: "Messages copied to the clipboard, by door, which message and outcome",
  incremental: true,
})

/** Questions taken back into the composer (`chat/edit`), by `door` and `outcome` (`EDIT_OUTCOMES`). */
export const questionEdits = Metric.counter("smithers_web_question_edits", {
  description: "Questions taken back into the composer before Smithers had them, by door and outcome",
  incremental: true,
})
