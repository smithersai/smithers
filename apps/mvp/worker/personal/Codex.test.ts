import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"
import * as Codex from "./Codex.ts"

const credential: Codex.Credential = {
  accessToken: "access-before",
  refreshToken: "refresh-before",
  idToken: "",
  accountId: "",
  planType: "unknown",
  expiresAt: 0,
}

describe("Codex auth response deadline", () => {
  test.each(["code", "poll", "exchange", "refresh"] as const)(
    "%s includes a body stalled after successful headers",
    async (stage) => {
      const result = await Effect.runPromise(Effect.gen(function* () {
        const reading = yield* Deferred.make<void>()
        const fetch: typeof globalThis.fetch = async () => {
          if (stage === "exchange" && !polled) {
            polled = true
            return Response.json({ authorization_code: "approved", code_verifier: "verifier" })
          }
          const response = new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"incomplete":'))
            },
          }), { headers: { "content-type": "application/json" } })
          const consume = response.arrayBuffer.bind(response)
          response.arrayBuffer = () => {
            Effect.runSync(Deferred.succeed(reading, undefined))
            return consume()
          }
          return response
        }
        let polled = false
        const request: Effect.Effect<unknown, Codex.CodexAuthFailed, Codex.CodexAuth> = stage === "code" ? Codex.requestCode
          : stage === "refresh" ? Codex.refresh(credential, 0)
          : Codex.poll("device", "code", 0)
        const fiber = yield* Effect.forkChild(request.pipe(
          Effect.provideService(Codex.CodexAuth, { origin: "https://auth.example.com", clientId: "test" }),
          Effect.provideService(FetchHttpClient.Fetch, fetch),
        ))
        yield* Deferred.await(reading)
        yield* TestClock.adjust("29 seconds")
        expect(fiber.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust("1 second")
        yield* Effect.yieldNow
        const answer = fiber.pollUnsafe()
        yield* Fiber.interrupt(fiber)
        return answer
      }).pipe(Effect.provide(TestClock.layer())))
      expect(result).toBeDefined()
      expect(Exit.isFailure(result!)).toBe(true)
      if (result !== undefined && Exit.isFailure(result)) {
        expect(Cause.squash(result.cause)).toMatchObject({
          _tag: "@smthrs/mvp/personal/CodexAuthFailed", reason: "unreachable", status: null,
        })
      }
    },
  )
})
