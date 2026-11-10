import { Duration, Effect, Fiber } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { elapsed } from "../src/internal/deadline.vibe"

// Fake timers stand in for the platform's: the behavior under test is what
// happens after 24.8 days, which no real clock can wait for.
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const longestTimer = 2_147_483_647

/** Runs `elapsed(duration)` and reports whether it completed after each advance. */
const completedAfter = async (duration: Duration.Input, advances: ReadonlyArray<number>) => {
  const fiber = Effect.runFork(elapsed(duration))
  const seen: Array<boolean> = []
  for (const millis of advances) {
    await vi.advanceTimersByTimeAsync(millis)
    seen.push(fiber.pollUnsafe() !== undefined)
  }
  await Effect.runPromise(Fiber.interrupt(fiber))
  return seen
}

describe("elapsed", () => {
  it("completes after a short duration and not before", async () => {
    expect(await completedAfter(Duration.millis(50), [49, 1])).toEqual([false, true])
  })

  it("waits a duration longer than one platform timer holds in full", async () => {
    // Node fires an over-long timer after 1 ms, which ended a 30-day wait at once.
    const thirtyDays = Duration.toMillis(Duration.days(30))
    expect(await completedAfter(Duration.days(30), [1, longestTimer, thirtyDays - longestTimer - 2, 1]))
      .toEqual([false, false, false, true])
  })

  it("never completes an infinite duration", async () => {
    expect(await completedAfter(Duration.infinity, [1, longestTimer, longestTimer])).toEqual([false, false, false])
  })
})
