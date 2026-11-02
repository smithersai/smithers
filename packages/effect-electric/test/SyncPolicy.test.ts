import { Duration, Effect, Schedule } from "effect"
import { expect, test } from "vitest"
import { ShapeSource, SyncPolicy } from "../src/index.ts"

// The delays a policy waits, read step by step from the schedule.
const delays = (schedule: Schedule.Schedule<unknown>, steps: number) =>
  Effect.runPromise(Effect.gen(function*() {
    const step = yield* Schedule.toStep(schedule)
    const out: Array<number> = []
    for (let n = 0; n < steps; n++) out.push(Duration.toMillis((yield* step(0, undefined))[1]))
    return out
  }))

test("backoff doubles from initial to max, each delay jittered between 80% and 120%, and never ends", async () => {
  const waits = await delays(SyncPolicy.backoff({ initial: "100 millis", max: "1 second" }), 50)
  const ideal = [100, 200, 400, 800, ...Array.from({ length: 46 }, () => 1_000)]
  waits.forEach((wait, n) => {
    expect(wait).toBeGreaterThanOrEqual(ideal[n]! * 0.8)
    expect(wait).toBeLessThanOrEqual(ideal[n]! * 1.2)
  })
  expect(new Set(waits.slice(4)).size).toBeGreaterThan(1)
})

test("the default policy waits 1 second, doubling to 10 seconds", async () => {
  const waits = await delays(SyncPolicy.defaultPolicy, 6)
  ;[1_000, 2_000, 4_000, 8_000, 10_000, 10_000].forEach((ideal, n) => {
    expect(waits[n]).toBeGreaterThanOrEqual(ideal * 0.8)
    expect(waits[n]).toBeLessThanOrEqual(ideal * 1.2)
  })
})

// The delays a policy waits after each failure in `failures`, the schedule given each one as its input.
const delaysAfter = (
  schedule: Schedule.Schedule<unknown, ShapeSource.RequestFailed>,
  failures: ReadonlyArray<ShapeSource.RequestFailed>
) =>
  Effect.runPromise(Effect.gen(function*() {
    const step = yield* Schedule.toStep(schedule)
    const out: Array<number> = []
    for (const failure of failures) out.push(Duration.toMillis((yield* step(0, failure))[1]))
    return out
  }))

test("a failure's retry-after is the least the policy waits; without one the policy's own delay stands", async () => {
  const policy = SyncPolicy.respectingRetryAfter(Schedule.exponential("1 second"))
  const waits = await delaysAfter(policy, [
    new ShapeSource.RequestFailed({ status: 503, retryAfterMs: 5_000 }),
    new ShapeSource.RequestFailed({ status: 503, retryAfterMs: 5_000 }),
    new ShapeSource.RequestFailed({ status: 503 }),
    new ShapeSource.RequestFailed({ status: 503, retryAfterMs: 1_000 }),
    new ShapeSource.RequestFailed({})
  ])
  // The exponential policy alone waits 1, 2, 4, 8 and 16 seconds.
  expect(waits).toEqual([5_000, 5_000, 4_000, 8_000, 16_000])
})

test("the default policy waits at least a 503's retry-after, where it would retry after 1, 2 and 4 seconds", async () => {
  const policy = SyncPolicy.respectingRetryAfter(SyncPolicy.defaultPolicy)
  const waits = await delaysAfter(
    policy,
    [1, 2, 3].map(() => new ShapeSource.RequestFailed({ status: 503, retryAfterMs: 5_000 }))
  )
  waits.forEach((wait) => expect(wait).toBeGreaterThanOrEqual(5_000))
  expect(waits[2]).toBeLessThanOrEqual(5_000)
})

test("retry-after is read as delay seconds or an HTTP date, capped, and ignored when malformed", () => {
  const now = Date.parse("2026-11-02T10:00:00Z")
  expect(SyncPolicy.retryAfterMs("5", now)).toBe(5_000)
  expect(SyncPolicy.retryAfterMs(" 0 ", now)).toBe(0)
  expect(SyncPolicy.retryAfterMs("Mon, 02 Nov 2026 10:00:30 GMT", now)).toBe(30_000)
  expect(SyncPolicy.retryAfterMs("Mon, 02 Nov 2026 09:59:00 GMT", now)).toBe(0)
  expect(SyncPolicy.retryAfterMs("86400", now)).toBe(SyncPolicy.MAX_RETRY_AFTER_MS)
  for (const malformed of [null, "", "-1", "1.5", "5s", "soon"]) {
    expect(SyncPolicy.retryAfterMs(malformed, now)).toBeUndefined()
  }
})
