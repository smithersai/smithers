/*
 * The local host's half of a configured model (@smthrs/rpc/ConfiguredModel):
 * which credentials this machine resolves, the catalog it reports, and the
 * sealed turn it serves for the explainer seat.
 *
 * A credential is read by NAME from the environment record the host was
 * started with, at exactly one env key (`modelCredentialEnvName`), and only
 * after the planner has pinned the request's origin to that name. The value is
 * Redacted at the read and is sent nowhere but the planned URL: redirects are
 * never followed, and no failure here carries provider text.
 */
import * as Evaluator from "@smthrs/model/Evaluator"
import { ModelError } from "@smthrs/model/ModelError"
import { Message, ModelRequest, SystemPart } from "@smthrs/model/ModelRequest"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { composeAgentInstructions } from "@smthrs/rpc/AgentContext"
import { cloudRole } from "@smthrs/rpc/AgentRoles"
import {
  cutModelCredential,
  DECISION_MODEL_IDS,
  hostModelCredentials,
  MODEL_CREDENTIALS,
  modelCredentialEnvName,
  modelSeatsOf,
  planModelBinding,
  servableModels
} from "@smthrs/rpc/ConfiguredModel"
import type {
  ConfiguredModel,
  ModelCatalog,
  ModelCredentialEnv,
  ModelPlan,
  ModelPlanOptions,
  ModelTestFailure
} from "@smthrs/rpc/ConfiguredModel"
import type { AgentTurnFrame, StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { Effect, Layer, Redacted, Stream } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import type { HttpClient } from "effect/unstable/http/HttpClient"
import { toModel } from "./ConfiguredModelRoute"

/** The most an explainer answer may run to. */
const SEALED_TURN_MAX_TOKENS = 1024
const SEALED_TURN_MAX_CHARS = 64 * 1024

/** The value behind a credential NAME, Redacted at the read; undefined when unset or blank. */
export const localModelCredential = (
  env: ModelCredentialEnv,
  name: string
): Redacted.Redacted<string> | undefined => {
  const value = env[modelCredentialEnvName(name)]?.trim()
  return value === undefined || value === "" ? undefined : Redacted.make(value)
}

/** A binding this host agreed to serve, with the one secret its plan names. */
export type LocalPlanned =
  | { readonly ok: true; readonly plan: ModelPlan; readonly apiKey: Redacted.Redacted<string> }
  | { readonly ok: false; readonly failure: ModelTestFailure }

/** Plans an untrusted binding against THIS host's table, then reads the secret the plan names and no other. */
export const planOnLocal = (input: unknown, env: ModelCredentialEnv, options: ModelPlanOptions = {}): LocalPlanned => {
  const planned = planModelBinding(input, hostModelCredentials(env), options)
  if (!planned.ok) return planned
  const apiKey = localModelCredential(env, planned.plan.credential)
  return apiKey === undefined
    ? { ok: false, failure: { code: "credential_missing", credential: planned.plan.credential } }
    : { ok: true, plan: planned.plan, apiKey }
}

const originOf = (credential: string): string | undefined =>
  MODEL_CREDENTIALS.find((row) => row.name === credential)?.origins[0]

/** The rows this host offers before the user configures any: the models the product already runs on these two keys. */
const LOCAL_BUILTIN_MODELS: ReadonlyArray<ConfiguredModel> = [
  {
    id: "cerebras",
    protocol: "openai-chat",
    baseUrl: originOf("CEREBRAS_API_KEY"),
    modelId: cloudRole("librarian").model.id,
    credential: "CEREBRAS_API_KEY",
    builtin: true
  },
  {
    id: "jev",
    protocol: "evaluation",
    modelId: DECISION_MODEL_IDS[0],
    credential: "AI_GATEWAY_API_KEY",
    builtin: true
  }
]

/**
 * GET /api/model/catalog on this host: names, presence and origins. Never a
 * value. `options` are the ones this host's Test plans with, so an offline
 * host lists no row it could not reach.
 */
export const localModelCatalog = (env: ModelCredentialEnv, options: ModelPlanOptions = {}): ModelCatalog => {
  const credentials = hostModelCredentials(env).map((row) => ({ ...row, origins: [...row.origins] }))
  return {
    models: [...servableModels(LOCAL_BUILTIN_MODELS, credentials, options)],
    credentials,
    seats: [...modelSeatsOf("local")]
  }
}

/** One call's transport: fetch that never follows a redirect, and the 3xx it was answered, if any. */
export interface ManualRedirects {
  readonly layer: Layer.Layer<HttpClient>
  /** RequestExecutor reads any status under 400 as an answer, so the refusal a 3xx is has to be remembered here. */
  readonly redirected: () => number | undefined
}

/** Built per call, so one call's redirect is never another's. */
export const manualRedirects = (base: typeof globalThis.fetch = globalThis.fetch): ManualRedirects => {
  let status: number | undefined
  const guarded = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await base(input, { ...init, redirect: "manual" })
    if (response.status >= 300 && response.status < 400) status = response.status
    return response
  }) as typeof globalThis.fetch
  return {
    layer: FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, guarded))),
    redirected: () => status
  }
}

