import { HttpClient as KernelHttpClient } from "@smthrs/kernel"
import { Effect, Layer, Redacted, Result, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import { classifyHttpStatus } from "../src/HttpStatusClassifier.ts"
import * as ModelRequest from "../src/ModelRequest.vibe"
import * as RequestExecutor from "../src/RequestExecutor.vibe"
import * as Route from "../src/Route.vibe"

const request = ModelRequest.ModelRequest.make({
  modelId: "test-model",
  system: [],
  messages: [],
  tools: [],
  params: ModelRequest.GenerationParams.make({ maxTokens: 100 })
})
const apiKey = Redacted.make("test-secret")
const routes = [
  ["anthropic", Route.toModel(Result.getOrThrow(Route.anthropic({ apiKey })))],
  ["responses", Route.toModel(Result.getOrThrow(Route.openai({ apiKey })))],
  [
    "chat",
    Route.toModel(
      Result.getOrThrow(
        Route.openaiChatCompatible({ id: "chat", providerName: "openai", baseUrl: "https://example.test", apiKey })
      )
    )
  ]
] as const

// 2026-10-15 ~02:19:22Z: two agent attempts failed `AGENT_QUOTA_EXCEEDED` within
// the same second while their account was at a quarter of its session budget.
// Neither failure was a refusal: the text each one carried was the work itself,
// a worker snapshot function and a journey report about a transaction fallback,
// read by a matcher that ran over whatever output a failed attempt left behind.
// This is that text's shape, and nothing in it is a provider's verdict.
const report = "Rather than weaken #3959 classification, the fallback itself was made safe: " +
  "a sequence conflict (SQLSTATE 23505) retries up to 10 attempts, so the quota exceeded " +
  "and usage limit branches stay as they were (workerAnswerCode)."

for (const [name, toModel] of routes) {
  describe(name, () => {
    const errorFor = async (status: number, body: string) => {
      let attempts = 0
      const client = HttpClient.make((sent) => {
        attempts += 1
        return Effect.succeed(HttpClientResponse.fromWeb(
          sent,
          new Response(body, {
            status,
            headers: { "retry-after-ms": "0" }
          })
        ))
      })
      const error = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const model = yield* toModel
            return yield* model.stream(request).pipe(Stream.runDrain, Effect.flip)
          }).pipe(
            Effect.provide(RequestExecutor.layer),
            Effect.provide(Layer.succeed(KernelHttpClient.HttpClient)(client)),
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
          )
        )
      )
      return { error, attempts }
    }

    it("keeps an opaque safety-maintenance 503 retryable through the route", async () => {
      const { error } = await errorFor(503, "Service unavailable during safety maintenance")
      expect(error).toMatchObject({ code: "provider_internal", httpStatus: 503, retryable: true })
    })

    it.each(["", "{}", JSON.stringify({ error: { message: "Insufficient credits" } })])(
      "classifies bare HTTP 402 as terminal quota: %s",
      async (body) => {
        const { error, attempts } = await errorFor(402, body)
        expect(error).toMatchObject({ code: "quota_exceeded", httpStatus: 402, retryable: false })
        expect(attempts).toBe(1)
      }
    )

    it("preserves hosted out_of_credit as a terminal typed model code", async () => {
      const body = JSON.stringify({ status: "error", code: "out_of_credit", message: "Out of credit." })
      const { error, attempts } = await errorFor(402, body)
      expect(error).toMatchObject({
        _tag: "flows/model/ModelError",
        code: "out_of_credit",
        providerCode: "out_of_credit",
        httpStatus: 402,
        retryable: false
      })
      expect(attempts).toBe(1)
    })

    it.each(
      [
        [400, "invalid_request"],
        [401, "authentication"],
        [403, "authentication"],
        [404, "invalid_request"],
        [409, "invalid_request"],
        [413, "invalid_request"],
        [418, "unknown"],
        [422, "invalid_request"],
        [429, "rate_limited"],
        [500, "provider_internal"],
        [503, "provider_internal"],
        [504, "provider_internal"],
        [529, name === "anthropic" ? "rate_limited" : "provider_internal"]
      ] as const
    )("classifies HTTP %i as %s", async (status, code) => {
      const { error } = await errorFor(status, "{}")
      expect(error).toMatchObject({ code, httpStatus: status })
    })

    it("recognizes incorrect API key wording independently of HTTP status", async () => {
      const { error } = await errorFor(418, JSON.stringify({ error: { message: "Incorrect API key provided" } }))
      expect(error).toMatchObject({ code: "authentication", httpStatus: 418 })
    })

    // The protocol classifies the envelope and answers `unknown` when a body
    // carries none; the executor then reads the body itself. A limit found
    // there would be terminal (`retryable: false`), so a failed call that
    // quotes a report would end the run instead of being retried.
    it("reads no limit out of an unclassified body's own prose", async () => {
      const { error } = await errorFor(418, report)
      expect(error).toMatchObject({ code: "unknown", httpStatus: 418, retryable: false })
    })

    it("still fails over on a limit the provider's own envelope names", async () => {
      const limited = await errorFor(418, JSON.stringify({ error: { code: "insufficient_quota", message: report } }))
      expect(limited.error).toMatchObject({ code: "quota_exceeded", httpStatus: 418, retryable: false })
      const throttled = await errorFor(
        418,
        JSON.stringify({ error: { type: "rate_limit_error", message: "You have hit your usage limit." } })
      )
      expect(throttled.error).toMatchObject({ code: "rate_limited", httpStatus: 418, retryable: true })
    })
  })
}

