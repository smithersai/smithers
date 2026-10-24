import { Effect, Metric } from "effect"

// The records of a person's own model in the browser (docs/observability.md#your-model): ops, outcomes, ChatApi's
// refusal codes, a failed test's model error code, and HTTP statuses. Never a key, a URL or a model id.

/**
 * Writes and tests from this tab, by `op` (`put`, `delete`, `test`) and `outcome`. A save sent from the tab: `started`
 * (ChatApi took it and its flow started), `refused`, `unknown` (no whole answer), then `landed` once the row shows it,
 * or `late` past the deadline. A remove's or a test's request, sent by its flow's step: `sent`, `refused` or `unsent`
 * (tried again); a remove then `landed` or `late` too; a test that went through, `ok` or `failed`.
 */
export const writes = Metric.counter("smithers_web_personal_model_writes", {
  description: "Your-model saves, removes and tests this tab sent, by op and outcome",
  incremental: true,
})

export type Op = "put" | "delete" | "test"

export type Outcome = "started" | "refused" | "unknown" | "landed" | "late" | "sent" | "unsent" | "ok" | "failed"

/** The fields a record may carry beside its op and outcome. */
export interface Fields {
  readonly code?: string
  readonly status?: number
}

const quiet: ReadonlyArray<Outcome> = ["started", "landed", "sent", "ok"]

/** Each op's log line and span: the same name. */
export const RECORD: Record<Op, string> = {
  put: "personal_model.put",
  delete: "personal_model.delete",
  test: "personal_model.test",
}

/** One record's log line, named for its op, and its count. */
export const record = (op: Op, outcome: Outcome, fields: Fields = {}) =>
  Effect.andThen(
    Metric.update(Metric.withAttributes(writes, { op, outcome }), 1),
    Effect.logWithLevel(quiet.includes(outcome) ? "Info" : "Warn")(RECORD[op]).pipe(
      Effect.annotateLogs({ op, outcome, ...fields }),
    ),
  )
