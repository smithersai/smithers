import { Cause, Effect, type Layer, Metric, Option } from "effect"
import type { SqlClient } from "effect/sql"
import { KEY_REFUSALS } from "../../src/features/personal-model/contract.ts"
import { codeOf } from "../ErrorCode.ts"
import * as Store from "./Store.ts"

// What the calls a person's own model answers spend (decision 0096, docs/features/personal-model.md#usage): one ledger
// row per call, settled when it ends, and the person's row marked when their key was refused or ran out, cleared when
// it answers again. None of it touches the deployment's budget, its ledger or its spend alerts: the person's key pays.
// Records carry roles, outcomes, codes, statuses and token counts; never the person's key, base URL or prompt.

/** Calls a person's own model answered, by `role` and `outcome` (`success`, `failed`, `interrupted`). */
export const calls = Metric.counter("smithers_personal_model_calls", {
  description: "Model calls a person's own model answered, by role and outcome",
  incremental: true,
})

/** Tokens a person's own model reported, by `role` and `type` (`input`, `output`). */
export const tokens = Metric.counter("smithers_personal_model_tokens", {
  description: "Tokens a person's own model reported, by role and type",
  incremental: true,
})

/** Ledger writes that failed, by `op` (`begin`, `end`). */
export const errors = Metric.counter("smithers_personal_model_usage_errors", {
  description: "Personal model ledger writes Postgres refused, by op",
  incremental: true,
})

/** One call a person's own model answers: whose, for what, the provider's model id and its host. */
export interface Call extends Store.Call {
  readonly host: string
}

/** How a call ended: its outcome, what the model reported, and the failure's code and the provider's status. */
export interface End {
  readonly outcome: "success" | "failed" | "interrupted"
  readonly usage: { readonly inputTokens?: number | undefined; readonly outputTokens?: number | undefined }
  readonly errorCode?: string | undefined
  readonly httpStatus?: number | undefined
}

/** Whether a call's failure was the provider refusing the person's key, or saying it ran out. */
export const refusedKey = (end: End): boolean =>
  end.outcome === "failed" && end.httpStatus !== undefined && KEY_REFUSALS.includes(end.httpStatus)

/** Writes the call's ledger row before the model runs. */
export const begin = (call: Call) => Store.begin(call)

/**
 * Settles the call's ledger row and marks the person's row: the provider's status when it refused their key or said
 * it ran out, cleared when the call succeeded, unchanged otherwise. One count, and a `personal_model.call` log line for
 * a failure; a write Postgres refuses is logged and counted, never raised into the answer.
 */
export const end = <E, R>(
  call: Call,
  ended: End,
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
): Effect.Effect<void, never, R> => {
  const { inputTokens, outputTokens } = ended.usage
  const failure = {
    ...(ended.errorCode === undefined ? {} : { errorCode: ended.errorCode }),
    ...(ended.httpStatus === undefined ? {} : { httpStatus: ended.httpStatus }),
  }
  return Effect.gen(function* () {
    const settled = yield* Store.settle({
      invocationId: call.invocationId,
      outcome: ended.outcome,
      inputTokens,
      outputTokens,
      errorCode: ended.errorCode,
      httpStatus: ended.httpStatus,
    })
    // Settled already: whatever ended it first recorded it.
    if (Option.isNone(settled)) return
    if (refusedKey(ended)) yield* Store.mark(call.personId, ended.httpStatus)
    else if (ended.outcome === "success") yield* Store.mark(call.personId, undefined)
    yield* Metric.update(Metric.withAttributes(calls, { role: call.role, outcome: ended.outcome }), 1)
    if (inputTokens !== undefined) {
      yield* Metric.update(Metric.withAttributes(tokens, { role: call.role, type: "input" }), inputTokens)
    }
    if (outputTokens !== undefined) {
      yield* Metric.update(Metric.withAttributes(tokens, { role: call.role, type: "output" }), outputTokens)
    }
    if (ended.outcome !== "success") {
      yield* Effect.logWithLevel(refusedKey(ended) ? "Warn" : "Info")("personal_model.call").pipe(
        Effect.annotateLogs({ role: call.role, invocationId: call.invocationId, outcome: ended.outcome, ...failure }),
      )
    }
  }).pipe(
    Effect.provide(database),
    Effect.catchCause((cause) =>
      Effect.andThen(
        Metric.update(Metric.withAttributes(errors, { op: "end" }), 1),
        Effect.logError("personal_model.usage").pipe(
          Effect.annotateLogs({ invocationId: call.invocationId, errorCode: codeOf(Cause.squash(cause)) }),
        ),
      )
    ),
  )
}
