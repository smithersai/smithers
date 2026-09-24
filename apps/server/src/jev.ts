import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { ServerConfig } from "./Config"
import { discardBody, fetchWithDeadline, readJsonOrUndefined } from "./Http"
import type { Transport } from "./Http"

/*
 * Jev, TypeSafe AI's decision model, reached through the Vercel AI Gateway:
 * one POST carries the state to read and a map of typed questions about it,
 * and every answer comes back typed. Jev writes no text, so it can never name
 * an option the question did not offer, and the questions in one request are
 * answered in parallel, so a second question costs no latency. The gateway is
 * the route so the deployment holds one Vercel key and one Vercel bill, and so
 * every call can ask for zero data retention.
 *
 * Vercel documents the evaluation modality as reachable through the AI SDK
 * only. The SDK's gateway provider is open source and speaks plain HTTP, and
 * the request below is that provider's own wire protocol, copied from
 * `packages/gateway/src/gateway-provider.ts` (the base URL and the
 * `ai-gateway-protocol-version` and `ai-gateway-auth-method` headers) and
 * `packages/gateway/src/gateway-evaluation-model.ts` (the `/evaluation-model`
 * path, the `ai-evaluation-model-specification-version` and `ai-model-id`
 * headers, and the request and response bodies). Vercel may change that
 * protocol without notice. A refused request surfaces here as an `http`
 * failure and a changed response body as `empty`, and every caller reports
 * both as Jev's typed failure: nothing is asked in Jev's place.
 *
 * The client is built exactly like `cerebrasChat` in recommend.ts: one
 * deadline over the whole call, a refused response's body cancelled here, and
 * every failure an answer with a reason rather than an Effect failure, so a
 * caller reads one value and decides what to do next. The key is the
 * deployment's (`ServerConfig`); an unset key reads as the provider being
 * unreachable rather than as an invented answer.
 */

/** The gateway's evaluation endpoint: the provider's default base URL plus its `/evaluation-model` path. */
export const JEV_EVALUATE_URL = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model"
/** The model the deployment asks, as the gateway names it. It rides in the `ai-model-id` header. */
export const JEV_DEFAULT_MODEL = "typesafe-ai/jev"
/** The gateway wire protocol this client speaks, sent as `ai-gateway-protocol-version`. */
export const JEV_PROTOCOL_VERSION = "0.0.1"
/** The evaluation modality's specification version, sent as `ai-evaluation-model-specification-version`. */
export const JEV_SPECIFICATION_VERSION = "4"

/**
 * One question. `boolean` is yes/no, `choice` picks one of a named set of
 * options, `score` rates along an ordered rubric of at least two levels.
 */
export type JevQuestion =
  | { readonly type: "boolean"; readonly instructions: string; readonly criteria?: { readonly true: string; readonly false: string } }
  | { readonly type: "choice"; readonly instructions: string; readonly criteria: Readonly<Record<string, string | null>> }
  | { readonly type: "score"; readonly instructions: string; readonly criteria: ReadonlyArray<string> }

/**
 * One answer, in the shape its question's type asks for. A choice or score
 * answer carries `probabilities` only when the gateway sends them, so a
 * caller reads the chosen option or the score first.
 */
export type JevAnswerValue =
  | { readonly type: "boolean"; readonly probability: number }
  | { readonly type: "choice"; readonly choice: string; readonly probabilities?: Readonly<Record<string, number>> }
  | { readonly type: "score"; readonly score: number; readonly probabilities?: Readonly<Record<string, number>> }

/** One evaluation: the model to ask, the state to read, and the questions to answer about it. */
export interface JevRequest {
  readonly model: string
  readonly state: unknown
  readonly questions: Readonly<Record<string, JevQuestion>>
}

/**
 * What one evaluation answered. `http` carries the gateway's status so a
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
    if (config.aiGatewayApiKey === undefined) {
      return { ok: false, reason: "unreachable", message: "AI_GATEWAY_API_KEY is unset." } as const
    }
    const response = yield* fetchWithDeadline(JEV_SEAM, JEV_EVALUATE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${Redacted.value(config.aiGatewayApiKey)}`,
        "ai-gateway-protocol-version": JEV_PROTOCOL_VERSION,
        "ai-gateway-auth-method": "api-key",
        "ai-evaluation-model-specification-version": JEV_SPECIFICATION_VERSION,
        "ai-model-id": request.model,
        "content-type": "application/json"
      },
      // A redirect is never followed: the key goes to the gateway's origin and nowhere a Location names. A 3xx reads as `http`.
      redirect: "manual",
      // Zero data retention is asked for per call, so no state this route
      // sends is kept by the gateway or the provider behind it.
      body: JSON.stringify({
        state: request.state,
        questions: request.questions,
        providerOptions: { gateway: { zeroDataRetention: true } }
      })
    }, timeoutMs)
    if (!response.ok) {
      yield* discardBody(response)
      return { ok: false, reason: "http", status: response.status } as const
    }
    const answer = (yield* readJsonOrUndefined(response)) as { readonly answers?: unknown } | undefined
    const answers = answer?.answers
    if (typeof answers !== "object" || answers === null || Array.isArray(answers)) return { ok: false, reason: "empty" } as const
    // The response names no model, so the answer is the model the request asked.
    return { ok: true, answers: answers as Record<string, JevAnswerValue>, model: request.model } as const
  }).pipe(
    Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed<JevAnswer>({ ok: false, reason: "timeout" }) }),
    Effect.catchTag("UpstreamTimeout", () => Effect.succeed<JevAnswer>({ ok: false, reason: "timeout" })),
    Effect.catchTag("UpstreamUnreachable", (failure) =>
      Effect.succeed<JevAnswer>({ ok: false, reason: "unreachable", message: failure.message }))
  )
