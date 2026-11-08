import { Deferred, Effect } from "effect"
import { TestClock } from "effect/testing"
import { expect, test } from "vitest"
import { SearchNotAnswered } from "./api"
import { earlySearch } from "./earlySearch"

test("a refused early read expires, rapid input cancels old reads, and blank input sends nothing", async () => {
  const requests: string[] = []
  let ask!: (owner: string, name: string, q: string) => void
  // Faulty service: every real consumer receives the same server refusal; the test clock drives only lifetime.
  const refused = (_owner: string, _name: string, q: string) => Effect.sync(() => requests.push(q)).pipe(
    Effect.andThen(Effect.fail(new SearchNotAnswered({ status: 403 }))),
  )
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const read = yield* earlySearch(refused, { bind: (request) => { ask = request; return () => {} } })
    ask("acme", "app", "old")
    yield* TestClock.adjust(50)
    ask("acme", "app", "latest")
    yield* TestClock.adjust(149)
    expect(requests).toEqual([])
    yield* TestClock.adjust(1)
    expect(requests).toEqual(["latest"])
    yield* TestClock.adjust("15 seconds")
    expect(yield* Effect.result(read("acme", "app", "latest"))).toMatchObject({ _tag: "Failure", failure: { status: 403 } })
    expect(requests).toEqual(["latest", "latest"])
    ask("acme", "app", "discarded")
    ask("acme", "app", " ")
    yield* TestClock.adjust("16 seconds")
    expect(requests).toEqual(["latest", "latest"])
  }).pipe(Effect.provide(TestClock.layer()))))
})

test("a superseded query cannot start after slow cancellation; expiry does not repeat a consumed read", async () => {
  const requests: string[] = []
  let ask!: (owner: string, name: string, q: string) => void
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const stopping = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    // Faulty transport holds cancellation, as a slow response-body finalizer may. No substitute happy-path answer.
    const refused = (_owner: string, _name: string, q: string) => Effect.gen(function* () {
      requests.push(q)
      if (q === "old") yield* Effect.never.pipe(Effect.onInterrupt(() =>
        Deferred.succeed(stopping, undefined).pipe(Effect.andThen(Deferred.await(release)))))
      return yield* Effect.fail(new SearchNotAnswered({ status: 503 }))
    })
    const read = yield* earlySearch(refused, { bind: request => { ask = request; return () => {} } })
    ask("acme", "app", "old")
    yield* TestClock.adjust(150)
    ask("acme", "app", "middle")
    yield* Deferred.await(stopping)
    ask("acme", "app", "latest")
    yield* TestClock.adjust(150)
    yield* Deferred.succeed(release, undefined)
    yield* Effect.yieldNow
    expect(requests).toEqual(["old", "latest"])
    expect(yield* Effect.result(read("acme", "app", "latest"))).toMatchObject({ _tag: "Failure", failure: { status: 503 } })
    yield* TestClock.adjust("16 seconds")
    expect(requests).toEqual(["old", "latest"])
  }).pipe(Effect.provide(TestClock.layer()))))
})