const isStatus = (status: number | undefined): status is number =>
  status !== undefined && Number.isInteger(status) && status >= 300 && status <= 599

/**
 * The ONLY mapping from a provider failure to the contract's union. It reads
 * codes and numbers and never a message: a provider's words, and a transport
 * error's URL, stop here.
 */
export const modelFailureOf = (error: unknown, deadlineMs?: number): ModelTestFailure => {
  // A timeout names the deadline that armed it; with none armed, nothing answered.
  const timeout: ModelTestFailure = deadlineMs === undefined ? { code: "unreachable" } : { code: "timeout", deadlineMs }
  if (error instanceof ModelError) {
    if (isStatus(error.httpStatus)) return { code: "refused", status: error.httpStatus }
    if (error.code === "transport") return { code: "unreachable" }
    if (error.code === "call_timeout") return timeout
    return { code: "invalid", field: "protocol" }
  }
  if (error instanceof Evaluator.EvaluatorError) {
    if (error.code === "unreachable") return { code: "unreachable" }
    if (error.code === "timeout") return timeout
    if (isStatus(error.status)) return { code: "refused", status: error.status }
    return { code: "invalid", field: "protocol" }
  }
  return { code: "unreachable" }
}

/** A failure as the one line a card shows: the code and its number, no sentence. */
export const modelFailureLine = (failure: ModelTestFailure): string => {
  switch (failure.code) {
    case "refused":
      return `${failure.code} · ${failure.status}`
    case "timeout":
      return `${failure.code} · ${failure.deadlineMs} ms`
    case "invalid":
      return `${failure.code} · ${failure.field}`
    case "credential_missing":
    case "credential_unknown":
      return `${failure.code} · ${failure.credential}`
    case "host_refused":
      return failure.status === null ? failure.code : `${failure.code} · ${failure.status}`
    case "unreachable":
    case "endpoint_forbidden":
    case "model_not_allowed":
      return failure.code
  }
}

/** The plain transcript a sealed turn carries, or undefined when it continues a tool call. */
export const sealedMessages = (
  messages: StartAgentTurnRequest["messages"]
): ReadonlyArray<Message> | undefined => {
  const plain: Array<Message> = []
  for (const message of messages) {
    if (!("role" in message)) return undefined
    plain.push(message.role === "user" ? Message.user(message.content) : Message.assistant(message.content))
  }
  return plain
}

export interface SealedTurn {
  readonly runId: string
  readonly instructions: string
  readonly context?: StartAgentTurnRequest["context"]
  readonly messages: ReadonlyArray<Message>
}

/**
 * The explainer seat's turn through the planned model: one bounded answer,
 * then one `done`. A provider failure ends the turn with its typed
 * line; it never falls back to another model. Interrupting the fiber cancels
 * the request and publishes nothing. Text is the only thing published, and
 * only through the shared credential cut, including partial text on failure.
 * Nothing is published early: cutting an echo can join the halves of another.
 */
export const sealedTurn = (
  planned: Extract<LocalPlanned, { ok: true }>,
  turn: SealedTurn,
  publish: (frame: AgentTurnFrame) => void,
  fetchImpl?: typeof globalThis.fetch
): Effect.Effect<void> => {
  const http = manualRedirects(fetchImpl)
  let buffered = ""
  const say = (text: string): void => {
    if (text !== "") publish({ runId: turn.runId, type: "delta", kind: "text", text })
  }
  const done = (failure?: ModelTestFailure): void => {
    const text = cutModelCredential(buffered, Redacted.value(planned.apiKey))
    buffered = ""
    say(text)
    publish({
      runId: turn.runId,
      type: "done",
      reason: "stop",
      ...(failure === undefined ? {} : { error: modelFailureLine(failure) })
    })
  }
  return Effect.gen(function*() {
    const model = yield* toModel(planned.plan, planned.apiKey)
    const request = ModelRequest.make({
      modelId: planned.plan.modelId,
      system: [SystemPart.make({ text: composeAgentInstructions(turn.instructions, turn.context) })],
      messages: turn.messages,
      tools: [],
      params: { maxTokens: SEALED_TURN_MAX_TOKENS }
    })
    yield* Stream.runForEach(model.stream(request), (event) =>
      Effect.suspend(() => {
        if (event.type !== "text-delta") return Effect.void
        if (buffered.length + event.text.length > SEALED_TURN_MAX_CHARS) {
          return Effect.fail(new ModelError({ code: "invalid_provider_output", message: "The configured answer exceeded its limit" }))
        }
        buffered += event.text
        return Effect.void
      }))
  }).pipe(
    Effect.provide(RequestExecutor.layer.pipe(Layer.provide(http.layer))),
    Effect.match({
      onSuccess: () => {
        const status = http.redirected()
        done(status === undefined ? undefined : { code: "refused", status })
      },
      onFailure: (error) => {
        const status = http.redirected()
        done(status === undefined ? modelFailureOf(error) : { code: "refused", status })
      }
    }),
    // A defect's cause may hold a signed request, so it is dropped, never logged or published.
    Effect.catchDefect(() => Effect.sync(() => done({ code: "unreachable" })))
  )
}
