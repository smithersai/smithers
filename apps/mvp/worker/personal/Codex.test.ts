import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/http"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"
import * as Codex from "./Codex.vibe"

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

describe("Codex auth goes out on the client CodexAuth names", () => {
  /** A host client whose every request fails as a dead network does, and a fetch that must never be reached. */
  const failing = () => {
    const asked: Array<string> = []
    const reached: Array<string> = []
    const client = HttpClient.make((request) => {
      asked.push(request.url)
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "the host's client is down" }),
        }),
      )
    })
    const fetch: typeof globalThis.fetch = (input) => {
      reached.push(input instanceof Request ? input.url : String(input))
      return Promise.resolve(Response.json({}))
    }
    return { client, fetch, asked, reached }
  }

  test.each(["code", "poll", "refresh"] as const)("%s fails unreachable on a failing host client, with no network", async (stage) => {
    const host = failing()
    const request: Effect.Effect<unknown, Codex.CodexAuthFailed, Codex.CodexAuth> = stage === "code" ? Codex.requestCode
      : stage === "refresh" ? Codex.refresh(credential, 0)
      : Codex.poll("device", "code", 0)
    const result = await Effect.runPromise(request.pipe(
      Effect.provideService(Codex.CodexAuth, { origin: "https://auth.example.com", clientId: "test", http: host.client }),
      Effect.provideService(FetchHttpClient.Fetch, host.fetch),
      Effect.exit,
    ))
    expect(Exit.isFailure(result) && Cause.squash(result.cause)).toMatchObject({
      _tag: "@smthrs/mvp/personal/CodexAuthFailed", reason: "unreachable", status: null,
    })
    expect(host.asked).toHaveLength(1)
    expect(host.asked[0]).toContain("https://auth.example.com/")
    expect(host.reached).toEqual([])
  })

  test("a program that names no client reaches OpenAI through the injected fetch", async () => {
    const reached: Array<string> = []
    const fetch: typeof globalThis.fetch = (input) => {
      reached.push(input instanceof Request ? input.url : String(input))
      return Promise.resolve(Response.json({ device_auth_id: "device", user_code: "ABCD-1234", interval: "7" }))
    }
    const code = await Effect.runPromise(Codex.requestCode.pipe(
      Effect.provideService(Codex.CodexAuth, { origin: "https://auth.example.com", clientId: "test" }),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ))
    expect(code).toEqual({
      deviceAuthId: "device", userCode: "ABCD-1234", intervalSeconds: 7, verificationUrl: "https://auth.example.com/codex/device",
    })
    expect(reached).toEqual(["https://auth.example.com/api/accounts/deviceauth/usercode"])
  })
})
