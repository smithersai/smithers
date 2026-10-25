// Chat's contract between the browser and ChatApi (docs/features/chat.md#contract): the one home of every value the
// browser, ChatApi, the end-to-end tests and the unit tests share. Nothing here imports a library, so every side can.

/** ChatApi's question route: `POST`. */
export const QUESTIONS_ROUTE = "/api/questions"

/** ChatApi's Electric shape proxy for `messages`: `GET`. */
export const SHAPE_ROUTE = "/api/shapes/messages"

/** Where the browser posts its OTLP telemetry: `<route>/v1/{logs,traces,metrics}`. */
export const TELEMETRY_ROUTE = "/api/telemetry"

/** The Postgres table the shape proxy serves. */
export const MESSAGES_TABLE = "messages"

/** The longest question, in characters after trimming. */
export const MAX_QUESTION_LENGTH = 8_000

/**
 * How many messages the conversation shows at first, and how many more each "Load earlier" adds; the device has them
 * all, since the shape proxy serves the whole shape.
 */
export const PAGE_SIZE = 50

// The app's status copy (docs/decisions/0002-local-first.md §2). No other loading, saving or syncing copy exists.

/** What an answer reads when Smithers couldn't answer, beside Retry. */
export const COULDNT_ANSWER = "Couldn't answer"

/** Safe copy for a model balance or quota refusal; never provider text. */
export const MODEL_QUOTA_SPENT = "Couldn't answer. Model credit or quota is used up."

/** The connection pill while the device is offline or can't reach Smithers; ` · <n>` follows with questions queued. */
export const OFFLINE = "Offline"

/** The connection pill when Electric refused the shape, beside Retry. */
export const SYNC_FAILED = "Sync failed"

/** The connection pill when this tab's engine worker failed, so this device can't answer; beside Reload. */
export const ENGINE_FAILED = "Smithers can't run in this browser"

/** The badge on a question asked while the pill shows, until Postgres has it. */
export const QUEUED = "Queued"

/** The badge on a question the server refused, or the outbox couldn't store. */
export const NOT_SENT = "Not sent"

/** An empty conversation on a branch's page, where the wordmark would crowd its column. */
export const NO_MESSAGES = "No messages yet"

// Message controls (docs/features/chat.md#message-controls).

/** Copy's label on a message; the button says "Copied" once the text is on the clipboard. */
export const COPY = "Copy"

/** Edit's label on a question that Smithers doesn't have yet. */
export const EDIT = "Edit"

/** The label of an answer's debug info: the icon that opens the run that answered it, its flows and steps. */
export const DEBUG_INFO = "Debug info"

/** How long `chat/copy`'s and `chat/edit`'s steps wait for the tab that asked: a tab that is open answers at once. */
export const ASK_TAB_WITHIN = "5 seconds"

/** The channel `chat/copy`'s step asks the tabs of engine `name` on (src/flows/askingTab.ts). */
export const copyChannel = (name: string): string => `${name}/chat-copy`

/** The channel `chat/edit`'s step asks the tabs of engine `name` on. */
export const editChannel = (name: string): string => `${name}/chat-edit`

/**
 * How a copy ended: on the clipboard (`copied`), refused by the clipboard (`failed`), no such message or no finished
 * answer (`not_found`), or no tab answered because the one that asked is gone (`gone`).
 */
export const COPY_OUTCOMES = ["copied", "failed", "not_found", "gone"] as const
/** What the tab that asked answers a copy with: every outcome but `gone`. */
export const COPY_ANSWERS = ["copied", "failed", "not_found"] as const
export type CopyOutcome = (typeof COPY_OUTCOMES)[number]

/** Why a question can't be edited: none waiting (`not_found`), already being sent (`sent`), or the outbox failed. */
export const EDIT_REFUSALS = ["not_found", "sent", "failed"] as const

/** How an edit ended: the text back in the composer (`edited`), refused (`EDIT_REFUSALS`), or the tab gone (`gone`). */
export const EDIT_OUTCOMES = ["edited", ...EDIT_REFUSALS, "gone"] as const
/** What the tab that asked answers an edit with: every outcome but `gone`. */
export const EDIT_ANSWERS = ["edited", ...EDIT_REFUSALS] as const
export type EditOutcome = (typeof EDIT_OUTCOMES)[number]

/** The compose Electric (`docker-compose.yml`): what `ELECTRIC_URL` defaults to, and the one tests use. */
export const LOCAL_ELECTRIC_URL = "http://localhost:30001"

/**
 * What chat records in the browser (docs/observability.md#browser): its log messages, span names and metric names,
 * and the attributes they carry, the outbox's and the device store's (`@smthrs/effect-tanstack-db`) included. ChatApi's
 * relay keeps exactly what src/telemetry.ts merges from every feature; none of these fields carries what someone wrote.
 */
export const CHAT_TELEMETRY = {
  records: [
    "question asked",
    "question stored",
    "question not sent",
    "question not admitted",
    "answer not started",
    "unsent question handled",
    "chat connection changed",
    "chat retried",
    "timeline.summary.unconfigured",
    "chat load failed",
    "chat load recovered",
    "chat.load",
    "smithers_web_chat_loads",
    "chat.ask",
    "chat.ask.send",
    "chat.question.post",
    "smithers_web_questions",
    "smithers_web_ask_failures",
    "smithers_web_unsent_actions",
    "smithers_web_composer_opens",
    "smithers_web_answer_first_text_ms",
    "smithers_web_sync_failures",
    "smithers_web_sync_retries",
    "smithers_web_history_loads",
    // Message controls: the steps' records in the engine worker, and the tab's.
    "chat.copy",
    "chat.edit",
    "execute_tool chat/copy",
    "smithers_web_message_copies",
    "smithers_web_question_edits",
    "queued question taken back",
    // The composer's draft: restored from the device, and whether the shown conversation's prompt is shared.
    "chat draft restored",
    "chat draft saving",
    "chat draft stored",
    "chat draft failed",
    "chat.draft.save",
    "smithers_web_draft_writes",
    "chat prompt shared",
    // The outbox every write goes through, and the device store (@smthrs/effect-tanstack-db).
    "outbox.send",
    "outbox.withdraw",
    "outbox write withdrawn",
    "outbox write failed",
    "outbox couldn't load its writes",
    "outbox write sealed",
    "outbox lock refused",
    "outbox_attempts",
    "outbox_refused",
    "outbox_queued_ms",
    "outbox_leader_changes",
    "persistence unavailable",
    "persistence_unavailable",
    "persistence_restore_ms",
    "persisted write failed",
    "persistence_write_failures",
    "persisted sync role",
    "persistence_sync_roles",
    "collection cleanup failed",
  ],
  fields: [
    "shape",
    "surface",
    "questionId",
    "answerId",
    "question.length",
    "queued",
    "taken",
    "reason",
    "status",
    "action",
    "via",
    "name",
    "attempt",
    "outcome",
    "leader",
    "collection",
    "operation",
    "error",
    "door",
    "which",
    "executionId",
    "durationMs",
    "smithers.chat.door",
    "smithers.chat.outcome",
    "draft.length",
    "transactionId",
    "conversation",
    "stage",
    "shared",
    "stage",
    "role",
  ],
} as const
