import { expect } from "@effect/vitest"
import { Effect, Logger } from "effect"

/**
 * Safety release for the stall, so a finalizer that does wait on it still
 * finishes inside the callers' 30 s test timeout and fails on the assertion
 * below instead of timing out. It sits far past the 5 s platform timer, so a
 * loaded host that delays that timer by seconds still passes.
 */
const safetyReleaseMs = 25_000

/**
 * Runs `use` with a stall that never settles on its own, then asserts that the
 * finalizer under test returned before the stall was released and warned with
 * `resource`. The bound is causal, not wall-clock: the test fails only when
 * the finalizer waited for the stall.
 */
export const stalledFinalizer = <A, E, R>(
  use: (stall: Effect.Effect<void>) => Effect.Effect<A, E, R>,
  resource: string
): Effect.Effect<void, E, R> =>
  Effect.gen(function*() {
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    let releasedBySafetyTimer = false
    const warnings: Array<string> = []
    const timer = setTimeout(() => {
      releasedBySafetyTimer = true
      release()
    }, safetyReleaseMs)
    yield* use(Effect.promise(() => wait)).pipe(
      Effect.provide(Logger.layer([Logger.make((entry) => {
        if (entry.logLevel === "Warn") warnings.push(JSON.stringify(entry.message))
      })])),
      Effect.ensuring(Effect.sync(() => {
        clearTimeout(timer)
        release()
      }))
    )
    expect(releasedBySafetyTimer).toBe(false)
    expect(warnings.some((message) => message.includes("timed out") && message.includes(resource))).toBe(true)
  })
