import { Deferred, Effect, Logger, Metric, Option, Redacted } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { expect, test } from "vitest"
import * as Visibility from "./Visibility.ts"
import * as Metrics from "./Metrics.ts"

const repository = { id: "acme/widgets", owner: "acme", name: "widgets" }

test.each([
  [200, { private: false }, {}, "public", false, "unknown"],
  [200, { private: true }, { "x-ratelimit-remaining": "500" }, "private", false, "100+"],
  [404, {}, {}, "private", false, "unknown"],
  [410, {}, {}, "private", false, "unknown"],
  [403, {}, {}, "unavailable", false, "unknown"],
  [403, {}, { "x-ratelimit-remaining": "0" }, "unavailable", true, "0"],
  [429, {}, { "retry-after": "1" }, "unavailable", true, "unknown"],
  [403, { message: "You have exceeded a secondary rate limit" }, {}, "unavailable", true, "unknown"],
  [502, {}, { "x-ratelimit-remaining": "8" }, "unavailable", false, "1-9"],
  [200, {}, { "x-ratelimit-remaining": "42" }, "unavailable", false, "10-99"],
] as const)("records bounded diagnostics for %s %j %j", async (status, body, headers, outcome, limited, remaining) => {
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const registry: Metric.MetricRegistry = new Map()
  const http = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request,
    new Response(JSON.stringify(body), { status, headers }))))
  const result = await Effect.runPromise(Visibility.read(repository, "https://github.test", Effect.succeed(Option.some(Redacted.make("fixture-token"))), http).pipe(
    Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((options) => void logs.push(Logger.formatStructured.log(options)))])),
    Effect.provideService(Metric.MetricRegistry, registry),
  ))
  expect(result).toEqual(outcome === "unavailable" ? Option.none() : Option.some(outcome === "public"))
  const attributes = { outcome, statusClass: `${Math.floor(status / 100)}xx`, rateLimited: String(limited), remaining,
    errorCode: status === 200 ? outcome === "unavailable" ? "decode-failed" : "none" : "delivery-failed" }
  expect(logs[0]!.annotations).toMatchObject({ repoId: repository.id, ...attributes })
  expect(JSON.stringify(logs)).not.toContain("fixture-token")
  expect(Effect.runSync(Metric.value(Metric.withAttributes(Metrics.visibilityReads, attributes)).pipe(
    Effect.provideService(Metric.MetricRegistry, registry)))).toMatchObject({ count: 1 })
})

test("transport failures record a code without provider text or credentials", async () => {
  const http = HttpClient.make((request) => Effect.fail(new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, cause: "secret-provider-text" }),
  })))
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  expect(await Effect.runPromise(Visibility.read(repository, "https://github.test", Effect.succeed(Option.none()), http).pipe(
    Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((options) => void logs.push(Logger.formatStructured.log(options)))])),
  ))).toEqual(Option.none())
  expect(logs[0]!.annotations).toMatchObject({ statusClass: "none", errorCode: "delivery-failed", rateLimited: "false" })
  expect(JSON.stringify(logs)).not.toContain("secret-provider-text")
})

test.each([[undefined, "unknown"], ["no", "unknown"], ["0", "0"], ["1", "1-9"], ["9", "1-9"], ["10", "10-99"], ["99", "10-99"], ["100", "100+"]])("buckets remaining %s", (raw, expected) => {
  expect(Visibility.remainingBucket(raw)).toBe(expected)
})


test("public answers are shared through 59999ms, expire at 60s, and keep repositories separate", async () => {
  let calls = 0
  let privateRepo = false
  const http = HttpClient.make((request) => Effect.sync(() => {
    calls++
    return HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ private: privateRepo })))
  }))
  await Effect.runPromise(Effect.gen(function* () {
    const visibility = Visibility.make("https://github.test", Effect.succeed(Option.none()), http)
    expect(yield* visibility(repository)).toEqual(Option.some(true))
    yield* TestClock.adjust("59999 millis")
    privateRepo = true
    expect(yield* visibility(repository)).toEqual(Option.some(true))
    expect(calls).toBe(1)
    expect(yield* visibility({ ...repository, id: "acme/other", name: "other" })).toEqual(Option.some(false))
    expect(calls).toBe(2)
    yield* TestClock.adjust("1 millis")
    expect(yield* visibility(repository)).toEqual(Option.some(false))
    expect(calls).toBe(3)
    expect(yield* visibility(repository)).toEqual(Option.some(false))
    expect(calls).toBe(3)
    yield* TestClock.adjust("60 seconds")
    privateRepo = false
    expect(yield* visibility(repository)).toEqual(Option.some(true))
    expect(calls).toBe(4)
  }).pipe(Effect.provide(TestClock.layer())))
})

test("unavailable answers are never cached, including after a public answer expires", async () => {
  let status = 502
  let calls = 0
  const http = HttpClient.make((request) => Effect.sync(() => {
    calls++
    return HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ private: false }), { status }))
  }))
  await Effect.runPromise(Effect.gen(function* () {
    const visibility = Visibility.make("https://github.test", Effect.succeed(Option.none()), http)
    expect(yield* visibility(repository)).toEqual(Option.none())
    expect(yield* visibility(repository)).toEqual(Option.none())
    expect(calls).toBe(2)
    status = 200
    expect(yield* visibility(repository)).toEqual(Option.some(true))
    yield* TestClock.adjust("60 seconds")
    status = 503
    expect(yield* visibility(repository)).toEqual(Option.none())
    expect(yield* visibility(repository)).toEqual(Option.none())
    expect(calls).toBe(5)
  }).pipe(Effect.provide(TestClock.layer())))
})

test.each([404, 410])("a gone answer (%s) is cached as private", async (status) => {
  let calls = 0
  const http = HttpClient.make((request) => Effect.sync(() => {
    calls++
    return HttpClientResponse.fromWeb(request, new Response("{}", { status }))
  }))
  const visibility = Visibility.make("https://github.test", Effect.succeed(Option.none()), http)
  expect(await Effect.runPromise(visibility(repository))).toEqual(Option.some(false))
  expect(await Effect.runPromise(visibility(repository))).toEqual(Option.some(false))
  expect(calls).toBe(1)
})

test("concurrent misses each read GitHub without sharing in-flight work", async () => {
  let calls = 0
  await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const http = HttpClient.make((request) => Effect.gen(function* () {
      calls++
      if (calls === 2) yield* Deferred.succeed(entered, undefined)
      yield* Deferred.await(entered)
      return HttpClientResponse.fromWeb(request, new Response('{"private":false}'))
    }))
    const visibility = Visibility.make("https://github.test", Effect.succeed(Option.none()), http)
    expect(yield* Effect.all([visibility(repository), visibility(repository)], { concurrency: "unbounded" }).pipe(
      Effect.timeout("2 seconds"),
    )).toEqual([Option.some(true), Option.some(true)])
    expect(calls).toBe(2)
    expect(yield* visibility(repository)).toEqual(Option.some(true))
    expect(calls).toBe(2)
  }))
})
