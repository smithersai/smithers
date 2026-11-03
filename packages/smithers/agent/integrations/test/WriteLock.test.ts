import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { expect, it } from "vitest"
import { withWriteLock } from "../src/github/internal/WriteLock.ts"

it("cancelling a waiter preserves the owner's gate and admits the next waiter after release", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const entries: Array<string> = []
      const owner = yield* Effect.forkChild(withWriteLock(
        "cancel",
        Effect.gen(function*() {
          entries.push("owner")
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        })
      ))
      yield* Deferred.await(started)
      const waiter = yield* Effect.forkChild(withWriteLock("cancel", Effect.sync(() => entries.push("cancelled"))))
      yield* TestClock.adjust(0)
      yield* Fiber.interrupt(waiter)
      const next = yield* Effect.forkChild(withWriteLock("cancel", Effect.sync(() => entries.push("next"))))
      yield* TestClock.adjust(0)
      expect(entries).toEqual(["owner"])
      // An unrelated key remains usable while this key is occupied.
      yield* withWriteLock("other", Effect.void)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(owner)
      yield* Fiber.join(next)
      expect(entries).toEqual(["owner", "next"])
    }).pipe(Effect.provide(TestClock.layer()))
  )
})

it("releases a failed or interrupted owner so another call can acquire the key", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    expect(yield* Effect.flip(withWriteLock("release", Effect.fail("failed")))).toBe("failed")
    const started = yield* Deferred.make<void>()
    const owner = yield* Effect.forkChild(
      withWriteLock("release", Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
    )
    yield* Deferred.await(started)
    yield* Fiber.interrupt(owner)
    expect(yield* withWriteLock("release", Effect.succeed("acquired"))).toBe("acquired")
  }))
})
