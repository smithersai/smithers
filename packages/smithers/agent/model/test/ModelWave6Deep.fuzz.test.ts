import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Redacted, Result, Schema, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import * as Auth from "../src/Auth.ts"
import * as Endpoint from "../src/Endpoint.ts"
import * as FailureCopy from "../src/FailureCopy.ts"
import { ModelError, ModelErrorCode } from "../src/ModelError.ts"
import * as Request from "../src/ModelRequest.ts"
import * as OpenAIChatGPT from "../src/OpenAIChatGPT.ts"
import * as OpenAIResponses from "../src/OpenAIResponses.ts"
import * as RequestExecutor from "../src/RequestExecutor.ts"
import * as Route from "../src/Route.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const sampleRequest = (modelId: string, withTools: boolean, narrow = false): Request.ModelRequest =>
  Request.ModelRequest.make({
    modelId,
    system: [{ type: "text", text: "You are a concise verifier." }],
    messages: [
      { role: "user", content: [{ type: "text", text: "Hello world" }] },
      ...(withTools
        ? [
            {
              role: "assistant" as const,
              stopReason: "tool-calls" as const,
              content: [
                Request.TextPart.make({ text: "Checking..." }),
                Request.ThinkingPart.make({ text: "reasoning step" }),
                Request.ToolCallPart.make({ id: "call_1", name: "read", arguments: "{\"path\":\"a.ts\"}" })
              ]
            },
            {
              role: "tool" as const,
              content: [Request.ToolResultPart.make({ toolCallId: "call_1", content: "ok" })]
            }
          ]
        : [])
    ],
    tools: withTools
      ? [
          {
            name: "read",
            description: "Read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
          }
        ]
      : [],
    params: narrow ? Request.GenerationParams.make({}) : Request.GenerationParams.make({ maxTokens: 256, temperature: 0.2 })
  })

