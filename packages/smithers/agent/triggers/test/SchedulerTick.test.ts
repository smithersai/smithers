import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Result from "effect/Result"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Scheduler from "../src/Scheduler.ts"
import * as TestTriggers from "../src/test/TestTriggers.ts"
import type { Trigger } from "../src/Trigger.ts"
import { TriggerError } from "../src/TriggerError.ts"
import * as TriggerStore from "../src/TriggerStore.ts"

const minute = 60 * 1_000
const hour = 60 * minute

const hourly = (overrides: Partial<Trigger> = {}): Trigger => ({
  id: "hourly",
  flowId: "flow",
  input: { source: "schedule" },
  cron: "0 * * * *",
  timezone: "UTC",
  overlap: "skip",
  catchUp: "none",
  maxCatchUp: 0,
  enabled: true,
  ...overrides
})

interface Runs {
  readonly service: Scheduler.RunnerService
  readonly starts: Array<Scheduler.StartInput>
  readonly active: Set<string>
}

/** A runtime that deduplicates by idempotency key, as a durable one must. */
const runs = (start: (key: string) => Effect.Effect<void, TriggerError> = () => Effect.void): Runs => {
  const starts: Array<Scheduler.StartInput> = []
  const active = new Set<string>()
  return {
    starts,
    active,
    service: Scheduler.makeRunner({
      start: (input) =>
        Effect.suspend(() => {
          starts.push(input)
          return start(input.idempotencyKey).pipe(
            Effect.map(() => {
              active.add(input.idempotencyKey)
              return input.idempotencyKey
            })
          )
        }),
      inspect: (runId) => Effect.sync(() => active.has(runId) ? "active" : "completed"),
      cancel: (runId) => Effect.sync(() => void active.delete(runId))
    })
  }
}

const tick = (runner: Runs, options?: Scheduler.TickOptions) =>
  Scheduler.tick(options).pipe(Effect.provideService(Scheduler.Runner, runner.service))

const outcomes = (store: TriggerStore.Service) =>
  Effect.map(
    store.history({ triggerId: "hourly" }),
    (page) => page.items.map((fire) => [fire.occurrence, fire.outcome]).reverse()
  )

const run = <A, E>(effect: Effect.Effect<A, E, TriggerStore.TriggerStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestTriggers.layer), Effect.provide(TestClock.layer())))

