import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Layer, Redacted, Result, Schema, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import * as Classifier from "../src/Classifier.ts"
import * as Endpoint from "../src/Endpoint.ts"
import * as FailureCopy from "../src/FailureCopy.ts"
import * as Model from "../src/Model.ts"
import * as ModelError from "../src/ModelError.ts"
import * as RequestExecutor from "../src/RequestExecutor.ts"
import * as Route from "../src/Route.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261129")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/model Wave 7 deep fuzz (FailureCopy, Endpoint, Model.makeNoop/withGenAiSpan, Route + RequestExecutor, Classifier)", () => {
  it(
    "FailureCopy.describe & provider classify every ModelErrorCode, status, retryAfterMs, plain Error, and non-Error across seats",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          code: Schema.Literals([
            "invalid_request",
            "context_overflow",
            "no_route",
            "authentication",
            "rate_limited",
            "quota_exceeded",
            "out_of_credit",
            "content_policy",
            "provider_internal",
            "transport",
            "call_timeout",
            "invalid_provider_output",
            "unknown",
            "plainError",
            "stringError"
          ]),
          seat: Schema.Literals([
            "anthropic:claude-sonnet-4-5",
            "openai:gpt-5",
            "google:gemini-2.5-pro",
            "chatgpt:gpt-5",
            "openrouter:foo/bar",
            "custom-seat",
            ""
          ]),
          status: Schema.Literals([0, 400, 401, 403, 429, 500, 529]),
          retryAfterMs: Schema.Literals([0, 5000, 60_000])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ code, seat, status, retryAfterMs }) =>
            Effect.sync(() => {
              const seatArg = seat === "" ? undefined : seat
              expect(typeof FailureCopy.provider(seatArg)).toBe("string")

              const err: unknown = code === "plainError"
                ? new Error("unexpected boom")
                : code === "stringError"
                ? "bare failure"
                : new ModelError.ModelError({
                  code,
                  message: `msg:${code}`,
                  ...(status > 0 ? { httpStatus: status } : {}),
                  ...(retryAfterMs > 0 ? { retryAfterMs } : {})
                })

              const desc = FailureCopy.describe(err, seatArg)
              expect(desc.headline.length).toBeGreaterThan(0)
              expect(desc.fault.length).toBeGreaterThan(0)
              expect(Array.isArray(desc.actions)).toBe(true)
              return true
            }),
          { executions: Math.min(executions, 140), seed }
        )
      )
      assertPassed(report)
    },
    45_000
  )

  it(
    "Endpoint.make/makeSecure/render/proxyOrigin/providerOrigin enforce HTTPS, loopback, traversal, credential-query, and proxy env invariants",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          url: Schema.Literals([
            "https://api.anthropic.com",
            "https://api.openai.com",
            "http://127.0.0.1:8080",
            "http://localhost:3000",
            "http://example.com",
            "ftp://bad.example.com",
            "not a url",
            "https://user:pass@api.openai.com"
          ]),
          path: Schema.Literals([
            "/v1/messages",
            "/v1/responses",
            "/v1/../escape",
            "/v1/%2e%2e/escape",
            "relative/path"
          ]),
          queryKey: Schema.Literals(["", "api_key", "key", "sig", "version"]),
          provider: Schema.Literals(["anthropic", "openai", "chatgpt", "openrouter"]),
          proxyEnv: Schema.Literals(["none", "https://proxy.example.com", "http://127.0.0.1:9000", "invalid://bad"]),
          proxyProviders: Schema.Literals(["", "anthropic,openai", "all", "google"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ url, path, queryKey, provider, proxyEnv, proxyProviders }) =>
            Effect.sync(() => {
              const opts = {
                url,
                path,
                ...(queryKey !== "" ? { query: { [queryKey]: "val" } } : {})
              }
              const r1 = Endpoint.make(opts)
              const r2 = Endpoint.makeSecure(opts)
              if (Result.isSuccess(r1)) {
                expect(Endpoint.render(r1.success).length).toBeGreaterThan(0)
              }
              if (
                url === "http://example.com" ||
                url === "ftp://bad.example.com" ||
                url === "not a url" ||
                url.includes("user:pass") ||
                path.includes("..") ||
                path.includes("%2e") ||
                queryKey === "api_key" ||
                queryKey === "key" ||
                queryKey === "sig"
              ) {
                expect(Result.isFailure(r2)).toBe(true)
              }
              const env: Record<string, string | undefined> = {
                ...(proxyEnv !== "none" ? { [Endpoint.modelProxyVariable]: proxyEnv } : {}),
                ...(proxyProviders !== "" ? { [Endpoint.modelProxyProvidersVariable]: proxyProviders } : {})
              }
              Endpoint.proxyOrigin(provider, env)
              expect(typeof Endpoint.providerOrigin(provider, env)).toBe("string")
              return true
            }),
          { executions: Math.min(executions, 140), seed: seed + 1 }
        )
      )
      assertPassed(report)
    },
    45_000
  )

  it(
    "Route.anthropic/openai/openaiResponsesCompatible/openaiChatCompatible + RequestExecutor + Model.makeNoop/withGenAiSpan + Classifier",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          routeKind: Schema.Literals(["anthropic", "openai", "openaiResponsesCompat", "openaiChatCompat"]),
          status: Schema.Literals([200, 400, 401, 429, 500, 529])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ routeKind, status }) =>
            Effect.gen(function*() {
              const noop = Model.makeNoop()
              const noopEx = yield* Stream.runCollect(
                noop.stream({
                  modelId: "test-model",
                  system: [],
                  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
                  tools: [],
                  params: {}
                })
              ).pipe(Effect.exit)
              expect(Exit.isFailure(noopEx)).toBe(true)

              const spanStream = Model.withGenAiSpan(
                {
                  modelId: "test-model",
                  system: [],
                  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
                  tools: [],
                  params: {}
                },
                "anthropic"
              )(Stream.empty)
              yield* Stream.runDrain(spanStream)

              const fakeHttp = HttpClient.make((request) =>
                Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response(
                      status === 200
                        ? routeKind === "anthropic"
                          ? "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"model\":\"claude-sonnet-4-5\",\"usage\":{\"input_tokens\":5}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
                          : routeKind === "openaiChatCompat"
                          ? "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n"
                          : "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"r1\"}}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"status\":\"completed\",\"usage\":{\"input_tokens\":3,\"output_tokens\":2}}}\n\n"
                        : JSON.stringify({ error: { message: `http ${status}`, type: "api_error" } }),
                      {
                        status,
                        headers: {
                          "content-type": status === 200 ? "text/event-stream" : "application/json",
                          ...(status === 429 ? { "retry-after": "1" } : {})
                        }
                      }
                    )
                  )
                )
              )

              const apiKey = Redacted.make("sk-test-key")
              const routeRes = routeKind === "anthropic"
                ? Route.anthropic({ apiKey, baseUrl: "http://127.0.0.1:9999" })
                : routeKind === "openai"
                ? Route.openai({ apiKey, baseUrl: "http://127.0.0.1:9999" })
                : routeKind === "openaiResponsesCompat"
                ? Route.openaiResponsesCompatible({
                  id: "custom-resp",
                  providerName: "custom-resp",
                  apiKey,
                  baseUrl: "http://127.0.0.1:9999"
                })
                : Route.openaiChatCompatible({
                  id: "custom-chat",
                  providerName: "custom-chat",
                  apiKey,
                  baseUrl: "http://127.0.0.1:9999",
                  path: "/v1/chat/completions"
                })

              const rAny = routeRes as Result.Result<unknown, ModelError.ModelError>
              expect(Result.isSuccess(rAny)).toBe(true)
              if (Result.isSuccess(rAny)) {
                const execLayer = RequestExecutor.layer.pipe(
                  Layer.provide(Layer.succeed(HttpClient.HttpClient, fakeHttp))
                )
                const model = yield* Route.toModel(rAny.success as never).pipe(Effect.provide(execLayer))
                const ex = yield* Stream.runCollect(
                  model.stream({
                    modelId: "test-model",
                    system: [],
                    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
                    tools: [],
                    params: {}
                  })
                ).pipe(Effect.exit)

                if (status === 200) {
                  expect(Exit.isSuccess(ex)).toBe(true)
                } else {
                  expect(Exit.isFailure(ex)).toBe(true)
                }
              }

              const boolAns: Classifier.Answer = { value: true, probability: 0.9 }
              expect(Classifier.confidence(boolAns)).toBeCloseTo(0.8, 6)
              expect(Classifier.confident(boolAns, 0.7)._tag).toBe("Some")
              expect(Classifier.confident(boolAns, 0.85)._tag).toBe("None")
              return true
            }),
          { executions: Math.min(executions, 45), seed: seed + 2 }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})
