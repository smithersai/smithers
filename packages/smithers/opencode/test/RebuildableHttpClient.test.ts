import { Capability } from "@smthrs/capability/Capability"
import { PermissionDenied } from "@smthrs/capability/Permission"
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import { Deferred, Effect, Fiber } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import * as RebuildableHttpClient from "../src/internal/rebuildableHttpClient.ts"

const request = HttpClientRequest.get("https://example.test")
const broken = new HttpClientError.HttpClientError({
  reason: new HttpClientError.TransportError({ request, cause: new Error("session destroyed") })
})
const response = (status = 200) => HttpClientResponse.fromWeb(request, new Response("ok", { status }))

describe("RebuildableHttpClient", () => {
  it("replaces once for concurrent failures and ignores late failures from the discarded pool", async () => {
    const acquired: Array<number> = []
    const closed: Array<number> = []
    await Effect.runPromise(
      Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const acquire = Effect.gen(function*() {
          const pool = acquired.length
          acquired.push(pool)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed.push(pool)
            })
          )
          return HttpClient.make((wire) =>
            pool === 0
              ? (wire.url.endsWith("/late")
                ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
                : Effect.void).pipe(Effect.andThen(Effect.fail(broken)))
              : Effect.succeed(response())
          )
        })
        const client = yield* RebuildableHttpClient.make(acquire)
        const late = yield* client.get("https://example.test/late").pipe(Effect.result, Effect.forkChild)
        yield* Deferred.await(started)
        expect(yield* Effect.flip(client.execute(request))).toBe(broken)
        expect(acquired).toEqual([0])
        const answers = yield* Effect.all([client.execute(request), client.execute(request)], { concurrency: 2 })
        expect(answers.map((answer) => answer.status)).toEqual([200, 200])
        expect(acquired).toEqual([0, 1])
        expect(closed).toEqual([0])
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(late)
        yield* client.execute(request)
        expect(acquired).toEqual([0, 1])
      }).pipe(Effect.scoped)
    )
    expect(closed).toEqual([0, 1])
  })

  it("keeps pools for HTTP statuses, request errors, and structured permission refusals", async () => {
    const denied = KernelHttpClient.toHttpClientError({
      request,
      error: new PermissionDenied({
        code: "permission_denied",
        capability: new Capability({ action: "net:get", resource: "example.test" }),
        reason: "outside capability ceiling"
      })
    })
    const invalid = new HttpClientError.HttpClientError({
      reason: new HttpClientError.InvalidUrlError({ request })
    })
    let pools = 0
    let calls = 0
    await Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* RebuildableHttpClient.make(Effect.sync(() => {
          pools += 1
          return HttpClient.make(() => {
            calls += 1
            if (calls === 1) return Effect.fail(denied)
            if (calls === 2) return Effect.fail(invalid)
            return Effect.succeed(response(calls === 3 ? 503 : 200))
          })
        }))
        expect(yield* Effect.flip(client.execute(request))).toBe(denied)
        expect(yield* Effect.flip(client.execute(request))).toBe(invalid)
        expect((yield* client.execute(request)).status).toBe(503)
        expect((yield* client.execute(request)).status).toBe(200)
        expect(pools).toBe(1)
      }).pipe(Effect.scoped)
    )
  })

  it("releases each failed generation and the last pool on interruption", async () => {
    const closed: Array<number> = []
    let pools = 0
    await Effect.runPromise(Effect.gen(function*() {
      const waiting = yield* Deferred.make<void>()
      const work = yield* Effect.gen(function*() {
        const client = yield* RebuildableHttpClient.make(Effect.gen(function*() {
          const pool = pools++
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed.push(pool)
            })
          )
          return HttpClient.make(() => Effect.fail(broken))
        }))
        for (let i = 0; i < 3; i++) yield* Effect.flip(client.execute(request))
        yield* Deferred.succeed(waiting, undefined)
        yield* Effect.never
      }).pipe(Effect.scoped, Effect.forkChild)
      yield* Deferred.await(waiting)
      expect(closed).toEqual([0, 1])
      yield* Fiber.interrupt(work)
    }))
    expect(closed).toEqual([0, 1, 2])
  })
})