describe("@smthrs/model Wave 6 deep fuzz (OpenAIResponses, OpenAIChatGPT, Route, RequestExecutor, FailureCopy, Endpoint)", () => {
  it("OpenAIResponses.protocol and chatgptProtocol lower requests, step SSE frames, handle onHalt, and classify HTTP errors", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        useChatGpt: Schema.Boolean,
        withTools: Schema.Boolean,
        scenario: Schema.Literals(["textAndUsage", "toolCall", "reasoning", "refusal", "incomplete", "failed", "streamError"]),
        errStatus: Schema.Literals([400, 401, 403, 404, 413, 429, 500, 502, 503, 529])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ useChatGpt, withTools, scenario, errStatus }) =>
          Effect.gen(function*() {
            const proto = useChatGpt ? OpenAIResponses.chatgptProtocol : OpenAIResponses.protocol
            const req = sampleRequest("gpt-5.4", withTools, useChatGpt)
            const encoded = yield* proto.body.from(req, { native: true }).pipe(Effect.exit)
            expect(Exit.isSuccess(encoded)).toBe(true)

            const classified = proto.classifyError(
              errStatus,
              JSON.stringify({
                error: { message: `err ${errStatus}`, code: errStatus === 413 ? "context_length_exceeded" : "api_error" }
              })
            )
            expect(classified).toBeInstanceOf(ModelError)

            const framePayloads: Array<string> =
              scenario === "textAndUsage"
                ? [
                    JSON.stringify({ type: "response.created", response: { id: "resp_1", model: "gpt-5.4" } }),
                    JSON.stringify({ type: "response.output_text.delta", item_id: "m1", delta: "hi " }),
                    JSON.stringify({ type: "response.output_text.delta", item_id: "m1", delta: "there" }),
                    JSON.stringify({
                      type: "response.completed",
                      response: {
                        id: "resp_1",
                        status: "completed",
                        usage: {
                          input_tokens: 12,
                          output_tokens: 5,
                          input_tokens_details: { cached_tokens: 4 },
                          output_tokens_details: { reasoning_tokens: 0 }
                        }
                      }
                    })
                  ]
                : scenario === "toolCall"
                  ? [
                      JSON.stringify({
                        type: "response.output_item.added",
                        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read" }
                      }),
                      JSON.stringify({
                        type: "response.function_call_arguments.delta",
                        item_id: "fc_1",
                        delta: "{\"path\":\"a.ts\"}"
                      }),
                      JSON.stringify({
                        type: "response.function_call_arguments.done",
                        item_id: "fc_1",
                        arguments: "{\"path\":\"a.ts\"}"
                      }),
                      JSON.stringify({ type: "response.completed", response: { id: "resp_2", status: "completed" } })
                    ]
                  : scenario === "reasoning"
                    ? [
                        JSON.stringify({ type: "response.reasoning_summary_text.delta", item_id: "r1", delta: "thinking..." }),
                        JSON.stringify({ type: "response.output_text.delta", item_id: "m1", delta: "answer" }),
                        JSON.stringify({ type: "response.completed", response: { id: "resp_3", status: "completed" } })
                      ]
                    : scenario === "refusal"
                      ? [
                          JSON.stringify({ type: "response.refusal.delta", item_id: "m1", delta: "cannot comply" }),
                          JSON.stringify({ type: "response.completed", response: { id: "resp_4", status: "completed" } })
                        ]
                      : scenario === "incomplete"
                        ? [
                            JSON.stringify({ type: "response.output_text.delta", item_id: "m1", delta: "cut" }),
                            JSON.stringify({
                              type: "response.incomplete",
                              response: { id: "resp_5", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }
                            })
                          ]
                        : scenario === "failed"
                          ? [
                              JSON.stringify({
                                type: "response.failed",
                                response: { id: "resp_6", status: "failed", error: { code: "server_error", message: "boom" } }
                              })
                            ]
                          : [
                              JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded", message: "slow down" } })
                            ]

            let state = proto.stream.initial(req)
            const events: Array<unknown> = []
            for (const raw of framePayloads) {
              const decoded = yield* Schema.decodeUnknownEffect(proto.stream.event)(raw).pipe(Effect.exit)
              if (Exit.isFailure(decoded)) continue
              const stepped = yield* proto.stream.step(state, decoded.value as never).pipe(Effect.exit)
              if (Exit.isFailure(stepped)) {
                expect(scenario === "failed" || scenario === "streamError").toBe(true)
                break
              }
              state = stepped.value[0]
              events.push(...stepped.value[1])
            }
            if (proto.stream.onHalt !== undefined) {
              expect(Array.isArray(proto.stream.onHalt(state))).toBe(true)
            }
            expect(Array.isArray(events)).toBe(true)
            return true
          }),
        { executions: Math.min(executions, 90), seed }
      )
    )
    assertPassed(report)
  })

  it("Route constructors, OpenAIChatGPT.make, Endpoint.makeSecure, and RequestExecutor execute streaming and retry/error classification paths", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        routeKind: Schema.Literals(["anthropic", "openai", "openaiRespCompat", "openaiChatCompat", "chatgpt"]),
        status: Schema.Literals([200, 400, 401, 429, 500, 503]),
        badUrl: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ routeKind, status, badUrl }) =>
          Effect.gen(function*() {
            const key = Redacted.make("sk-test-secret-token-123456")
            const baseUrl = badUrl ? "http://insecure.example.com" : "https://api.example.com"
            const built: Result.Result<Route.Route<any, any, any, any>, ModelError> =
              routeKind === "anthropic"
                ? Route.anthropic({ apiKey: key, baseUrl })
                : routeKind === "openai"
                  ? Route.openai({ apiKey: key, baseUrl })
                  : routeKind === "openaiRespCompat"
                    ? Route.openaiResponsesCompatible({ id: "compat-r", providerName: "compat", apiKey: key, baseUrl })
                    : routeKind === "openaiChatCompat"
                      ? Route.openaiChatCompatible({ id: "compat-c", providerName: "compat", apiKey: key, baseUrl })
                      : OpenAIChatGPT.make({ auth: Auth.bearer(key), baseUrl })

            if (badUrl) {
              expect(Result.isFailure(built)).toBe(true)
              return true
            }
            expect(Result.isSuccess(built)).toBe(true)
            if (Result.isFailure(built)) return true
            const route = built.success

            const req = sampleRequest("gpt-5.4", false, routeKind === "chatgpt")
            const prepared = yield* Route.prepare(route, req).pipe(Effect.exit)
            expect(Exit.isSuccess(prepared)).toBe(true)

            let attempts = 0
            const fakeHttp = HttpClient.make((httpReq) =>
              Effect.sync(() => {
                attempts++
                if (status === 200 || (status >= 500 && attempts >= 2)) {
                  const sseBody =
                    routeKind === "anthropic"
                      ? `event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":5,"output_tokens":0}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`
                      : routeKind === "openaiChatCompat"
                        ? `data: {"id":"c1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`
                        : `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"m1","delta":"ok"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed"}}\n\n`
                  return HttpClientResponse.fromWeb(
                    httpReq,
                    new Response(sseBody, { status: 200, headers: { "content-type": "text/event-stream" } })
                  )
                }
                return HttpClientResponse.fromWeb(
                  httpReq,
                  new Response(JSON.stringify({ error: { message: `http ${status}`, type: "api_error" } }), {
                    status,
                    headers: status === 429 ? { "retry-after": "0" } : {}
                  })
                )
              })
            )

            const executor = yield* RequestExecutor.makeWith(RequestExecutor.fixed(fakeHttp), {
              maxRetries: 1,
              responseStartMs: 5_000
            })
            const model = yield* Route.toModel(route).pipe(
              Effect.provideService(RequestExecutor.RequestExecutor, executor)
            )
            const collected = yield* Stream.runCollect(model.stream(req)).pipe(Effect.exit)
            if (status === 200 || status >= 500) {
              expect(Exit.isSuccess(collected)).toBe(true)
            } else {
              expect(Exit.isFailure(collected)).toBe(true)
            }

            const ep = Endpoint.makeSecure({ url: "https://api.example.com", path: "/v1/responses" })
            expect(Result.isSuccess(ep)).toBe(true)
            return true
          }),
        { executions: Math.min(executions, 45), seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("FailureCopy.describe and provider classify every ModelErrorCode, HTTP status, seat, and unknown fault", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        code: ModelErrorCode,
        seat: Schema.Literals(["none", "anthropic:claude", "openai:gpt-5.4", "openai-chatgpt:codex", "google:gemini", "custom"]),
        status: Schema.Literals([0, 400, 401, 403, 408, 413, 429, 500, 502, 503, 529]),
        rawErr: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ code, seat, status, rawErr }) =>
          Effect.sync(() => {
            const seatOpt = seat === "none" ? undefined : seat
            const prov = FailureCopy.provider(seatOpt)
            expect(prov.length).toBeGreaterThan(0)
            const input = rawErr
              ? new Error(`boom ${code} status=${status}`)
              : new ModelError({
                  code,
                  message: `provider failed (${code})`,
                  ...(status !== 0 ? { httpStatus: status } : {})
                })
            const desc = FailureCopy.describe(input, seatOpt)
            expect(desc.headline.length).toBeGreaterThan(0)
            expect(desc.line.length).toBeGreaterThan(0)
            expect(Array.isArray(desc.actions)).toBe(true)
            return true
          }),
        { executions: Math.min(executions, 120), seed: seed + 2 }
      )
    )
    assertPassed(report)
  })
})
