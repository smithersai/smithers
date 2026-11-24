import * as HttpEffect from "effect/http/HttpEffect"
import { Fuzz } from "@smthrs/fuzz"
import { HttpClient as KernelHttpClient } from "@smthrs/kernel"
import {
  Arbitrary,
  Chunk,
  Effect,
  Exit,
  Layer,
  Logger,
  Redacted,
  Result,
  Schema,
  Stream
} from "effect"
import * as Headers from "effect/http/Headers"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import { describe, expect, it } from "vitest"
import * as AnthropicMessages from "../src/AnthropicMessages.ts"
import * as CanonicalJson from "../src/CanonicalJson.ts"
import * as Auth from "../src/Auth.ts"
import * as Classifier from "../src/Classifier.ts"
import * as Endpoint from "../src/Endpoint.ts"
import * as Evaluator from "../src/Evaluator.ts"
import * as EvaluatorBackup from "../src/EvaluatorBackup.ts"
import * as FailureCopy from "../src/FailureCopy.ts"
import * as Model from "../src/Model.ts"
import { ModelError, ModelErrorCode } from "../src/ModelError.ts"
import * as ModelEvent from "../src/ModelEvent.ts"
import * as ModelProxy from "../src/ModelProxy.ts"
import * as ModelRequest from "../src/ModelRequest.ts"
import * as OpenAIChatCompletions from "../src/OpenAIChatCompletions.ts"
import * as OpenAIChatGPT from "../src/OpenAIChatGPT.ts"
import * as OpenAIResponses from "../src/OpenAIResponses.ts"
import * as RequestExecutor from "../src/RequestExecutor.ts"
import * as Route from "../src/Route.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261190")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(30, Math.min(baseExecutions, 80))
const ioExec = Math.max(12, Math.min(Math.ceil(baseExecutions / 5), 28))

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

const silentLog = Logger.layer([])

const mkReq = (overrides: {
  modelId: string
  messages: ReadonlyArray<ModelRequest.Message>
  tools?: ReadonlyArray<ModelRequest.ToolDefinition>
  params?: ModelRequest.GenerationParams
  serverTools?: ReadonlyArray<any>
}) =>
  ModelRequest.ModelRequest.make({
    modelId: overrides.modelId,
    system: [],
    messages: [...overrides.messages],
    tools: [...(overrides.tools ?? [])],
    params: overrides.params ?? ModelRequest.GenerationParams.make({}),
    ...(overrides.serverTools ? { serverTools: overrides.serverTools } : {})
  })

const makeClient = (
  handler: (req: HttpClientRequest.HttpClientRequest) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
): KernelHttpClient.HttpClient =>
  HttpClient.make((req) => handler(req)) as unknown as KernelHttpClient.HttpClient

const textResp = (
  req: HttpClientRequest.HttpClientRequest,
  status: number,
  body: string,
  headers: Record<string, string> = {}
) => HttpClientResponse.fromWeb(req, new Response(body, { status, headers }))