describe("Scheduler.tick", () => {
  // A host with no process between ticks builds a scheduler for each one. The
  // watermark lived only in memory, so such a host never fired a trigger that
  // had not fired before, and closing its scope cut the launch off.
  it("fires the boundary passed since the last tick and records the launch before it returns", async () => {
    const runner = runs()
    const seen = await run(Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      yield* store.register(hourly())
      yield* TestClock.setTime(30 * minute)
      const first = yield* tick(runner)
      const startsAfterFirst = runner.starts.length
      yield* TestClock.setTime(hour + 1_000)
      const second = yield* tick(runner, { since: first.watermark })
      return {
        first,
        second,
        startsAfterFirst,
        active: yield* store.activeRun("hourly"),
        outcomes: yield* outcomes(store)
      }
    }))
    expect(seen.first).toEqual({ at: 30 * minute, watermark: 30 * minute })
    expect(seen.startsAfterFirst).toBe(0)
    expect(seen.second).toEqual({ at: hour + 1_000, watermark: hour + 1_000 })
    expect(runner.starts.map((start) => start.idempotencyKey)).toEqual(["hourly:1970-01-01T01:00:00.000Z"])
    expect(seen.active).toMatchObject({ _tag: "Some", value: "hourly:1970-01-01T01:00:00.000Z" })
    expect(seen.outcomes).toEqual([[hour, "launched"]])
  })

  it("settles the run an earlier tick launched and applies the overlap policy across ticks", async () => {
    const runner = runs()
    const seen = await run(Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      yield* store.register(hourly())
      yield* TestClock.setTime(30 * minute)
      let watermark = (yield* tick(runner)).watermark
      for (const now of [hour + 1_000, 2 * hour + 1_000]) {
        yield* TestClock.setTime(now)
        watermark = (yield* tick(runner, { since: watermark })).watermark
      }
      const overlapped = yield* outcomes(store)
      runner.active.clear()
      yield* TestClock.setTime(2 * hour + minute)
      yield* tick(runner, { since: watermark })
      return { overlapped, settled: yield* outcomes(store), active: yield* store.activeRun("hourly") }
    }))
    expect(seen.overlapped).toEqual([[hour, "launched"], [2 * hour, "skipped"]])
    expect(seen.settled).toEqual([[hour, "completed"], [2 * hour, "skipped"]])
    expect(seen.active).toMatchObject({ _tag: "None" })
    expect(runner.starts).toHaveLength(1)
  })

  it("starts from the last recorded fire when it is later than since", async () => {
    const runner = runs()
    await run(Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      yield* store.register(hourly({ catchUp: "all", maxCatchUp: 5 }))
      yield* TestClock.setTime(30 * minute)
      yield* tick(runner)
      yield* TestClock.setTime(hour + 1_000)
      yield* tick(runner, { since: 30 * minute })
      runner.active.clear()
      yield* TestClock.setTime(hour + 2_000)
      yield* tick(runner, { since: 30 * minute })
    }))
    expect(runner.starts).toHaveLength(1)
  })

  it("waits for a slow start, so closing the tick's scope cuts no launch off", async () => {
    const runner = runs(() => Effect.sleep("10 seconds"))
    const seen = await run(Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      yield* store.register(hourly())
      yield* TestClock.setTime(hour + 1_000)
      const fiber = yield* Effect.forkChild(tick(runner, { since: 30 * minute }))
      for (let n = 0; n < 20; n++) yield* Effect.yieldNow
      const early = fiber.pollUnsafe() !== undefined
      yield* TestClock.adjust("10 seconds")
      yield* Fiber.join(fiber)
      return { early, outcomes: yield* outcomes(store) }
    }))
    expect(seen.early).toBe(false)
    expect(seen.outcomes).toEqual([[hour, "launched"]])
  })

  it("keeps the occurrence pending when a start outlives startTimeout, and the next tick retries the same key", async () => {
    let stuck = true
    const runner = runs(() => stuck ? Effect.never : Effect.void)
    const seen = await run(Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      yield* store.register(hourly())
      yield* TestClock.setTime(hour + 1_000)
      const fiber = yield* Effect.forkChild(tick(runner, { since: 30 * minute, startTimeout: "5 seconds" }))
      for (let n = 0; n < 20; n++) yield* Effect.yieldNow
      yield* TestClock.adjust("5 seconds")
      const first = yield* Fiber.join(fiber)
      stuck = false
      yield* TestClock.setTime(hour + minute)
      yield* tick(runner, { since: first.watermark })
      return { first, outcomes: yield* outcomes(store) }
    }))
    expect(runner.starts.map((start) => start.idempotencyKey)).toEqual([
      "hourly:1970-01-01T01:00:00.000Z",
      "hourly:1970-01-01T01:00:00.000Z"
    ])
    expect(seen.outcomes.at(-1)).toEqual([hour, "launched"])
  })

  it("does not advance the watermark past a trigger whose dispatch failed", async () => {
    const runner = runs()
    let failing = true
    const seen = await run(Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      yield* store.register(hourly())
      const flaky = TriggerStore.TriggerStore.of({
        ...store,
        claimFire: (fire) =>
          failing ? Effect.fail(new TriggerError({ code: "store", message: "claim failed" })) : store.claimFire(fire)
      })
      const ticked = (options?: Scheduler.TickOptions) =>
        tick(runner, options).pipe(Effect.provideService(TriggerStore.TriggerStore, flaky))
      yield* TestClock.setTime(hour + 1_000)
      const failed = yield* ticked({ since: 30 * minute })
      const startsAfterFailure = runner.starts.length
      failing = false
      yield* TestClock.setTime(hour + 2_000)
      const retried = yield* ticked({ since: failed.watermark })
      return { failed, retried, startsAfterFailure }
    }))
    expect(seen.failed).toEqual({ at: hour + 1_000, watermark: 30 * minute })
    expect(seen.startsAfterFailure).toBe(0)
    expect(seen.retried).toEqual({ at: hour + 2_000, watermark: hour + 2_000 })
    expect(runner.starts).toHaveLength(1)
  })

  it("answers its own instant as the watermark when a first tick meets a row it cannot decode", async () => {
    const runner = runs()
    const ticked = await run(Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      const corrupt = TriggerStore.TriggerStore.of({
        ...store,
        list: () =>
          Effect.succeed([{
            triggerId: "corrupt",
            trigger: Result.fail(new TriggerError({ code: "store", message: "could not decode trigger row corrupt" }))
          }])
      })
      yield* TestClock.setTime(hour)
      const first = yield* tick(runner).pipe(Effect.provideService(TriggerStore.TriggerStore, corrupt))
      yield* TestClock.setTime(2 * hour)
      const second = yield* tick(runner, { since: first.watermark }).pipe(
        Effect.provideService(TriggerStore.TriggerStore, corrupt)
      )
      return { first, second }
    }))
    expect(ticked.first).toEqual({ at: hour, watermark: hour })
    expect(ticked.second).toEqual({ at: 2 * hour, watermark: hour })
  })

  it("prunes the fire ledger only on a first tick or when an hour boundary passed since the last one", async () => {
    const pruned: Array<number> = []
    const runner = runs()
    await run(Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      const counting = TriggerStore.TriggerStore.of({
        ...store,
        pruneFires: (options) =>
          Effect.sync(() => pruned.push(options.olderThan)).pipe(Effect.andThen(store.pruneFires(options)))
      })
      const ticked = (options?: Scheduler.TickOptions) =>
        tick(runner, { ...options, fireRetention: "1 hour" }).pipe(
          Effect.provideService(TriggerStore.TriggerStore, counting)
        )
      yield* TestClock.setTime(10 * hour + minute)
      yield* ticked()
      yield* TestClock.setTime(10 * hour + 2 * minute)
      yield* ticked({ since: 10 * hour + minute })
      yield* TestClock.setTime(11 * hour + minute)
      yield* ticked({ since: 10 * hour + 59 * minute })
    }))
    expect(pruned).toEqual([9 * hour + minute, 10 * hour + minute])
  })

  it("refuses a since that is not a safe integer", async () => {
    const refused = await run(Effect.flip(tick(runs(), { since: Number.NaN })))
    expect(refused).toMatchObject({ code: "invalid_options", path: "since" })
  })
})