describe("in-stream failures", () => {
  // A `response.failed` or `error` event arrives after HTTP 200, so only the
  // provider's code and words classify it. These are transient provider
  // faults and must stay retryable.
  it.each(
    [
      [undefined, "Our servers are currently overloaded. Please try again later."],
      ["server_is_overloaded", "The server is overloaded"],
      ["overloaded_error", "Overloaded"],
      [undefined, "Service unavailable"]
    ] as const
  )("classifies %s / %s as provider_internal", (code, message) => {
    expect(classifyHttpStatus(undefined, code, message, "provider")).toBe("provider_internal")
  })

  it("leaves unrelated stream failures unknown", () => {
    expect(classifyHttpStatus(undefined, undefined, "OpenAI Responses stream failed", "provider")).toBe("unknown")
  })
})

describe("an answer that quotes a limit", () => {
  // The words that ended those two attempts were an agent's own answer. An
  // answer is content: it streams through to the caller, and the only thing
  // that classifies is a failure.
  it("completes the call, classifying nothing", async () => {
    const stream = [
      { id: "chatcmpl-1", choices: [{ index: 0, delta: { role: "assistant", content: report }, finish_reason: null }] },
      { id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n"
    const client = HttpClient.make((sent) =>
      Effect.succeed(HttpClientResponse.fromWeb(
        sent,
        new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })
      ))
    )
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const model = yield* Route.toModel(
            Result.getOrThrow(
              Route.openaiChatCompatible({
                id: "chat",
                providerName: "openai",
                baseUrl: "https://example.test",
                apiKey
              })
            )
          )
          return Array.from(yield* Stream.runCollect(model.stream(request)))
        }).pipe(
          Effect.provide(RequestExecutor.layer),
          Effect.provide(Layer.succeed(KernelHttpClient.HttpClient)(client)),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
        )
      )
    )
    expect(events).toContainEqual(expect.objectContaining({ type: "text-delta", text: report }))
    expect(events).toContainEqual(expect.objectContaining({ type: "settle", stopReason: "stop" }))
  })
})

describe("limits in opaque text", () => {
  it.each(
    [
      [500, "provider_internal"],
      [400, "invalid_request"],
      [418, "unknown"]
    ] as const
  )("leaves an opaque HTTP %i body that quotes a limit as %s", (status, code) => {
    expect(classifyHttpStatus(status, undefined, report, "opaque")).toBe(code)
  })

  it("keeps the statuses that name a limit themselves", () => {
    expect(classifyHttpStatus(429, undefined, report, "opaque")).toBe("rate_limited")
    expect(classifyHttpStatus(402, undefined, "", "opaque")).toBe("quota_exceeded")
  })

  it("classifies the same words when the provider's own fields carry them", () => {
    expect(classifyHttpStatus(418, undefined, report, "provider")).toBe("quota_exceeded")
    expect(classifyHttpStatus(undefined, "insufficient_quota", "No credits remain.", "provider"))
      .toBe("quota_exceeded")
    expect(classifyHttpStatus(undefined, "rate_limit_error", "You have hit your usage limit.", "provider"))
      .toBe("rate_limited")
  })

  // A gateway naming a content filter or an overflowing request is reporting
  // its own verdict, and reading it wrong costs a retry rather than the run.
  it("keeps reading the classes an opaque body reports about the call itself", () => {
    expect(classifyHttpStatus(400, undefined, "blocked by content_filter", "opaque")).toBe("content_policy")
    expect(classifyHttpStatus(400, undefined, "maximum context length is 200000 tokens", "opaque"))
      .toBe("context_overflow")
    expect(classifyHttpStatus(500, undefined, "Service unavailable", "opaque")).toBe("provider_internal")
    expect(classifyHttpStatus(418, undefined, "Incorrect API key provided", "opaque")).toBe("authentication")
  })
})

describe("opaque safety prose", () => {
  it("keeps an opaque 503 retryable when its page mentions safety", () => {
    expect(classifyHttpStatus(503, undefined, "Service unavailable during safety maintenance", "opaque"))
      .toBe("provider_internal")
    expect(classifyHttpStatus(503, "content_filter", "Blocked for safety", "provider"))
      .toBe("content_policy")
  })
})