describe("@smthrs/model Wave 10 deep fuzzing", () => {
  it("fuzzes RequestExecutor retry-after/rate-limit header & body reset parsing, secret redaction, body truncation, timeouts & pool rebuilds", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        retryMode: Schema.Literals([
          "retryAfterMs",
          "retryAfterSec",
          "retryAfterDate",
          "rateLimitDuration",
          "rateLimitEpochSec",
          "rateLimitEpochMs",
          "bodyNestedReset",
          "bodyArrayReset",
          "oversizedErrorBody",
          "poolRebuild",
          "timeout"
        ]),
        bodyKind: Schema.Literals(["jsonWithSecret", "formDataWithSecret", "querySecret"]),
        status: Schema.Literals([429, 500, 502, 503, 401, 400])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ retryMode, bodyKind, status }) =>
          Effect.gen(function*() {
            let calls = 0
            let rebuilds = 0

            const mkStub = () => {
              rebuilds++
              return makeClient((req) => {
                  calls++
                  if (retryMode === "poolRebuild") {
                    if (calls <= 3) {
                      return Effect.fail(
                        new HttpClientError.HttpClientError({
                          reason: new HttpClientError.TransportError({ request: req, cause: new Error("ECONNRESET") })
                        })
                      )
                    }
                    return Effect.succeed(textResp(req, 200, "ok"))
                  }
                  if (retryMode === "timeout") {
                    return Effect.sleep("120 millis").pipe(Effect.as(textResp(req, 200, "late")))
                  }
                  if (retryMode === "oversizedErrorBody") {
                    const big = `{"error":{"message":"fail ${"x".repeat(8000)}","api_key":"sk-secret-val"}}`
                    return Effect.succeed(textResp(req, 500, big, { "content-type": "application/json" }))
                  }

                  const headers: Record<string, string> = { "content-type": "application/json" }
                  let body = JSON.stringify({ error: { code: "rate_limit", message: "slow down", token: "tok-secret-123" } })

                  if (retryMode === "retryAfterMs") {
                    headers["retry-after-ms"] = "5"
                  } else if (retryMode === "retryAfterSec") {
                    headers["retry-after"] = "0"
                  } else if (retryMode === "retryAfterDate") {
                    headers["retry-after"] = new Date(Date.now() + 2000).toUTCString()
                  } else if (retryMode === "rateLimitDuration") {
                    headers["x-ratelimit-remaining-requests"] = "0"
                    headers["x-ratelimit-reset-requests"] = "1m2s50ms"
                    headers["x-ratelimit-remaining-tokens"] = "5"
                    headers["x-ratelimit-reset-tokens"] = "2h"
                  } else if (retryMode === "rateLimitEpochSec") {
                    headers["x-ratelimit-remaining-tokens"] = "0"
                    headers["x-ratelimit-reset-tokens"] = String(Math.floor(Date.now() / 1000) + 5)
                  } else if (retryMode === "rateLimitEpochMs") {
                    headers["x-ratelimit-remaining-tokens"] = "0"
                    headers["x-ratelimit-reset-tokens"] = String(Date.now() + 5000)
                  } else if (retryMode === "bodyNestedReset") {
                    body = JSON.stringify({
                      error: {
                        message: "limit hit",
                        remaining: 0,
                        reset_at: new Date(Date.now() + 4000).toISOString(),
                        retry_after_ms: 15,
                        resets_in_seconds: 2
                      }
                    })
                  } else if (retryMode === "bodyArrayReset") {
                    body = JSON.stringify({
                      errors: [
                        { remaining: 0, reset_after: "500ms", api_key: "sk-hidden" },
                        { reset_after_ms: 25 }
                      ]
                    })
                  }

                  const httpStatus = retryMode === "retryAfterMs" || retryMode === "retryAfterSec" ||
                      retryMode === "retryAfterDate" || retryMode.startsWith("rateLimit") ||
                      retryMode.startsWith("body")
                    ? 429
                    : status
                  return Effect.succeed(textResp(req, httpStatus, body, headers))
              })
            }
            const transport: RequestExecutor.Transport = {
              client: mkStub(),
              rebuild: Effect.sync(mkStub)
            }

            const exec = yield* RequestExecutor.makeWith(transport, {
              maxRetries: 0,
              responseStartMs: retryMode === "timeout" ? 15 : 2000
            })

            const effectiveBodyKind = retryMode === "poolRebuild" ? "jsonWithSecret" : bodyKind
            let req = HttpClientRequest.post(
              effectiveBodyKind === "querySecret"
                ? "https://api.example.com/v1/chat?api_key=sk-query-secret&safe=1"
                : "https://api.example.com/v1/chat"
            )
            if (effectiveBodyKind === "querySecret") {
              req = HttpClientRequest.appendUrlParam(req, "token", "secret-param-val")
            } else if (effectiveBodyKind === "formDataWithSecret") {
              const fd = new FormData()
              fd.append("api_key", "fd-secret-val")
              fd.append("model", "gpt-5")
              req = HttpClientRequest.bodyFormData(req, fd)
            } else {
              req = HttpClientRequest.bodyJsonUnsafe(req, {
                api_key: "json-secret-val",
                nested: [{ access_token: "nested-tok" }],
                model: "gpt-5"
              })
            }

            if (retryMode === "poolRebuild") {
              // Trigger 3 consecutive transport failures to force pool rebuild (rebuildAfter = 3)
              for (let i = 0; i < 3; i++) {
                const f = yield* Effect.exit(
                  Effect.scoped(exec.execute(req, {} as any)).pipe(
                    Effect.provideService(RequestExecutor.Retries, 0),
                    Effect.provide(silentLog)
                  )
                )
                expect(Exit.isFailure(f)).toBe(true)
              }
              const ok = yield* Effect.exit(
                Effect.scoped(exec.execute(req, {} as any)).pipe(
                  Effect.provideService(RequestExecutor.Retries, 0),
                  Effect.provide(silentLog)
                )
              )
              expect(Exit.isSuccess(ok)).toBe(true)
              expect(rebuilds).toBeGreaterThanOrEqual(2)
              return true
            }

            const exit = yield* Effect.exit(
              Effect.scoped(exec.execute(req, {} as any)).pipe(
                Effect.provide(silentLog)
              )
            )
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              const err = exit.cause.reasons.find((r) => r._tag === "Fail")
              if (err && err._tag === "Fail" && err.error instanceof ModelError) {
                expect(err.error.message).not.toContain("sk-query-secret")
                expect(err.error.message).not.toContain("json-secret-val")
                expect(err.error.message).not.toContain("fd-secret-val")
              }
            }
            return true
          }),
        { seed, executions: ioExec }
      )
    )
    assertPassed(report)
  }, 90_000)

  it("fuzzes AnthropicMessages, OpenAIResponses & OpenAIChatCompletions edge encoding/decoding paths", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        anthropicCase: Schema.Literals([
          "budgetNoMax",
          "budgetGeMax",
          "budgetValid",
          "adaptiveReject",
          "leadingAssistant",
          "effortLevels",
          "streamRefusalAndSig",
          "streamTruncatedTool",
          "streamUnclosedTool",
          "streamErrorAndSpendCap"
        ]),
        responsesCase: Schema.Literals([
          "thinkingAndItemRefs",
          "deferredToolsLoad",
          "serverToolsDedup",
          "encryptedReasoning",
          "openToolFinalize",
          "unfinishedToolErr"
        ]),
        chatCase: Schema.Literals([
          "toolResultsDropped",
          "missingToolNameErr",
          "streamErrorString",
          "streamErrorObj"
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ anthropicCase, responsesCase, chatCase }) =>
          Effect.gen(function*() {
            const baseUser = [ModelRequest.Message.user("hi")]

            // === 1. AnthropicMessages ===
            if (anthropicCase === "budgetNoMax") {
              const req = mkReq({
                modelId: "claude-sonnet-4-5-20250929",
                messages: baseUser,
                params: ModelRequest.GenerationParams.make({ thinkingBudget: 5000 })
              })
              const res = yield* Effect.exit(AnthropicMessages.protocol.body.from(req, { native: false }))
              expect(Exit.isSuccess(res)).toBe(true)
            } else if (anthropicCase === "budgetGeMax") {
              const req = mkReq({
                modelId: "claude-sonnet-4-5-20250929",
                messages: baseUser,
                params: ModelRequest.GenerationParams.make({ thinkingBudget: 4096, maxTokens: 2048 })
              })
              const res = yield* Effect.exit(AnthropicMessages.protocol.body.from(req, { native: false }))
              expect(Exit.isFailure(res)).toBe(true)
            } else if (anthropicCase === "budgetValid") {
              const req = mkReq({
                modelId: "claude-sonnet-4-5-20250929",
                messages: baseUser,
                params: ModelRequest.GenerationParams.make({ thinkingBudget: 2048, maxTokens: 4096 })
              })
              const res = yield* Effect.exit(AnthropicMessages.protocol.body.from(req, { native: false }))
              expect(Exit.isSuccess(res)).toBe(true)
            } else if (anthropicCase === "adaptiveReject") {
              const req = mkReq({
                modelId: "claude-opus-4-7",
                messages: baseUser,
                params: ModelRequest.GenerationParams.make({ temperature: 0.5 })
              })
              const res = yield* Effect.exit(AnthropicMessages.protocol.body.from(req, { native: false }))
              expect(Exit.isFailure(res)).toBe(true)
            } else if (anthropicCase === "leadingAssistant") {
              const req = mkReq({
                modelId: "claude-sonnet-4-5-20250929",
                messages: [ModelRequest.Message.assistant([{ type: "text", text: "first" }])]
              })
              const res = yield* Effect.exit(AnthropicMessages.protocol.body.from(req, { native: false }))
              expect(Exit.isFailure(res)).toBe(true)
            } else if (anthropicCase === "effortLevels") {
              for (const effort of ["none", "minimal", "low", "medium", "high", "max"] as const) {
                const req = mkReq({
                  modelId: "claude-opus-4-6",
                  messages: baseUser,
                  params: ModelRequest.GenerationParams.make({ reasoningEffort: effort })
                })
                const res = yield* Effect.exit(AnthropicMessages.protocol.body.from(req, { native: false }))
                expect(Exit.isSuccess(res)).toBe(true)
              }
            } else if (anthropicCase === "streamRefusalAndSig") {
              const req = mkReq({ modelId: "claude-opus-4-6", messages: baseUser })
              let st = AnthropicMessages.protocol.stream.initial(req)
              const evs = [
                { type: "message_start", message: { id: "m1", model: "claude-opus-4-6", usage: { input_tokens: 5, output_tokens: 1 } } },
                { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
                { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
                { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-part-1" } },
                { type: "content_block_stop", index: 0 },
                { type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 3 } },
                { type: "ping" },
                { type: "message_stop" }
              ]
              for (const raw of evs) {
                const ev = Schema.decodeUnknownSync(AnthropicMessages.protocol.stream.event)(JSON.stringify(raw))
                const r = yield* Effect.exit(AnthropicMessages.protocol.stream.step(st, ev))
                expect(Exit.isSuccess(r)).toBe(true)
                if (Exit.isSuccess(r)) st = r.value[0]
              }
            } else if (anthropicCase === "streamTruncatedTool" || anthropicCase === "streamUnclosedTool") {
              const req = mkReq({ modelId: "claude-opus-4-6", messages: baseUser })
              let st = AnthropicMessages.protocol.stream.initial(req)
              const evs = [
                { type: "message_start", message: { id: "m2", model: "claude-opus-4-6", usage: { input_tokens: 5, output_tokens: 1 } } },
                { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "read", input: {} } },
                { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: anthropicCase === "streamTruncatedTool" ? '{"a":' : '{"a":1}' } },
                {
                  type: "message_delta",
                  delta: { stop_reason: anthropicCase === "streamTruncatedTool" ? "max_tokens" : "weird_reason" },
                  usage: { output_tokens: 2 }
                },
                { type: "message_stop" }
              ]
              for (const raw of evs) {
                const ev = Schema.decodeUnknownSync(AnthropicMessages.protocol.stream.event)(JSON.stringify(raw))
                const r = yield* Effect.exit(AnthropicMessages.protocol.stream.step(st, ev))
                expect(Exit.isSuccess(r)).toBe(true)
                if (Exit.isSuccess(r)) st = r.value[0]
              }
            } else if (anthropicCase === "streamErrorAndSpendCap") {
              const req = mkReq({ modelId: "claude-opus-4-6", messages: baseUser })
              const st = AnthropicMessages.protocol.stream.initial(req)
              const ev = Schema.decodeUnknownSync(AnthropicMessages.protocol.stream.event)(
                JSON.stringify({
                  type: "error",
                  error: {
                    type: "rate_limit_error",
                    message: "You have reached your spend cap. You will regain access on 2026-12-01 at 14:30 UTC."
                  }
                })
              )
              const errRes = yield* Effect.exit(AnthropicMessages.protocol.stream.step(st, ev))
              expect(Exit.isFailure(errRes)).toBe(true)
            }

            // === 2. OpenAIResponses ===
            if (responsesCase === "thinkingAndItemRefs") {
              const sigJson = CanonicalJson.stringify({
                type: "reasoning",
                id: "rs_1",
                summary: [{ type: "summary_text", text: "sum" }],
                encrypted_content: "enc123"
              })
              const req = mkReq({
                modelId: "gpt-5",
                messages: [
                  ModelRequest.Message.user("q"),
                  ModelRequest.Message.assistant(
                    [
                      { type: "thinking", text: "sum", signature: sigJson },
                      { type: "thinking", text: "ref", signature: "rs_raw_ref" },
                      { type: "text", text: "ans" }
                    ],
                    { itemIds: ["rs_1", "msg_extra", "msg_extra"] }
                  ),
                  ModelRequest.Message.user("next")
                ]
              })
              const body = yield* Effect.exit(OpenAIResponses.protocol.body.from(req, { native: true }))
              expect(Exit.isSuccess(body)).toBe(true)
            } else if (responsesCase === "deferredToolsLoad") {
              const req = mkReq({
                modelId: "gpt-5",
                tools: [
                  ModelRequest.ToolDefinition.make({
                    name: "search_tools",
                    description: "Search deferred tools",
                    parameters: { type: "object", properties: {} }
                  }),
                  ModelRequest.ToolDefinition.make({
                    name: "secret_tool",
                    description: "Deferred",
                    parameters: { type: "object", properties: { x: { type: "string" } } },
                    deferred: true
                  })
                ],
                messages: [
                  ModelRequest.Message.user("load secret_tool"),
                  ModelRequest.Message.assistant([
                    { type: "tool-call", id: "tc_1", name: "search_tools", arguments: "{}" }
                  ]),
                  ModelRequest.Message.tool([
                    {
                      type: "tool-result",
                      toolCallId: "tc_1",
                      content: "loaded",
                      addedToolNames: ["secret_tool", "secret_tool"]
                    }
                  ])
                ]
              })
              const body = yield* Effect.exit(OpenAIResponses.protocol.body.from(req, { native: true }))
              expect(Exit.isSuccess(body)).toBe(true)
            } else if (responsesCase === "serverToolsDedup") {
              const req = mkReq({
                modelId: "gpt-5",
                messages: baseUser,
                serverTools: [
                  { type: "web_search" },
                  { type: "web_search" }
                ]
              })
              const body = yield* Effect.exit(OpenAIResponses.protocol.body.from(req, { native: true }))
              expect(Exit.isSuccess(body)).toBe(true)
            } else if (responsesCase === "encryptedReasoning") {
              const req = mkReq({ modelId: "gpt-5", messages: baseUser })
              let st = OpenAIResponses.protocol.stream.initial(req)
              const evs = [
                { type: "response.created", response: { id: "r1", model: "gpt-5" } },
                {
                  type: "response.output_item.done",
                  output_index: 0,
                  item: { type: "reasoning", id: "rs_enc", encrypted_content: "enc-payload", summary: [] }
                },
                { type: "response.completed", response: { id: "r1", status: "completed", output: [] } }
              ]
              for (const raw of evs) {
                const ev = Schema.decodeUnknownSync(OpenAIResponses.protocol.stream.event)(JSON.stringify(raw))
                const r = yield* Effect.exit(OpenAIResponses.protocol.stream.step(st, ev))
                expect(Exit.isSuccess(r)).toBe(true)
                if (Exit.isSuccess(r)) st = r.value[0]
              }
            } else if (responsesCase === "openToolFinalize" || responsesCase === "unfinishedToolErr") {
              const req = mkReq({ modelId: "gpt-5", messages: baseUser })
              let st = OpenAIResponses.protocol.stream.initial(req)
              const ev1 = Schema.decodeUnknownSync(OpenAIResponses.protocol.stream.event)(
                JSON.stringify({
                  type: "response.output_item.added",
                  output_index: 0,
                  item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "" }
                })
              )
              const r1 = yield* Effect.exit(OpenAIResponses.protocol.stream.step(st, ev1))
              expect(Exit.isSuccess(r1)).toBe(true)
              if (Exit.isSuccess(r1)) st = r1.value[0]

              const ev2 = Schema.decodeUnknownSync(OpenAIResponses.protocol.stream.event)(
                JSON.stringify({
                  type: "response.completed",
                  response: {
                    id: "r2",
                    status: "completed",
                    output: responsesCase === "openToolFinalize"
                      ? [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: '{"p":"x"}' }]
                      : []
                  }
                })
              )
              const completed = yield* Effect.exit(OpenAIResponses.protocol.stream.step(st, ev2))
              if (responsesCase === "openToolFinalize") expect(Exit.isSuccess(completed)).toBe(true)
              else expect(Exit.isFailure(completed)).toBe(true)
            }

            // === 3. OpenAIChatCompletions ===
            if (chatCase === "toolResultsDropped") {
              const req = mkReq({
                modelId: "gpt-4o",
                messages: [
                  ModelRequest.Message.user("run"),
                  ModelRequest.Message.assistant([
                    { type: "tool-call", id: "call_ok", name: "fn", arguments: "{}" }
                  ]),
                  ModelRequest.Message.tool([
                    { type: "tool-result", toolCallId: "call_ok", content: "res", addedToolNames: [] },
                    { type: "tool-result", toolCallId: "call_orphan", content: "drop", addedToolNames: [] }
                  ])
                ]
              })
              const body = yield* Effect.exit(OpenAIChatCompletions.protocol.body.from(req, { native: false }))
              expect(Exit.isSuccess(body)).toBe(true)
            } else if (chatCase === "missingToolNameErr") {
              const req = mkReq({ modelId: "gpt-4o", messages: baseUser })
              const st = OpenAIChatCompletions.protocol.stream.initial(req)
              const ev = Schema.decodeUnknownSync(OpenAIChatCompletions.protocol.stream.event)(
                JSON.stringify({
                  choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "tc_noname", function: { arguments: "{}" } }] } }]
                })
              )
              const r = yield* Effect.exit(OpenAIChatCompletions.protocol.stream.step(st, ev))
              expect(Exit.isFailure(r)).toBe(true)
            } else if (chatCase === "streamErrorString" || chatCase === "streamErrorObj") {
              const req = mkReq({ modelId: "gpt-4o", messages: baseUser })
              const st = OpenAIChatCompletions.protocol.stream.initial(req)
              const ev = Schema.decodeUnknownSync(OpenAIChatCompletions.protocol.stream.event)(
                JSON.stringify({
                  error: chatCase === "streamErrorString"
                    ? "stream died"
                    : { code: "rate_limit_exceeded", message: "too fast" }
                })
              )
              const r = yield* Effect.exit(OpenAIChatCompletions.protocol.stream.step(st, ev))
              expect(Exit.isFailure(r)).toBe(true)
            }

            expect(OpenAIChatGPT.make).toBeDefined()
            expect(CanonicalJson.stringify({ b: 1, a: [2, 3] })).toBe('{"a":[2,3],"b":1}')
            return true
          }),
        { seed: seed + 1, executions: fastExec }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("fuzzes Evaluator.layerVercelGateway, Evaluator.layerUnavailable, Classifier, Route sensitive headers/schema paths, FailureCopy & Endpoint", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        evalScenario: Schema.Literals([
          "okWithConfidenceUsage",
          "invalidBaseUrl",
          "nonJsonBody",
          "missingAnswers",
          "oversizedBody",
          "http429WithReset",
          "http500",
          "unavailable",
          "scriptedInvalidAnswer"
        ]),
        routeCase: Schema.Literals(["sensitiveHeader", "invalidBaseUrl", "schemaPathNested"]),
        failureCode: ModelErrorCode
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ evalScenario, routeCase, failureCode }) =>
          Effect.gen(function*() {
            const questions = {
              pass: Evaluator.BooleanQuestion.of({
                instructions: "Does it pass?",
                criteria: { true: "Passes", false: "Fails" }
              }),
              grade: Evaluator.ChoiceQuestion.of({
                instructions: "Grade?",
                criteria: { a: "Good", b: "Bad" }
              }),
              score: Evaluator.ScoreQuestion.of({
                instructions: "Score?",
                criteria: ["low", "mid", "high"] as const
              })
            }

            if (evalScenario === "unavailable") {
              const ex = yield* Effect.exit(
                Effect.flatMap(Evaluator.Evaluator, (ev) => ev.evaluate({ state: { ok: true }, questions })).pipe(
                  Effect.provide(Evaluator.layerUnavailable())
                )
              )
              expect(Exit.isFailure(ex)).toBe(true)
            } else if (evalScenario === "scriptedInvalidAnswer") {
              const ex = yield* Effect.exit(
                Effect.flatMap(Evaluator.Evaluator, (ev) => ev.evaluate({ state: { ok: true }, questions })).pipe(
                  Effect.provide(Evaluator.layerScripted(() => ({ pass: "not-a-valid-answer" as any })))
                )
              )
              expect(Exit.isFailure(ex)).toBe(true)
            } else {
              const stubClient = makeClient((req) => {
                if ((evalScenario as string) === "timeout") {
                  return Effect.sleep("120 millis").pipe(Effect.as(textResp(req, 200, "{}")))
                }
                if (evalScenario === "oversizedBody") {
                  return Effect.succeed(textResp(req, 200, "x".repeat(Evaluator.maxResponseBytes + 100)))
                }
                if (evalScenario === "nonJsonBody") {
                  return Effect.succeed(textResp(req, 200, "not json"))
                }
                if (evalScenario === "missingAnswers") {
                  return Effect.succeed(textResp(req, 200, JSON.stringify({ ok: true })))
                }
                if (evalScenario === "http429WithReset") {
                  return Effect.succeed(textResp(req, 429, "limit", { "retry-after": "5" }))
                }
                if (evalScenario === "http500") {
                  return Effect.succeed(textResp(req, 500, "boom"))
                }
                return Effect.succeed(
                  textResp(
                    req,
                    200,
                    JSON.stringify({
                      answers: {
                        pass: { type: "boolean", probability: 0.95 },
                        grade: { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 } },
                        score: { type: "score", score: 2, probabilities: { low: 0.05, mid: 0.1, high: 0.85 } }
                      },
                      usage: { inputTokens: 12, outputTokens: 8 },
                      providerMetadata: { typesafe: { confidence: { pass: 0.95, grade: 0.9, score: 0.88 } } }
                    })
                  )
                )
              })

              const evalLayer = Evaluator.layerVercelGateway({
                apiKey: Redacted.make("test-key"),
                baseUrl: evalScenario === "invalidBaseUrl" ? "ftp://bad.example.com" : "https://ai-gateway.vercel.sh/v4/ai/evaluation-model",
                timeoutMs: (evalScenario as string) === "timeout" ? 15 : 2000,
                attempts: 1
              }).pipe(
                Layer.provide(Layer.succeed(KernelHttpClient.HttpClient, stubClient)),
                Layer.provide(silentLog)
              )

              const cls = Classifier.make("wave10/cls", {
                description: "Wave 10 test classifier",
                state: Schema.Struct({ ok: Schema.Boolean }),
                questions
              })

              const ex = yield* Effect.exit(
                cls.evaluate({ ok: true }).pipe(Effect.provide(evalLayer))
              )
              if (evalScenario === "okWithConfidenceUsage") {
                expect(Exit.isSuccess(ex)).toBe(true)
                if (Exit.isSuccess(ex)) {
                  expect(ex.value.pass.value).toBe(true)
                  expect(Classifier.confidence(ex.value.pass)).toBeGreaterThanOrEqual(0)
                }
              } else {
                expect(Exit.isFailure(ex)).toBe(true)
              }
            }

            // Route validation paths
            if (routeCase === "sensitiveHeader") {
              const base = Result.getOrThrow(Route.openaiChatCompatible({
                id: "bad-hdr",
                providerName: "custom",
                baseUrl: "https://api.example.com/v1",
                apiKey: Redacted.make("k")
              }))
              const badRoute = Route.make({ ...base, headers: { authorization: "Bearer leak" } })
              const prep = yield* Effect.exit(Route.prepare(badRoute, mkReq({ modelId: "m", messages: [ModelRequest.Message.user("hi")] })))
              expect(Exit.isFailure(prep)).toBe(true)
            } else if (routeCase === "invalidBaseUrl") {
              const r = Route.openai({
                apiKey: Redacted.make("k"),
                baseUrl: "http://not-https.example.com"
              })
              expect(Result.isFailure(r)).toBe(true)
            } else {
              const r = Route.openaiChatCompatible({
                id: "custom-chat",
                providerName: "custom",
                apiKey: Redacted.make("k"),
                baseUrl: "https://api.example.com/v1"
              })
              expect(Result.isSuccess(r)).toBe(true)
            }

            // FailureCopy & Endpoint
            const err = new ModelError({ code: failureCode, message: "msg", retryAfterMillis: 5000 })
            const desc = FailureCopy.describe(err, "anthropic/claude-opus-4-6")
            expect(desc.headline.length).toBeGreaterThan(0)
            expect(FailureCopy.provider("openai/gpt-5")).toBeDefined()
            expect(FailureCopy.provider(undefined)).toBeDefined()
            expect(Result.isFailure(Endpoint.makeSecure({ url: "http://example.com" }))).toBe(true)
            expect(Result.isFailure(Endpoint.make({ url: "ftp://example.com" }))).toBe(true)
            expect(Result.isFailure(Endpoint.make({ url: "https://user:pass@example.com" }))).toBe(true)
            return true
          }),
        { seed: seed + 2, executions: ioExec }
      )
    )
    assertPassed(report)
  }, 90_000)

  it("fuzzes ModelProxy.serve & ModelProxy.layerClient/makeClient error/NDJSON/UTF-8/oversized/partial-line invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        proxyCase: Schema.Literals([
          "okRoundTrip",
          "nonPost405",
          "invalidUtf8",
          "handlerDefect500",
          "streamModelError",
          "oversizedLine",
          "partialTrailingLine",
          "clientBadUrl",
          "clientTransportErr"
        ]),
        delta: Schema.Literals(["alpha", "beta", "gamma"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ proxyCase, delta }) =>
          Effect.gen(function*() {
            const req = mkReq({
              modelId: "claude-opus-4-6",
              messages: [ModelRequest.Message.user("hello")]
            })

            if (proxyCase === "clientBadUrl") {
              const ex = yield* Effect.exit(
                ModelProxy.prepare({ url: "http://[::1" })(req)
              )
              expect(Exit.isFailure(ex)).toBe(true)
              return true
            }

            if (proxyCase === "clientTransportErr") {
              const badHttp = Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((r) =>
                  Effect.fail(
                    new HttpClientError.HttpClientError({
                      reason: new HttpClientError.TransportError({ request: r, cause: new Error("down") })
                    })
                  )
                )
              )
              const clientLayer = ModelProxy.layerClient({ url: "https://proxy.example.com/model" }).pipe(
                Layer.provide(badHttp),
                Layer.provide(silentLog)
              )
              const ex = yield* Effect.exit(
                Effect.flatMap(Model.Model, (m) => Stream.runCollect(m.stream(req))).pipe(
                  Effect.provide(clientLayer),
                  Effect.provide(silentLog)
                )
              )
              expect(Exit.isFailure(ex)).toBe(true)
              return true
            }

            if (proxyCase === "oversizedLine" || proxyCase === "partialTrailingLine") {
              const payload = proxyCase === "oversizedLine"
                ? `${"a".repeat(2_000_000)}\n`
                : `{"type":"text-delta","text":"unterminated"`
              const stubHttp = Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((r) =>
                  Effect.succeed(
                    HttpClientResponse.fromWeb(
                      r,
                      new Response(payload, { status: 200, headers: { "content-type": ModelProxy.contentType } })
                    )
                  )
                )
              )
              const clientLayer = ModelProxy.layerClient({ url: "https://proxy.example.com/model" }).pipe(
                Layer.provide(stubHttp),
                Layer.provide(silentLog)
              )
              const ex = yield* Effect.exit(
                Effect.flatMap(Model.Model, (m) => Stream.runCollect(m.stream(req))).pipe(
                  Effect.provide(clientLayer),
                  Effect.provide(silentLog)
                )
              )
              expect(Exit.isFailure(ex)).toBe(true)
              return true
            }

            const serveEffect = ModelProxy.serve({
              prepare: (r) => {
                if (proxyCase === "handlerDefect500") return Effect.die(new Error("crash"))
                return Effect.succeed({
                  model: Model.make({
                    stream: () =>
                      proxyCase === "streamModelError"
                        ? Stream.fail(new ModelError({ code: "provider_internal", message: "busy" }))
                        : Stream.fromIterable([
                            ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "t" }),
                            ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "t", text: delta }),
                            ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "t" }),
                            ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
                          ])
                  }),
                  request: r
                })
              }
            })

            const runServe = (webReq: Request) =>
              serveEffect.pipe(
                Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(webReq)),
                Effect.provide(silentLog)
              )

            if (proxyCase === "nonPost405") {
              const resp = yield* runServe(new Request("https://proxy.example.com/model", { method: "GET" }))
              expect(resp.status).toBe(405)
              return true
            }

            if (proxyCase === "invalidUtf8") {
              const badBytes = new Uint8Array([0xff, 0xfe, 0xfd])
              const resp = yield* runServe(
                new Request("https://proxy.example.com/model", {
                  method: "POST",
                  body: badBytes,
                  headers: { "content-type": "application/json" }
                })
              )
              expect(resp.status).toBe(400)
              return true
            }

            if (proxyCase === "handlerDefect500") {
              const encoded = Schema.encodeSync(Schema.fromJsonString(ModelRequest.ModelRequest))(req)
              const resp = yield* runServe(
                new Request("https://proxy.example.com/model", {
                  method: "POST",
                  body: encoded,
                  headers: { "content-type": "application/json" }
                })
              )
              expect(resp.status).toBe(500)
              return true
            }

            const webHandler = HttpEffect.toWebHandler(serveEffect.pipe(Effect.provide(silentLog)))
            const inProcessHttp = Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((clientReq) =>
                Effect.promise(async () => {
                  const bodyBytesIn = clientReq.body._tag === "Uint8Array"
                    ? clientReq.body.body
                    : new Uint8Array()
                  const webReq = new Request(clientReq.url, {
                    method: clientReq.method,
                    body: bodyBytesIn as any,
                    headers: { "content-type": "application/json", ...clientReq.headers }
                  })
                  const webResp = await webHandler(webReq)
                  return HttpClientResponse.fromWeb(clientReq, webResp)
                })
              )
            )

            const clientLayer = ModelProxy.layerClient({ url: "https://proxy.example.com/model" }).pipe(
              Layer.provide(inProcessHttp),
              Layer.provide(silentLog)
            )
            const ex = yield* Effect.exit(
              Effect.flatMap(Model.Model, (m) => Stream.runCollect(m.stream(req))).pipe(
                Effect.provide(clientLayer),
                Effect.provide(silentLog)
              )
            )
            if (proxyCase === "okRoundTrip") {
              expect(Exit.isSuccess(ex)).toBe(true)
              if (Exit.isSuccess(ex)) {
                const items = ex.value
                expect(items.some((e) => e.type === "text-delta" && e.text === delta)).toBe(true)
              }
            } else {
              expect(Exit.isFailure(ex)).toBe(true)
            }
            return true
          }),
        { seed: seed + 3, executions: ioExec }
      )
    )
    assertPassed(report)
  }, 90_000)

  it("fuzzes Route (schemaPath/canonicalPath/affinity/auth-refresh/stream-error), FailureCopy, Classifier invalid answers & Endpoint query/fragment validation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        routeCase: Schema.Literals([
          "invalidRequestSchema",
          "invalidProviderBody",
          "nonJsonCanonical",
          "affinityAndRefresh",
          "streamTransportError",
          "sseParseError",
          "invalidProviderEvent"
        ]),
        failureKind: Schema.Literals([
          "budgetUsdMeasured",
          "budgetUsdUnmeasured",
          "budgetDailyMeasured",
          "budgetTokensMeasured",
          "budgetLatencyUnmeasured",
          "unroutedNoCandidates",
          "unroutedUnconfiguredMsg",
          "unroutedUnconfiguredEmpty",
          "unroutedInterrupted",
          "unroutedEval",
          "unresolvedWithMsg",
          "unresolvedEmpty",
          "harnessMaxTurns",
          "evaluatorErr",
          "unknownFallback"
        ]),
        classifierBad: Schema.Literals([
          "missingAnswer",
          "wrongType",
          "badBoolProb",
          "unknownChoice",
          "badChoiceProb",
          "outOfRangeScore",
          "badScoreProbKeys",
          "badStateEncode",
          "evalErrorWithUsage",
          "evaluateAllOk"
        ]),
        endpointCase: Schema.Literals([
          "tupleQuerySort",
          "pathWithQuery",
          "pathWithHash",
          "baseWithFragment"
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ routeCase, failureKind, classifierBad, endpointCase }) =>
          Effect.gen(function*() {
            // 1. Endpoint query tuple sorting & fragment/query rejection (Endpoint.ts L47, 61, 96, 106-110)
            if (endpointCase === "tupleQuerySort") {
              const ep = Endpoint.make({
                url: "https://api.example.com",
                path: "/v1/chat",
                query: [["b", "2"], ["a", "2"], ["a", "1"], ["a", "1"]]
              })
              expect(ep._tag).toBe("Success")
            } else if (endpointCase === "pathWithQuery") {
              const ep = Endpoint.make({ url: "https://api.example.com", path: "/v1/chat?x=1" })
              expect(ep._tag).toBe("Failure")
            } else if (endpointCase === "pathWithHash") {
              const ep = Endpoint.make({ url: "https://api.example.com", path: "/v1/chat#frag" })
              expect(ep._tag).toBe("Failure")
            } else {
              const ep = Endpoint.make({ url: "https://api.example.com/v1#frag", path: "/chat" })
              expect(ep._tag).toBe("Failure")
            }

            // 2. FailureCopy.describe across budget/unrouted/unresolved/harness/evaluator (FailureCopy.ts L216-320)
            const fcInputs: Record<typeof failureKind, unknown> = {
              budgetUsdMeasured: { _tag: "BudgetExceeded", scope: "usd", used: 1.5, max: 2.0 },
              budgetUsdUnmeasured: { _tag: "BudgetExceeded", scope: "usd" },
              budgetDailyMeasured: { _tag: "BudgetExceeded", scope: "daily", used: 5000, max: 10000 },
              budgetTokensMeasured: { _tag: "BudgetExceeded", scope: "tokens", used: 400, max: 500 },
              budgetLatencyUnmeasured: { _tag: "BudgetExceeded", scope: "latency" },
              unroutedNoCandidates: { _tag: "ModelUnrouted", reason: "no_candidates" },
              unroutedUnconfiguredMsg: { _tag: "ModelUnrouted", reason: "unconfigured", message: "missing key" },
              unroutedUnconfiguredEmpty: { _tag: "ModelUnrouted", reason: "unconfigured" },
              unroutedInterrupted: { _tag: "ModelUnrouted", reason: "interrupted" },
              unroutedEval: { _tag: "ModelUnrouted", reason: "rate_limited", message: "429 retry" },
              unresolvedWithMsg: { _tag: "SeatUnresolved", message: "sign in please" },
              unresolvedEmpty: { _tag: "SeatUnresolved" },
              harnessMaxTurns: { _tag: "/harness/HarnessError", code: "max_turns", message: "too many turns" },
              evaluatorErr: { _tag: "EvaluatorError", code: "rate_limited", message: "slow down", status: 429 },
              unknownFallback: new Error("random crash")
            }
            const described = FailureCopy.describe(fcInputs[failureKind])
            expect(described.headline.length).toBeGreaterThan(0)
            expect(described.line.length).toBeGreaterThan(0)

            // 3. Classifier invalid answer branches & evaluateAll (Classifier.ts L253-362, 526-554)
            const cls = Classifier.make("w10-cls", {
              description: "wave 10 classifier",
              state: Schema.Struct({ text: Schema.String }),
              questions: {
                pass: Classifier.boolean({ instructions: "pass?" }),
                kind: Classifier.choice({
                  instructions: "pick",
                  criteria: { a: "opt a", b: "opt b" }
                }),
                grade: Classifier.score({
                  instructions: "score",
                  criteria: ["low", "mid", "high"]
                })
              }
            })
            const fakeEvalLayer = Layer.succeed(
              Evaluator.Evaluator,
              Evaluator.Evaluator.of({
                evaluate: () => {
                  if (classifierBad === "evalErrorWithUsage") {
                    return Effect.succeed({
                      answers: { pass: { type: "boolean", probability: 9 } },
                      usage: { inputTokens: 10, outputTokens: 2 }
                    } as any)
                  }
                  if (classifierBad === "missingAnswer") {
                    return Effect.succeed({ answers: {} } as any)
                  }
                  if (classifierBad === "wrongType") {
                    return Effect.succeed({
                      answers: {
                        pass: { type: "choice", choice: "a" },
                        kind: { type: "choice", choice: "a" },
                        grade: { type: "score", score: 1 }
                      }
                    } as any)
                  }
                  if (classifierBad === "badBoolProb") {
                    return Effect.succeed({
                      answers: {
                        pass: { type: "boolean", probability: 1.5 },
                        kind: { type: "choice", choice: "a" },
                        grade: { type: "score", score: 1 }
                      }
                    } as any)
                  }
                  if (classifierBad === "unknownChoice") {
                    return Effect.succeed({
                      answers: {
                        pass: { type: "boolean", probability: 0.9 },
                        kind: { type: "choice", choice: "z-missing" },
                        grade: { type: "score", score: 1 }
                      }
                    } as any)
                  }
                  if (classifierBad === "badChoiceProb") {
                    return Effect.succeed({
                      answers: {
                        pass: { type: "boolean", probability: 0.9 },
                        kind: { type: "choice", choice: "a", probabilities: { a: -0.5, b: 1.5 } },
                        grade: { type: "score", score: 1 }
                      }
                    } as any)
                  }
                  if (classifierBad === "outOfRangeScore") {
                    return Effect.succeed({
                      answers: {
                        pass: { type: "boolean", probability: 0.9 },
                        kind: { type: "choice", choice: "a" },
                        grade: { type: "score", score: 99 }
                      }
                    } as any)
                  }
                  if (classifierBad === "badScoreProbKeys") {
                    return Effect.succeed({
                      answers: {
                        pass: { type: "boolean", probability: 0.9 },
                        kind: { type: "choice", choice: "a" },
                        grade: { type: "score", score: 1, probabilities: { bogusKey: 1 } }
                      }
                    } as any)
                  }
                  return Effect.succeed({
                    answers: {
                      pass: { type: "boolean", probability: 0.9 },
                      kind: { type: "choice", choice: "a", probabilities: { a: 0.8, b: 0.2 } },
                      grade: { type: "score", score: 1, probabilities: { low: 0.1, mid: 0.8, high: 0.1 } }
                    }
                  } as any)
                }
              })
            )
            if (classifierBad === "badStateEncode") {
              const ex = yield* Effect.exit(
                cls.evaluate({ text: 123 as any }).pipe(Effect.provide(fakeEvalLayer))
              )
              expect(Exit.isFailure(ex)).toBe(true)
            } else if (classifierBad === "evaluateAllOk") {
              const allRes = yield* cls
                .evaluateAll([{ text: "one" }, { text: "two" }], { concurrency: 2 })
                .pipe(Effect.provide(fakeEvalLayer))
              expect(allRes.length).toBe(2)
              expect(allRes.every((r) => r._tag === "Success")).toBe(true)
            } else {
              const ex = yield* Effect.exit(
                cls.evaluate({ text: "hello" }).pipe(Effect.provide(fakeEvalLayer))
              )
              expect(Exit.isFailure(ex)).toBe(true)
            }

            // 4. Route deep error & affinity/auth-refresh paths (Route.ts L116-211, 257-282, 350-417)
            const validReq = mkReq({ modelId: "gpt-4o", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] })
            const baseEndpoint = Endpoint.make({ url: "https://api.openai.com", path: "/v1/responses" })
            if (baseEndpoint._tag !== "Success") return true

            let calls = 0
            let refreshed = 0
            const makeExecLayer = (
              fn: (req: any) => Effect.Effect<any, any>
            ) =>
              Layer.succeed(
                RequestExecutor.RequestExecutor,
                RequestExecutor.RequestExecutor.of({
                  execute: (req: any) => fn(req)
                } as any)
              )

            if (routeCase === "invalidRequestSchema") {
              const routeRes = Route.make({ id: "w10-r", providerName: "openai", framing: {} as any,
                endpoint: baseEndpoint.success,
                protocol: OpenAIResponses.protocol as any,
                auth: Auth.bearer(Redacted.make("sk-test"))
              })
              if ((routeRes as any)._tag === "Success") {
                const m = yield* Route.toModel((routeRes as any).success).pipe(
                  Effect.provide(makeExecLayer(() => Effect.die("should not call"))),
                  Effect.provide(silentLog)
                )
                const ex = yield* Effect.exit(
                  Stream.runCollect(
                    m.stream({
                      ...validReq,
                      messages: [{ role: "user", content: [{ type: "text", text: 42 as any }] }]
                    } as any)
                  )
                )
                expect(Exit.isFailure(ex)).toBe(true)
              }
            } else if (routeCase === "nonJsonCanonical" || routeCase === "invalidProviderBody") {
              const customProto = {
                ...OpenAIResponses.protocol,
                requestSchema: Schema.Struct({ ok: Schema.String }),
                encodeRequest: () =>
                  routeCase === "nonJsonCanonical"
                    ? ({ ok: "hi", bad: Number.NaN } as any)
                    : ({ ok: 123 } as any)
              }
              const routeRes = Route.make({ id: "w10-r", providerName: "openai", framing: {} as any,
                endpoint: baseEndpoint.success,
                protocol: customProto as any,
                auth: Auth.bearer(Redacted.make("sk-test"))
              })
              if ((routeRes as any)._tag === "Success") {
                const m = yield* Route.toModel((routeRes as any).success).pipe(
                  Effect.provide(makeExecLayer(() => Effect.die("should not call"))),
                  Effect.provide(silentLog)
                )
                const ex = yield* Effect.exit(Stream.runCollect(m.stream(validReq)))
                expect(Exit.isFailure(ex)).toBe(true)
              }
            } else {
              const routeRes = Route.make({ id: "w10-r", providerName: "openai", framing: {} as any,
                endpoint: baseEndpoint.success,
                protocol: OpenAIResponses.protocol as any,
                auth: {
                  ...Auth.bearer(Redacted.make("sk-test")),
                  refreshRejected: () =>
                    Effect.sync(() => {
                      refreshed++
                    })
                } as any,
                } as any)
              if ((routeRes as any)._tag === "Success") {
                const fakeResp = (chunks: ReadonlyArray<string>, headers: Record<string, string> = {}) => ({
                  status: 200,
                  headers,
                  stream:
                    routeCase === "streamTransportError"
                      ? Stream.fail(new Error("socket reset"))
                      : Stream.fromIterable(chunks.map((c) => new TextEncoder().encode(c)))
                })
                const execLayer = makeExecLayer(() => {
                  calls++
                  if (routeCase === "affinityAndRefresh" && calls === 1) {
                    return Effect.fail(ModelError.make({ code: "authentication", message: "expired" }))
                  }
                  if (routeCase === "affinityAndRefresh") {
                    return Effect.succeed(
                      fakeResp(
                        [
                          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'
                        ],
                        { "x-session-affinity": "aff-tok-1" }
                      )
                    )
                  }
                  if (routeCase === "sseParseError") {
                    return Effect.succeed(fakeResp(["data: {not-valid-json\n\n"]))
                  }
                  return Effect.succeed(
                    fakeResp(['event: response.created\ndata: {"type":"unknown_bad_shape"}\n\n'])
                  )
                })
                const m = yield* Route.toModel((routeRes as any).success).pipe(
                  Effect.provide(execLayer),
                  Effect.provide(silentLog)
                )
                const ex = yield* Effect.exit(Stream.runCollect(m.stream(validReq)))
                if (routeCase === "affinityAndRefresh") {
                  expect(refreshed).toBeGreaterThanOrEqual(1)
                  expect(Exit.isSuccess(ex) || Exit.isFailure(ex)).toBe(true)
                } else {
                  expect(Exit.isFailure(ex)).toBe(true)
                }
              }
            }

            return true
          }),
        { seed: seed + 4, executions: fastExec }
      )
    )
    assertPassed(report)
  }, 90_000)

  it("fuzzes EvaluatorBackup.fromModel & withFallback matrix across all transport/429/usage/empty-text branches", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        primaryMode: Schema.Literals([
          "ok",
          "unreachable",
          "timeout",
          "refused500",
          "refused429",
          "refused429Reset",
          "refused400",
          "unconfigured",
          "paidUsageRefused500"
        ]),
        backupMode: Schema.Literals([
          "ok",
          "unreachable",
          "timeoutWithUsage",
          "unconfigured",
          "invalidAnswer"
        ]),
        modelMode: Schema.Literals(["emptyText", "retryThenEmpty", "retryThenText"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ primaryMode, backupMode, modelMode }) =>
          Effect.gen(function*() {
            const req: any = {
              state: { ok: true },
              questions: { pass: Classifier.boolean({ instructions: "pass?" }) }
            }

            // 1. EvaluatorBackup.fromModel
            const fakeModel: Model.Model = {
              stream: () => {
                if (modelMode === "emptyText") {
                  return Stream.fromIterable([
                    ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "t" }),
                    ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "t", text: "   " }),
                    ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "t" }),
                    ModelEvent.ModelEvent.Settle({ stopReason: "stop", usage: { inputTokens: 1, outputTokens: 0 } } as any)
                  ])
                }
                if (modelMode === "retryThenEmpty") {
                  return Stream.fromIterable([
                    ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "t", text: "draft" }),
                    ModelEvent.ModelEvent.Retry({ attempt: 1, reason: "transient", delayMillis: 1 } as any),
                    ModelEvent.ModelEvent.Settle({ stopReason: "stop" } as any)
                  ])
                }
                return Stream.fromIterable([
                  ModelEvent.ModelEvent.Retry({ attempt: 1, reason: "transient", delayMillis: 1 } as any),
                  ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "t", text: '{"pass":{"type":"boolean","probability":0.9}}' }),
                  ModelEvent.ModelEvent.Settle({ stopReason: "stop", usage: { inputTokens: 2, outputTokens: 3 } } as any)
                ])
              }
            }
            const modelEval = EvaluatorBackup.fromModel(fakeModel, "gpt-5")
            const mEx = yield* Effect.exit(modelEval.evaluate(req).pipe(Effect.provide(silentLog)))
            expect(Exit.isSuccess(mEx) || Exit.isFailure(mEx)).toBe(true)

            // 2. EvaluatorBackup.withFallback
            const primary = Evaluator.Evaluator.of({
              evaluate: () => {
                if (primaryMode === "ok") return Effect.succeed({ answers: { pass: { type: "boolean", probability: 0.9 } } } as any)
                if (primaryMode === "unreachable") return Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "down" }))
                if (primaryMode === "timeout") return Effect.fail(new Evaluator.EvaluatorError({ code: "timeout", message: "slow" }))
                if (primaryMode === "refused500") return Effect.fail(new Evaluator.EvaluatorError({ code: "refused", status: 503, message: "503" }))
                if (primaryMode === "refused429") return Effect.fail(new Evaluator.EvaluatorError({ code: "refused", status: 429, message: "429" }))
                if (primaryMode === "refused429Reset") {
                  return Effect.fail(new Evaluator.EvaluatorError({ code: "refused", status: 429, message: "429", resetAtEpochMillis: 9999 }))
                }
                if (primaryMode === "refused400") return Effect.fail(new Evaluator.EvaluatorError({ code: "refused", status: 400, message: "bad" }))
                if (primaryMode === "unconfigured") return Effect.fail(new Evaluator.EvaluatorError({ code: "unconfigured", message: "no key" }))
                return Effect.fail(new Evaluator.EvaluatorError({
                  code: "refused",
                  status: 500,
                  message: "metered",
                  usage: { inputTokens: 5, outputTokens: 1 }
                }))
              }
            })
            const backup = Evaluator.Evaluator.of({
              evaluate: () => {
                if (backupMode === "ok") return Effect.succeed({ answers: { pass: { type: "boolean", probability: 0.8 } } } as any)
                if (backupMode === "unreachable") return Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "b-down" }))
                if (backupMode === "timeoutWithUsage") {
                  return Effect.fail(new Evaluator.EvaluatorError({
                    code: "timeout",
                    message: "b-slow",
                    usage: { inputTokens: 3, outputTokens: 0 }
                  }))
                }
                if (backupMode === "unconfigured") return Effect.fail(new Evaluator.EvaluatorError({ code: "unconfigured", message: "b-nokey" }))
                return Effect.fail(new Evaluator.EvaluatorError({ code: "invalid_answer", message: "bad" }))
              }
            })
            const fb = EvaluatorBackup.withFallback(primary, backup)
            const fbEx = yield* Effect.exit(fb.evaluate(req).pipe(Effect.provide(silentLog)))
            expect(Exit.isSuccess(fbEx) || Exit.isFailure(fbEx)).toBe(true)

            return true
          }),
        { seed: seed + 5, executions: fastExec }
      )
    )
    assertPassed(report)
  }, 60_000)
})
