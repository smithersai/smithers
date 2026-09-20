/*
 * POST /api/model/test on the local host: ONE real request against a
 * configured model, on the real @smthrs/model stack. Generation goes through
 * the record's Route over a RequestExecutor built with no retries; a decision
 * model answers one boolean question through the real Evaluator. One deadline
 * covers the whole call and is echoed in the timeout it produces.
 *
 * `test` never throws and never returns provider text, except the sample with
 * the credential cut out of it.
 */
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import * as Evaluator from "@smthrs/model/Evaluator"
import { ModelRequest } from "@smthrs/model/ModelRequest"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import {
  bindingOf,
  failedModelTest,
  MODEL_TEST_DEADLINE_MS,
  MODEL_TEST_DECISION,
  MODEL_TEST_MAX_TOKENS,
  MODEL_TEST_PROMPT,
  scrubModelSample
} from "@smthrs/rpc/ConfiguredModel"
import type {
  ConfiguredModel,
  ModelCatalog,
  ModelCredentialEnv,
  ModelPlanOptions,
  ModelTestFailure,
  ModelTestResult
} from "@smthrs/rpc/ConfiguredModel"
import { Effect, Exit, Redacted, Stream } from "effect"
import { localModelCatalog, manualRedirects, modelFailureOf, planOnLocal } from "./ConfiguredModelHost"
import type { LocalPlanned } from "./ConfiguredModelHost"
import { toEvaluatorLayer, toModel } from "./ConfiguredModelRoute"

import type { ModelCredentials } from "./ModelCredentials"

export interface ModelProbeOptions {
  readonly credentials?: ModelCredentials
  /** The record credentials are read from. The host passes the one it was started with. */
  readonly env: ModelCredentialEnv
  /** False on the offline host, which may reach loopback only. */
  readonly egress: boolean
  /** The one deadline a test runs under. Defaults to MODEL_TEST_DEADLINE_MS. */
  readonly deadlineMs?: number
  /** Test override for the transport. */
  readonly fetch?: typeof globalThis.fetch
}

export interface ModelProbe {
  readonly catalog: () => ModelCatalog
  readonly test: (model: ConfiguredModel) => Promise<ModelTestResult>
}

type Outcome = { readonly sample: string } | { readonly failure: ModelTestFailure }

const invalidProtocol: Outcome = { failure: { code: "invalid", field: "protocol" } }

const generation = (
  planned: Extract<LocalPlanned, { ok: true }>
): Effect.Effect<Outcome, unknown, KernelHttpClient.HttpClient> =>
  Effect.gen(function*() {
    const http = yield* KernelHttpClient.HttpClient
    const executor = yield* RequestExecutor.makeWith(RequestExecutor.fixed(http), { maxRetries: 0 })
    const model = yield* toModel(planned.plan, planned.apiKey).pipe(
      Effect.provideService(RequestExecutor.RequestExecutor, executor)
    )
    const events = Array.from(
      yield* Stream.runCollect(model.stream(ModelRequest.make({
        modelId: planned.plan.modelId,
        system: [],
        messages: [{ role: "user", content: [{ type: "text", text: MODEL_TEST_PROMPT }] }],
        tools: [],
        params: { maxTokens: MODEL_TEST_MAX_TOKENS }
      })))
    )
    // Reaching `settle` is the pass: a reasoning model may spend every token thinking and say nothing.
    if (!events.some((event) => event.type === "settle")) return invalidProtocol
    const text = events.flatMap((event) => event.type === "text-delta" ? [event.text] : []).join("")
    return { sample: scrubModelSample(text, Redacted.value(planned.apiKey)) }
  })

const decision = (
  planned: Extract<LocalPlanned, { ok: true }>,
  deadlineMs: number
): Effect.Effect<Outcome, unknown, KernelHttpClient.HttpClient> =>
  Effect.gen(function*() {
    const evaluator = yield* Evaluator.Evaluator
    const answer = yield* evaluator.evaluate({
      state: MODEL_TEST_DECISION.state,
      questions: { ok: new Evaluator.BooleanQuestion({ instructions: MODEL_TEST_DECISION.questions.ok.instructions }) }
    })
    const ok = answer.answers["ok"]
    if (ok === undefined || ok.type !== "boolean") return invalidProtocol
    return { sample: `${ok.probability >= 0.5} ${ok.probability.toFixed(2)}` }
  }).pipe(Effect.provide(toEvaluatorLayer(planned.plan, planned.apiKey, deadlineMs)))

export const createModelProbe = (options: ModelProbeOptions): ModelProbe => {
  const deadlineMs = options.deadlineMs ?? MODEL_TEST_DEADLINE_MS
  /** One rule for what is listed and what is tested, so the catalog offers no row a Test would refuse to dial. */
  const planOptions: ModelPlanOptions = options.egress ? {} : { egress: false }

  const test = async (model: ConfiguredModel): Promise<ModelTestResult> => {
    const started = performance.now()
    const failed = (failure: ModelTestFailure): ModelTestResult =>
      failedModelTest(failure, performance.now() - started, "local")
    await options.credentials?.refresh()
    const planned = planOnLocal(bindingOf(model), options.env, planOptions, options.credentials)
    if (!planned.ok) return failed(planned.failure)
    const http = manualRedirects(options.fetch)
    const exit = await Effect.runPromiseExit(
      (planned.plan.kind === "decision" ? decision(planned, deadlineMs) : generation(planned)).pipe(
        Effect.catch((error) => Effect.succeed<Outcome>({ failure: modelFailureOf(error, deadlineMs) })),
        Effect.timeoutOrElse({
          duration: deadlineMs,
          orElse: () => Effect.succeed<Outcome>({ failure: { code: "timeout", deadlineMs } })
        }),
        Effect.provide(http.layer)
      )
    )
    const redirected = http.redirected()
    if (redirected !== undefined) return failed({ code: "refused", status: redirected })
    // A defect is a bug in this host, and its cause may hold a signed request: dropped, never logged or returned.
    if (!Exit.isSuccess(exit)) return failed({ code: "unreachable" })
    return "failure" in exit.value
      ? failed(exit.value.failure)
      : { ok: true, latencyMs: Math.max(0, Math.round(performance.now() - started)), sample: exit.value.sample }
  }

  return { catalog: () => localModelCatalog(options.env, planOptions, options.credentials), test }
}
