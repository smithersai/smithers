import { Effect, Redacted } from "effect"
import {
  cutModelCredential, decodeModelAnswers, MODEL_CALL_TEXT_MAX, MODEL_TEST_DEADLINE_MS, modelCallDefault, modelStateOf, planModelBinding
} from "@smthrs/rpc/ConfiguredModel"
import type { ModelBinding, ModelCallInput, ModelCallOutput, ModelTestFailure } from "@smthrs/rpc/ConfiguredModel"
import type { ServerConfig } from "./Config"
import { discardBody, fetchWithDeadline, readBoundedJson } from "./Http"
import type { Transport } from "./Http"
import { JEV_PROTOCOL_VERSION, JEV_SPECIFICATION_VERSION } from "./jev"
import type { AccountCredentials } from "./modelVault"

type Outcome = { readonly output: ModelCallOutput } | { readonly failure: ModelTestFailure }
const invalid: Outcome = { failure: { code: "invalid", field: "protocol" } }
type Message = { readonly role: string; readonly content: string }

/** Account calls share one resolver and wire across Test, Ask and the sealed Explainer. */
export const accountModelCall = (
  binding: ModelBinding, input: ModelCallInput | undefined, account: AccountCredentials,
  messages?: ReadonlyArray<Message>
): Effect.Effect<Outcome | Response, never, Transport | ServerConfig> => Effect.gen(function* () {
  if (!account.available) return { failure: { code: account.configured ? "credential_missing" : "credential_unknown", credential: binding.credential } } as Outcome
  const planned = planModelBinding(binding, account.listings, messages === undefined ? {} : { kind: "generation" })
  if (!planned.ok) return { failure: planned.failure }
  const { plan } = planned
  const body = input ?? modelCallDefault(plan.kind)
  if (body.kind !== plan.kind) return invalid
  const secret = yield* account.read(plan)
  if (!secret) return { failure: { code: "credential_missing", credential: plan.credential } } as Outcome
  const stale = yield* account.current
  if (stale) return stale
  const value = Redacted.value(secret)
  let headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${value}` }
  let payload: unknown
  if (body.kind === "decision") {
    headers = { ...headers, "ai-gateway-protocol-version": JEV_PROTOCOL_VERSION, "ai-gateway-auth-method": "api-key",
      "ai-evaluation-model-specification-version": JEV_SPECIFICATION_VERSION, "ai-model-id": plan.modelId }
    payload = { state: modelStateOf(body.state), questions: body.questions, providerOptions: { gateway: { zeroDataRetention: true } } }
  } else {
    const turns = messages ?? [...(body.system.trim() ? [{ role: "system", content: body.system }] : []), { role: "user", content: body.prompt }]
    const temperature = body.temperature === undefined ? {} : { temperature: body.temperature }
    switch (plan.protocol) {
      case "openai-chat": payload = { model: plan.modelId, stream: false, max_tokens: body.maxTokens,
        ...(input === undefined && new URL(plan.url).origin === "https://api.cerebras.ai" ? { reasoning_effort: "low" } : {}),
        ...temperature, messages: turns }; break
      case "openai-responses": payload = { model: plan.modelId, stream: false, max_output_tokens: body.maxTokens, ...temperature, input: turns }; break
      case "anthropic-messages":
        headers = { "content-type": "application/json", "x-api-key": value, "anthropic-version": "2023-06-01" }
        payload = { model: plan.modelId, stream: false, max_tokens: body.maxTokens, ...temperature,
          system: turns.filter(turn => turn.role === "system").map(turn => turn.content).join("\n"), messages: turns.filter(turn => turn.role !== "system") }
        break
      default: return invalid
    }
  }
  const response = yield* fetchWithDeadline("account model", plan.url, { method: "POST", redirect: "manual", headers, body: JSON.stringify(payload) }, MODEL_TEST_DEADLINE_MS)
  if (!response.ok) {
    yield* discardBody(response)
    return response.status >= 300 && response.status <= 599 ? { failure: { code: "refused", status: response.status } } as Outcome : invalid
  }
  // Never include the provider's raw body, parse errors or transport exception in an outcome.
  const raw = yield* readBoundedJson(response, 64 * 1024).pipe(Effect.catch(() => Effect.succeed(undefined)))
  const changed = yield* account.current
  if (changed) return changed
  if (typeof raw !== "object" || raw === null) return invalid
  if (body.kind === "decision") {
    const decoded = decodeModelAnswers(body.questions, (raw as { answers?: unknown }).answers)
    if (!decoded.ok) return invalid
    // Labels and dictionary keys are strings too. Refuse a secret-bearing
    // answer rather than changing the meaning of a decoded choice. Account
    // for JSON escaping as well as the sanitizer's nested-fragment rule.
    const serialized = JSON.stringify(decoded.answers)
    if (serialized !== cutModelCredential(serialized, value) || serialized.includes(JSON.stringify(value).slice(1, -1))) return invalid
    return { output: { kind: "decision", answers: decoded.answers } } as Outcome
  }
  const answer = raw as { choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown; reasoning?: unknown } }>; content?: Array<{ type?: string; text?: unknown }>;
    output?: Array<{ content?: Array<{ type?: string; text?: unknown }> }> }
  const text = plan.protocol === "openai-chat" ? answer.choices?.[0]?.message?.content
    : plan.protocol === "anthropic-messages" && Array.isArray(answer.content) ? answer.content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("")
    : plan.protocol === "openai-responses" && Array.isArray(answer.output) ? answer.output.flatMap(item => Array.isArray(item?.content) ? item.content : []).filter(part => part?.type === "output_text" && typeof part.text === "string").map(part => part.text).join("") : undefined
  if (plan.protocol === "openai-chat" && typeof text !== "string" && answer.choices?.[0]?.finish_reason === "length" &&
    typeof answer.choices[0]?.message?.reasoning === "string") return { failure: { code: "empty_output" } } as Outcome
  return typeof text === "string" ? { output: { kind: "generation", text: cutModelCredential(text, value).slice(0, MODEL_CALL_TEXT_MAX) } } as Outcome : invalid
}).pipe(
  Effect.timeoutOrElse({ duration: MODEL_TEST_DEADLINE_MS, orElse: () => Effect.succeed<Outcome>({ failure: { code: "timeout", deadlineMs: MODEL_TEST_DEADLINE_MS } }) }),
  Effect.catchTag("UpstreamTimeout", () => Effect.succeed<Outcome>({ failure: { code: "timeout", deadlineMs: MODEL_TEST_DEADLINE_MS } })),
  Effect.catchTag("UpstreamUnreachable", () => Effect.succeed<Outcome>({ failure: { code: "unreachable" } }))
)
