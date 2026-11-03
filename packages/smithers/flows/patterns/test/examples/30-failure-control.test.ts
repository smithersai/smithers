import { expect, it } from "@effect/vitest"
import { PatternError } from "@smthrs/patterns"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { declaredCalls, main, protectRelease } from "../../examples/30-failure-control.vibe"

it("declares the deploy's compensations in reverse order", () => {
  expect(declaredCalls).toEqual([
    "reserve",
    "upload",
    "activate",
    "roll-back",
    "delete",
    "release"
  ])
})

it.effect("bounds checks, isolates a flake, escalates once, and unwinds the deploy", () =>
  Effect.gen(function*() {
    const summary = yield* main()

    expect(summary.checks).toEqual({ lint: "lint-clean", types: "types-clean", audit: "audit-clean" })
    expect(summary.quarantined).toEqual(["flake"])
    expect(summary.fixedAt).toBe(1)
    expect(summary.deploy).toEqual(["reserve", "upload", "activate", "delete", "release"])
    expect(summary.outcome).toBe("compensated")
    expect(summary.lockHeld).toBe(false)
  }))

it.effect("releases the lock when the protected effect is interrupted", () =>
  Effect.gen(function*() {
    const started = yield* Deferred.make<void>()
    let lockHeld = true
    const fiber = yield* Effect.forkChild(protectRelease(
      Effect.andThen(Deferred.succeed(started, undefined), Effect.never),
      Effect.sync(() => {
        lockHeld = false
      })
    ))

    yield* Deferred.await(started)
    expect(lockHeld).toBe(true)
    yield* Fiber.interrupt(fiber)
    const exit = yield* Fiber.await(fiber)

    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(lockHeld).toBe(false)
  }))

it.effect("releases the lock after success, an unhandled failure, or a defect", () =>
  Effect.gen(function*() {
    const failure = new PatternError.PatternError({ code: "invalid_input", message: "Invalid release" })
    const defect = new Error("Deployment defect")
    for (
      const [body, expected] of [
        [Effect.succeed("built"), Exit.succeed("released")],
        [Effect.fail(failure), Exit.fail(failure)],
        [Effect.die(defect), Exit.die(defect)]
      ] as const
    ) {
      let releases = 0
      const exit = yield* Effect.exit(protectRelease(
        body,
        Effect.sync(() => {
          releases++
        })
      ))

      expect(releases).toBe(1)
      expect(exit).toEqual(expected)
    }
  }))
