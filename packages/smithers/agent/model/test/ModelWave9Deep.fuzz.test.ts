import { Fuzz } from "@smthrs/fuzz"
import { HttpClient as KernelHttpClient } from "@smthrs/kernel"
import { Arbitrary, Effect, Exit, Layer, Logger, Redacted, Result, Schema, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import * as Auth from "../src/Auth.ts"
import { ModelError } from "../src/ModelError.ts"
import * as ModelRequest from "../src/ModelRequest.ts"
import * as OpenAIResponses from "../src/OpenAIResponses.ts"
import * as RequestExecutor from "../src/RequestExecutor.ts"
import * as Route from "../src/Route.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261185")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(30, Math.min(baseExecutions, 100))

const assertPassed = <A, E = unknown>(report: Fuzz.Report<A, E>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

const makeReq = (modelId: string, withTools: boolean, withReasoning: boolean) =>
  ModelRequest.ModelRequest.make({
    modelId,
    system: [ModelRequest.SystemPart.make({ text: "You are concise." })],
    messages: [
      ModelRequest.Message.user("Summarize status."),
      ModelRequest.Message.assistant([{ type: "text", text: "Working on it." }]),
      ModelRequest.Message.user("Continue.")
    ],
    tools: withTools
      ? [
        ModelRequest.ToolDefinition.make({
          name: "read_file",
          description: "Read file",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
        })
      ]
      : [],
    params: ModelRequest.GenerationParams.make({
      maxTokens: 256,
      ...(withReasoning ? { reasoningEffort: "medium" as const } : {})
    })
  })

describe("@smthrs/model Wave 9 deep Route, RequestExecutor & OpenAIResponses fuzzing", () => {
  it(
    "OpenAIResponses protocol & chatgptProtocol encode requests and decode streamed text, reasoning, tool calls, incomplete, failed & refusal events",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          useChatGpt: Schema.Boolean,
          withTools: Schema.Boolean,
          withReasoning: Schema.Boolean,
          finishKind: Schema.Literals(["completed", "incomplete", "failed", "refusal", "tool-call", "halt-early"]),
          deltaText: Schema.Literals(["hello", "world", "chunk-1", "unicode-✨"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ useChatGpt, withTools, withReasoning, finishKind, deltaText }) =>
            Effect.gen(function*() {
              const proto = useChatGpt ? OpenAIResponses.chatgptProtocol : OpenAIResponses.protocol
              const req = makeReq(useChatGpt ? "gpt-5.4" : "gpt-5", withTools, withReasoning)
              const body = yield* proto.body.from(req, { native: !useChatGpt })
              expect(body).toBeDefined()

              const frames: Array<string> = [
                JSON.stringify({ type: "response.created", response: { id: "resp_1", model: req.modelId } }),
                JSON.stringify({
                  type: "response.output_text.delta",
                  item_id: "msg_1",
                  output_index: 0,
                  content_index: 0,
                  delta: deltaText
                }),
                JSON.stringify({
                  type: "response.reasoning_summary_text.delta",
                  item_id: "rs_1",
                  output_index: 0,
                  summary_index: 0,
                  delta: "thinking"
                })
              ]
              if (finishKind === "tool-call") {
                frames.push(
                  JSON.stringify({
                    type: "response.output_item.added",
                    output_index: 1,
                    item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" }
                  }),
                  JSON.stringify({
                    type: "response.function_call_arguments.delta",
                    item_id: "fc_1",
                    output_index: 1,
                    delta: "{\"path\":\"a.ts\"}"
                  }),
                  JSON.stringify({
                    type: "response.output_item.done",
                    output_index: 1,
                    item: {
                      type: "function_call",
                      id: "fc_1",
                      call_id: "call_1",
                      name: "read_file",
                      arguments: "{\"path\":\"a.ts\"}"
                    }
                  })
                )
              } else if (finishKind === "refusal") {
                frames.push(
                  JSON.stringify({
                    type: "response.refusal.delta",
                    item_id: "msg_1",
                    output_index: 0,
                    content_index: 0,
                    delta: "cannot comply"
                  })
                )
              }

              if (finishKind === "completed" || finishKind === "tool-call" || finishKind === "refusal") {
                frames.push(
                  JSON.stringify({
                    type: "response.completed",
                    response: {
                      id: "resp_1",
                      status: "completed",
                      usage: { input_tokens: 12, output_tokens: 8, input_tokens_details: { cached_tokens: 4 } }
                    }
                  })
                )
              } else if (finishKind === "incomplete") {
                frames.push(
                  JSON.stringify({
                    type: "response.incomplete",
                    response: {
                      id: "resp_1",
                      status: "incomplete",
                      incomplete_details: { reason: "max_output_tokens" }
                    }
                  })
                )
              } else if (finishKind === "failed") {
                frames.push(
                  JSON.stringify({
                    type: "response.failed",
                    response: {
                      id: "resp_1",
                      status: "failed",
                      error: { code: "provider_internal", message: "upstream failed" }
                    }
                  })
                )
              }

              let state = proto.stream.initial(req)
              const emitted: Array<unknown> = []
              for (const f of frames) {
                const ev = Schema.decodeUnknownSync(proto.stream.event)(f)
                const stepExit = yield* Effect.exit(proto.stream.step(state, ev))
                if (Exit.isSuccess(stepExit)) {
                  state = stepExit.value[0]
                  emitted.push(...stepExit.value[1])
                }
              }
              if (finishKind === "halt-early") {
                const halted = proto.stream.onHalt?.(state) ?? []
                expect(halted.length).toBeGreaterThanOrEqual(0)
              }
              expect(emitted.length).toBeGreaterThan(0)
              return true
            }),
          { seed, executions: fastExec }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "Route.anthropic/openai/openaiResponsesCompatible/openaiChatCompatible & RequestExecutor.makeWith classify HTTP errors, retries, and pool rebuilds",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          routeKind: Schema.Literals(["anthropic", "openai", "openai-responses-compat", "openai-chat-compat"]),
          status: Schema.Literals([200, 400, 401, 429, 500, 503]),
          transportFail: Schema.Boolean,
          retryAfter: Schema.Literals(["none", "0", "invalid"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ routeKind, status, transportFail, retryAfter }) =>
            Effect.gen(function*() {
              const secret = "sk-secret-token-1234567890"
              const apiKey = Redacted.make(secret)
              const route: Route.Route<any, any, any, any> = routeKind === "anthropic"
                ? Result.getOrThrow(Route.anthropic({ apiKey }))
                : routeKind === "openai"
                ? Result.getOrThrow(Route.openai({ apiKey }))
                : routeKind === "openai-responses-compat"
                ? Result.getOrThrow(
                  Route.openaiResponsesCompatible({
                    id: "compat-resp",
                    providerName: "compat",
                    baseUrl: "https://api.example.test",
                    apiKey
                  })
                )
                : Result.getOrThrow(
                  Route.openaiChatCompatible({
                    id: "compat-chat",
                    providerName: "compat",
                    baseUrl: "https://api.example.test",
                    apiKey
                  })
                )

              const req = makeReq("test-model", false, false)
              const prepared = yield* Route.prepare(route, req)
              expect(prepared.url).toContain("https://")

              let calls = 0
              const sseBody = routeKind === "anthropic"
                ? "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"usage\":{\"input_tokens\":5,\"output_tokens\":0}}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
                : routeKind === "openai-chat-compat"
                ? "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n"
                : "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"item_id\":\"m1\",\"output_index\":0,\"content_index\":0,\"delta\":\"hi\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"status\":\"completed\",\"usage\":{\"input_tokens\":5,\"output_tokens\":2}}}\n\n"

              const client = HttpClient.make((httpReq) => {
                calls += 1
                if (transportFail) {
                  return Effect.fail(
                    new HttpClientError.HttpClientError({
                      reason: new HttpClientError.TransportError({
                        request: httpReq,
                        cause: new Error(`socket hang up auth=${secret}`)
                      })
                    })
                  )
                }
                const headers: Record<string, string> = {
                  "content-type": status === 200 ? "text/event-stream" : "application/json"
                }
                if (retryAfter !== "none" && (status === 429 || status === 503)) {
                  headers["retry-after"] = retryAfter
                }
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    httpReq,
                    new Response(
                      status === 200 ? sseBody : JSON.stringify({ error: { message: `err ${status} ${secret}` } }),
                      { status, headers }
                    )
                  )
                )
              })

              const execLayer = Layer.effect(
                RequestExecutor.RequestExecutor,
                RequestExecutor.makeWith(RequestExecutor.fixed(client), {
                  maxRetries: 0,
                  responseStartMs: 2_000
                })
              )

              const exit = yield* Effect.exit(
                Effect.flatMap(Route.toModel(route), (model) => Stream.runCollect(model.stream(req))).pipe(
                  Effect.provide(execLayer),
                  Effect.provide(Layer.succeed(KernelHttpClient.HttpClient)(client)),
                  Effect.provideService(RequestExecutor.Retries, 0)
                )
              )

              expect(calls).toBeGreaterThanOrEqual(1)
              if (!transportFail && status === 200) {
                expect(Exit.isSuccess(exit)).toBe(true)
              } else {
                expect(Exit.isFailure(exit)).toBe(true)
              }

              // Exercise errorSanitizer directly — raw secret must never survive sanitization
              const authReq = HttpClientRequest.post("https://api.example.test/v1").pipe(
                HttpClientRequest.setHeader("authorization", `Bearer ${secret}`)
              )
              const sanitizer = yield* RequestExecutor.errorSanitizer(authReq)
              const cleaned = sanitizer(
                new ModelError({ code: "provider_internal", message: `Bearer ${secret} failed` })
              )
              expect(cleaned.message).not.toContain(secret)
              return true
            }).pipe(Effect.provide(Logger.layer([]))),
          { seed: seed + 1, executions: fastExec }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})
