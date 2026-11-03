/**
 * The in-process wake bus contract: keyed delivery, edge-triggered drops,
 * and subscription cleanup on interruption — including losing the race
 * against a polling sleep, which is exactly how the engine consumes it.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { TestClock } from "effect/testing"
import * as WakeBus from "../src/WakeBus.ts"

/** Yields until the bus reports `count` waiters parked on `executionId`. */
const untilWaiters = (
  bus: WakeBus.Service,
  executionId: string,
  count: number
): Effect.Effect<void> =>
  Effect.gen(function*() {
    while ((yield* bus.waiters(executionId)) !== count) {
      yield* Effect.yieldNow
    }
  })

describe("WakeBus", () => {
  it.effect("a wake with no waiters is dropped, not queued", () =>
    Effect.gen(function*() {
      yield* (Effect.gen(function*() {
        const bus = WakeBus.makeUnsafe()
        yield* bus.wake("nobody-waits")
        // A waiter subscribing AFTER the wake stays parked: the bus is
        // edge-triggered, and the polling fallback owns the missed wake.
        const late = yield* bus.awaitWake("nobody-waits").pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* untilWaiters(bus, "nobody-waits", 1)
        yield* bus.wake("nobody-waits")
        yield* Fiber.join(late)
        expect(yield* bus.waiters("nobody-waits")).toBe(0)
      }))
    }))

  it.effect("a wake resumes every waiter for its run and no other run's", () =>
    Effect.gen(function*() {
      yield* (Effect.gen(function*() {
        const bus = WakeBus.makeUnsafe()
        const woken: Array<string> = []
        const waiter = (label: string, executionId: string) =>
          bus.awaitWake(executionId).pipe(
            Effect.andThen(Effect.sync(() => void woken.push(label))),
            Effect.forkChild({ startImmediately: true })
          )
        const first = yield* waiter("a-first", "run-a")
        const second = yield* waiter("a-second", "run-a")
        const other = yield* waiter("b", "run-b")
        yield* untilWaiters(bus, "run-a", 2)
        yield* untilWaiters(bus, "run-b", 1)

        yield* bus.wake("run-a")
        yield* Fiber.join(first)
        yield* Fiber.join(second)

        expect([...woken].sort()).toEqual(["a-first", "a-second"])
        expect(yield* bus.waiters("run-a")).toBe(0)
        expect(yield* bus.waiters("run-b")).toBe(1)
        yield* Fiber.interrupt(other)
      }))
    }))

  it.effect("interrupting a waiter removes its subscription", () =>
    Effect.gen(function*() {
      yield* (Effect.gen(function*() {
        const bus = WakeBus.makeUnsafe()
        const fiber = yield* bus.awaitWake("run-interrupted").pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* untilWaiters(bus, "run-interrupted", 1)
        yield* Fiber.interrupt(fiber)
        expect(yield* bus.waiters("run-interrupted")).toBe(0)
      }))
    }))

  it.effect("losing the race against the polling sleep leaves no subscription behind", () =>
    Effect.gen(function*() {
      // The engine's exact consumption shape: `raceFirst(sleep, awaitWake)`.
      // When the poll tick wins, the losing wait's scope closes and its
      // registration must go with it — a caller polling for hours must not
      // accumulate one dead waiter per tick.
      yield* (
        Effect.gen(function*() {
          const bus = WakeBus.makeUnsafe()
          const race = yield* Effect.raceFirst(
            Effect.sleep(Duration.millis(10)),
            bus.awaitWake("run-raced")
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* untilWaiters(bus, "run-raced", 1)
          yield* TestClock.adjust("10 millis")
          yield* Fiber.join(race)
          expect(yield* bus.waiters("run-raced")).toBe(0)
        }).pipe(Effect.provide(TestClock.layer()))
      )
    }))

  it.effect("the noop bus drops wakes and parks waiters forever", () =>
    Effect.gen(function*() {
      yield* (Effect.gen(function*() {
        const bus = WakeBus.makeNoop()
        yield* bus.wake("run-noop")
        const fiber = yield* bus.awaitWake("run-noop").pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* bus.wake("run-noop")
        yield* Effect.yieldNow
        expect(fiber.pollUnsafe()).toBeUndefined()
        expect(yield* bus.waiters("run-noop")).toBe(0)
        yield* Fiber.interrupt(fiber)
      }))
    }))
})
