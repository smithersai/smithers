import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { ServerConfig } from "./Config"
import { discardBody, fetchWithDeadline, readJsonOrUndefined } from "./Http"
import type { Transport } from "./Http"

/*
 * Jev, TypeSafe's decision model: one POST carries the state to read and a map
 * of typed questions about it, and every answer comes back typed. Jev writes
 * no text, so it can never name an option the question did not offer, and the
 * questions in one request are answered in parallel, so a second question
 * costs no latency.
 *
 * The client is built exactly like `cerebrasChat` in recommend.ts: one
 * deadline over the whole call, a refused response's body cancelled here, and
 * every failure an answer with a reason rather than an Effect failure, so a
 * caller reads one value and decides what to do next. The key is the
 * deployment's (`ServerConfig`); an unset key reads as the provider being
 * unreachable rather than as an invented answer.
 */

export const JEV_EVALUATE_URL = "https://api.typesafe.ai/v1/systemone"
/** The model the deployment asks. `jev-latest` tracks TypeSafe's current Jev. */
export const JEV_DEFAULT_MODEL = "jev-latest"

/**
 * One question. `noul` is yes/no, `choice` picks one of at most 255 named
 * options, `score` rates along an ordered rubric of at least two levels.
 */
export type JevQuestion =
  | { readonly type: "noul"; readonly instructions: string; readonly criteria?: { readonly true: string; readonly false: string } }
  | { readonly type: "choice"; readonly instructions: string; readonly criteria: Readonly<Record<string, string | null>> }
  | { readonly type: "score"; readonly instructions: string; readonly criteria: ReadonlyArray<string> }

/** One answer, in the shape its question's type asks for. */
export type JevAnswerValue =
  | { readonly type: "noul"; readonly noul: number }
  | {
    readonly type: "choice"
    readonly choice: string
    readonly probabilities: Readonly<Record<string, number>>
    readonly confidence: number
  }
  | { readonly type: "score"; readonly score: number; readonly confidence: number }

/** One evaluation: the state to read, and the questions to answer about it. */
export interface JevRequest {
  readonly model: string
  readonly state: unknown
  readonly questions: Readonly<Record<string, JevQuestion>>
}

/**
 * What one evaluation answered. `http` carries the provider's status so a
 * caller can tell a bad key (401) from a rate limit (429) or an overloaded
 * service (529); `empty` is a 200 that carried no answers; `timeout` is this
 * call's own deadline.
 */
export type JevAnswer =
  | { readonly ok: true; readonly answers: Readonly<Record<string, JevAnswerValue>>; readonly model: string }
  | { readonly ok: false; readonly reason: "http"; readonly status: number }
  | { readonly ok: false; readonly reason: "empty" }
  | { readonly ok: false; readonly reason: "timeout" }
  | { readonly ok: false; readonly reason: "unreachable"; readonly message: string }

const JEV_SEAM = "jev"

/** One Jev evaluation under a deadline. The deadline covers the whole call, headers and body. */
export const jevEvaluate = (
  request: JevRequest,
  timeoutMs: number
): Effect.Effect<JevAnswer, never, Transport | ServerConfig> =>
  Effect.gen(function*() {
    const config = yield* ServerConfig
    if (config.typesafeApiKey === undefined) {
      return { ok: false, reason: "unreachable", message: "TYPESAFE_API_KEY is unset." } as const
    }
    const response = yield* fetchWithDeadline(JEV_SEAM, JEV_EVALUATE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${Redacted.value(config.typesafeApiKey)}`, "content-type": "application/json" },
      body: JSON.stringify({ model: request.model, state: request.state, questions: request.questions })
    }, timeoutMs)
    if (!response.ok) {
      yield* discardBody(response)
      return { ok: false, reason: "http", status: response.status } as const
    }
    const answer = (yield* readJsonOrUndefined(response)) as
      | { readonly model?: unknown; readonly answers?: unknown }
      | undefined
    const answers = answer?.answers
    if (typeof answers !== "object" || answers === null || Array.isArray(answers)) return { ok: false, reason: "empty" } as const
    return {
      ok: true,
      answers: answers as Record<string, JevAnswerValue>,
      model: typeof answer?.model === "string" ? answer.model : request.model
    } as const
  }).pipe(
    Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed<JevAnswer>({ ok: false, reason: "timeout" }) }),
    Effect.catchTag("UpstreamTimeout", () => Effect.succeed<JevAnswer>({ ok: false, reason: "timeout" })),
    Effect.catchTag("UpstreamUnreachable", (failure) =>
      Effect.succeed<JevAnswer>({ ok: false, reason: "unreachable", message: failure.message }))
  )
