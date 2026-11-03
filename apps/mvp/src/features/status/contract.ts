// Agent status's contract between the browser and ChatApi (decision 0015, docs/features/agent-status.md): routes,
// limits, the needs-you wait, the waits row and the records the feature makes. Nothing here imports a library, so every side can.

/** `POST <route>/<runId>`: the run's own steps report its status. `POST <route>/<runId>/answer`: a person answers. */
export const RUNS_ROUTE = "/api/runs"

/** `GET`: Electric's `runs`, only the signed-in person's rows. */
export const RUNS_SHAPE_ROUTE = "/api/shapes/runs"

/** The Postgres table, 0009's `runs`. */
export const RUNS_TABLE = "runs"

/** The largest body either runs route reads: 16 KiB. */
export const MAX_RUN_BODY_BYTES = 16 * 1024

/** The longest question the agent may ask. */
export const MAX_PROMPT_LENGTH = 2_000

/** The most options one question offers, and the longest one. */
export const MAX_OPTIONS = 8
export const MAX_OPTION_LENGTH = 120

/** The longest answer a person may give: a question's own limit. */
export const MAX_ANSWER_LENGTH = 8_000

/**
 * How long a question stays open before `app/agent/ask` fails `timeout` and the agent answers without it. Inside
 * `chat/Expire`'s 25 minutes, so the answer the question belongs to is still streaming when it closes.
 */
export const ASK_WITHIN_MS = 10 * 60 * 1000

/** The human task `app/agent/ask` parks on: its one wait point is `WaitFor/<ASK_TASK>#1`. */
export const ASK_TASK = "agent-ask"

/**
 * One row of `core/waits` (`waitsQuery`, decision 0017), as JSON Schema: what the plugin loader checks a manifest's
 * `$item.<field>` references against. `options` is empty for an approval; `question` and `approval` say which it is.
 */
export const WAITS_ROW = {
  type: "object",
  properties: {
    runId: { type: "string" },
    version: { type: "integer" },
    execution: { type: "string" },
    kind: { type: "string", enum: ["question", "approval"] },
    prompt: { type: "string" },
    options: { type: "array", items: { type: "string" } },
    question: { type: "boolean" },
    approval: { type: "boolean" },
    createdAt: { type: "string" },
  },
  required: ["runId", "version", "execution", "kind", "prompt", "options", "question", "approval", "createdAt"],
  additionalProperties: false,
} as const

/** 0009's rule: nothing shows before 300 ms, so a question answered at once never flashes. */
export const SHOW_AFTER_MS = 300

/** How long one runs route call may take, the whole exchange included. */
export const RUNS_WITHIN = "15 seconds"

/**
 * What agent status records in the browser, by name, and the attributes they carry (docs/observability.md#agent-status):
 * the engine worker's reports, answers and deliveries, and the tab's record of each question shown. None carries a
 * question, an option or an answer. src/telemetry.ts merges them into what ChatApi's relay keeps.
 */
export const STATUS_TELEMETRY = {
  records: [
    "agent.status.report",
    "agent.status.answer",
    "agent.status.deliver",
    "agent.status.shown",
    "smithers_agent_status_reports",
    "smithers_agent_status_answers",
    "smithers_agent_status_shown",
  ],
  fields: ["runId", "status", "outcome", "delivered", "version", "surface", "errorCode", "reason", "smithers.run.id"],
} as const

/** Maximum raw JSON request bytes, shared by dispatch and the handler. */
export const MAX_CREDENTIAL_BODY_BYTES = 16 * 1024
