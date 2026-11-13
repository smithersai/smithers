import { Effect, Exit, Fiber } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as Request from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as TestClock from "effect/testing/TestClock"
import { describe, expect, it } from "vitest"
import { ModelError } from "../src/ModelError.ts"
import * as RequestExecutor from "../src/RequestExecutor.ts"

const settle = Effect.gen(function*() {
  for (let round = 0; round < 8; round += 1) yield* Effect.yieldNow
})

const sent = Request.post("https://provider.test/v1/chat/completions")
const options = { modelId: "test-model" }

// The injected HTTP service returns real response bodies that never reach EOF.
const stalledBody = (prefix?: string) => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix !== undefined) controller.enqueue(new TextEncoder().encode(prefix))
    },
    cancel() {
      cancelled = true
    }
  })
  return { stream, cancelled: () => cancelled }
}

describe("failed response body deadline", () => {
  it.each(
    [
      [400, "invalid_request"],
      [401, "authentication"],
      [429, "rate_limited"],
      [503, "provider_internal"]
    ] as const
  )("classifies HTTP %s with no body after five seconds", async (status, code) => {
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const body = stalledBody()
        const client = HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(
            request,
            new Response(body.stream, { status, headers: { "retry-after": "2" } })
          ))
        )
        const executor = yield* RequestExecutor.makeWith(RequestExecutor.fixed(client), {
          maxRetries: 0,
          responseStartMs: 0
        })
        const fiber = yield* executor.execute(sent, options).pipe(Effect.flip, Effect.forkChild)
        yield* TestClock.adjust(4_999)
        expect(fiber.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust(1)
        yield* settle
        const result = fiber.pollUnsafe()
        if (result === undefined) yield* Fiber.interrupt(fiber)
        expect(result).toBeDefined()
        if (result === undefined || !Exit.isSuccess(result) || !(result.value instanceof ModelError)) {
          throw new Error("Expected an HTTP failure")
        }
        expect(result.value).toMatchObject({ code, httpStatus: status, retryAfterMillis: 2_000 })
        expect(result.value.body).toBeUndefined()
        expect(body.cancelled()).toBe(true)
      })).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
      )
    )
  })

  it("keeps and redacts partial diagnostics when the body stalls", async () => {
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const prefix = JSON.stringify({ error: { code: "quota_exceeded", message: "echoed private-key" } })
        const body = stalledBody(prefix)
        const client = HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(
            request,
            new Response(body.stream, { status: 429 })
          ))
        )
        const executor = yield* RequestExecutor.makeWith(RequestExecutor.fixed(client), { maxRetries: 0 })
        const fiber = yield* executor.execute(
          Request.setHeader(sent, "authorization", "Bearer private-key"),
          options
        ).pipe(Effect.flip, Effect.forkChild)
        yield* TestClock.adjust(5_000)
        yield* settle
        const result = fiber.pollUnsafe()
        if (result === undefined) yield* Fiber.interrupt(fiber)
        expect(result).toBeDefined()
        if (result === undefined || !Exit.isSuccess(result) || !(result.value instanceof ModelError)) {
          throw new Error("Expected an HTTP failure")
        }
        expect(result.value).toMatchObject({ code: "quota_exceeded", httpStatus: 429, providerCode: "quota_exceeded" })
        expect(result.value.body).toContain("quota_exceeded")
        expect(result.value.body).not.toContain("private-key")
        expect(result.value.message).not.toContain("private-key")
        expect(body.cancelled()).toBe(true)
      })).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
      )
    )
  })

  it("retries the status failure after abandoning a stalled body", async () => {
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const body = stalledBody("unavailable")
        let attempts = 0
        const client = HttpClient.make((request) =>
          Effect.sync(() => {
            attempts += 1
            return HttpClientResponse.fromWeb(
              request,
              attempts === 1
                ? new Response(body.stream, { status: 503 })
                : new Response("ok")
            )
          })
        )
        const executor = yield* RequestExecutor.makeWith(RequestExecutor.fixed(client), { maxRetries: 1 })
        const fiber = yield* executor.execute(sent, options).pipe(Effect.forkChild)
        yield* TestClock.adjust(5_000)
        yield* TestClock.adjust(10_000)
        yield* settle
        const result = fiber.pollUnsafe()
        if (result === undefined) yield* Fiber.interrupt(fiber)
        expect(result).toBeDefined()
        if (result === undefined || !Exit.isSuccess(result)) throw new Error("Expected the retry to answer")
        expect(result.value.status).toBe(200)
        expect(attempts).toBe(2)
        expect(body.cancelled()).toBe(true)
      })).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
      )
    )
  })

  it("preserves cancellation while an error body is pending", async () => {
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const body = stalledBody()
        const client = HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(
            request,
            new Response(body.stream, { status: 503 })
          ))
        )
        const executor = yield* RequestExecutor.makeWith(RequestExecutor.fixed(client))
        const fiber = yield* executor.execute(sent, options).pipe(Effect.forkChild)
        yield* settle
        yield* Fiber.interrupt(fiber)
        const result = yield* Fiber.await(fiber)
        expect(Exit.hasInterrupts(result)).toBe(true)
        expect(body.cancelled()).toBe(true)
      })).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true)
      )
    )
  })
})
