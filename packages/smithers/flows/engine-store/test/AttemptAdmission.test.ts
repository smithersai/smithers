/**
 * Abnormal-exit cleanup for the keyed in-process admission mutex.
 *
 * A failed or defecting owner must release its permit, and an interrupted
 * waiter must remove its reference without deleting the live owner's gate.
 * Different keys remain independent throughout that cleanup.
 */
import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Ref } from "effect"
import * as AttemptAdmission from "../src/internal/AttemptAdmission.ts"

describe("AttemptAdmission", () => {
  it.effect.each(["failure", "defect"] as const)(
    "releases a %s owner and an interrupted waiter without blocking a fresh same-key dispatch",
    (ownerExit) =>
      Effect.gen(function*() {
        yield* (Effect.scoped(Effect.gen(function*() {
          const admission = AttemptAdmission.makeUnsafe()
          const ownerStarted = yield* Deferred.make<void>()
          const releaseOwner = yield* Deferred.make<void>()
          const distinctStarted = yield* Deferred.make<void>()
          const releaseDistinct = yield* Deferred.make<void>()
          const freshStarted = yield* Deferred.make<void>()
          const distinctActive = yield* Ref.make(0)
          const waiterEntered = yield* Ref.make(false)

          const owner = yield* admission.withPermit("shared")(
            Deferred.succeed(ownerStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseOwner)),
              Effect.andThen(
                ownerExit === "failure"
                  ? Effect.fail(new Error("owner failed"))
                  : Effect.die(new Error("owner defect"))
              )
            )
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(ownerStarted)

          const interruptedWaiter = yield* admission.withPermit("shared")(
            Ref.set(waiterEntered, true)
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow
          expect(interruptedWaiter.pollUnsafe()).toBeUndefined()
          yield* Fiber.interrupt(interruptedWaiter)
          const waiterExit = yield* Fiber.await(interruptedWaiter)

          const distinct = yield* admission.withPermit("distinct")(
            Ref.update(distinctActive, (active) => active + 1).pipe(
              Effect.andThen(Deferred.succeed(distinctStarted, undefined)),
              Effect.andThen(Deferred.await(releaseDistinct)),
              Effect.ensuring(Ref.update(distinctActive, (active) => active - 1))
            )
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(distinctStarted)

          const fresh = yield* admission.withPermit("shared")(
            Effect.gen(function*() {
              yield* Deferred.succeed(freshStarted, undefined)
              return (yield* Ref.get(distinctActive)) === 1
            })
          ).pipe(Effect.forkChild({ startImmediately: true }))
          expect(fresh.pollUnsafe()).toBeUndefined()

          yield* Deferred.succeed(releaseOwner, undefined)
          const failedOwner = yield* Fiber.await(owner)
          yield* Deferred.await(freshStarted)
          const overlappedDistinctKey = yield* Fiber.join(fresh)
          yield* Deferred.succeed(releaseDistinct, undefined)
          yield* Fiber.join(distinct)

          expect(Exit.isFailure(waiterExit) && Cause.hasInterruptsOnly(waiterExit.cause)).toBe(true)
          expect(yield* Ref.get(waiterEntered)).toBe(false)
          expect(Exit.isFailure(failedOwner)).toBe(true)
          expect(
            Exit.isFailure(failedOwner) &&
              (ownerExit === "failure" ? Cause.hasFails(failedOwner.cause) : Cause.hasDies(failedOwner.cause))
          ).toBe(true)
          expect(overlappedDistinctKey).toBe(true)
          expect(yield* admission.withPermit("shared")(Effect.succeed("fresh-after-cleanup")))
            .toBe("fresh-after-cleanup")
        })))
      })
  )
})
