import { Deferred, Effect, Fiber } from "effect"
import { describe, expect, it } from "vitest"
import * as TreeGate from "../src/internal/TreeGate.ts"
import { takesExclusiveTreePermit } from "../src/PackageExec.ts"

describe("whole-tree admission", () => {
  it.each(["Generate", "Shell.Diff", "Changesets.Version", "Go.Generate", "Go.Lint"])(
    "keeps a library rebuild outside the %s check snapshot and its cleanup",
    (rule) =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const gate = yield* TreeGate.make(2)
        const releaseSnapshot = yield* Deferred.make<void>()
        const cleanupStarted = yield* Deferred.make<void>()
        const releaseCleanup = yield* Deferred.make<void>()
        const events: Array<string> = []
        const checker = yield* gate(
          takesExclusiveTreePermit({ rule, mode: "check" }),
          Effect.gen(function*() {
            events.push("snapshot")
            yield* Deferred.await(releaseSnapshot)
          }).pipe(Effect.ensuring(Effect.gen(function*() {
            events.push("restore portals")
            yield* Deferred.succeed(cleanupStarted, undefined)
            yield* Deferred.await(releaseCleanup)
          })))
        ).pipe(Effect.forkScoped({ startImmediately: true }))
        const build = yield* gate(
          takesExclusiveTreePermit({ rule: "Shell.Build", mode: "execute" }),
          Effect.sync(() => {
            events.push("replace dist")
          })
        ).pipe(Effect.forkScoped({ startImmediately: true }))
        // The peer must not replace a directory the check is still measuring,
        // even though the check's generator itself writes only into scratch.
        const duringSnapshot = [...events]
        yield* Deferred.succeed(releaseSnapshot, undefined)
        yield* Deferred.await(cleanupStarted)
        const duringCleanup = [...events]
        yield* Deferred.succeed(releaseCleanup, undefined)
        yield* Fiber.join(checker)
        yield* Fiber.join(build)
        expect(duringSnapshot).toEqual(["snapshot"])
        expect(duringCleanup).toEqual(["snapshot", "restore portals"])
        expect(events).toEqual(["snapshot", "restore portals", "replace dist"])
      })))
  )

  it("admits a queued writer before a later reader", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const gate = yield* TreeGate.make(2)
      const releaseReader = yield* Deferred.make<void>()
      const writerStarted = yield* Deferred.make<void>()
      const releaseWriter = yield* Deferred.make<void>()
      const started: Array<string> = []
      const reader = yield* gate(
        false,
        Effect.gen(function*() {
          started.push("reader")
          yield* Deferred.await(releaseReader)
        })
      ).pipe(Effect.forkScoped({ startImmediately: true }))
      const writer = yield* gate(
        true,
        Effect.gen(function*() {
          started.push("writer")
          yield* Deferred.succeed(writerStarted, undefined)
          yield* Deferred.await(releaseWriter)
        })
      ).pipe(Effect.forkScoped({ startImmediately: true }))
      const later = yield* gate(
        false,
        Effect.sync(() => {
          started.push("later")
        })
      )
        .pipe(Effect.forkScoped({ startImmediately: true }))
      expect(started).toEqual(["reader"])
      yield* Deferred.succeed(releaseReader, undefined)
      yield* Deferred.await(writerStarted)
      expect(started).toEqual(["reader", "writer"])
      yield* Deferred.succeed(releaseWriter, undefined)
      yield* Effect.forEach([reader, writer, later], Fiber.join)
      expect(started).toEqual(["reader", "writer", "later"])
    }))))

  it.each([false, true])(
    "releases an interrupted %s waiter without leaking permits",
    (exclusive) =>
      Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const gate = yield* TreeGate.make(2)
        const owner = yield* gate(true, Effect.never).pipe(Effect.forkScoped({ startImmediately: true }))
        const blocked = yield* gate(exclusive, Effect.die("cancelled waiter ran"))
          .pipe(Effect.forkScoped({ startImmediately: true }))
        const admissionWaiter = yield* gate(false, Effect.die("cancelled admission waiter ran"))
          .pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Fiber.interrupt(admissionWaiter)
        yield* Fiber.interrupt(blocked)
        yield* Fiber.interrupt(owner)
        expect(yield* gate(true, Effect.succeed("all permits returned"))).toBe("all permits returned")
      })))
  )

  it("holds exclusion until the interrupted body's finalizer completes", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const gate = yield* TreeGate.make(2)
      const finalizing = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let peerStarted = false
      const owner = yield* gate(
        true,
        Effect.never.pipe(Effect.ensuring(
          Deferred.succeed(finalizing, undefined).pipe(Effect.andThen(Deferred.await(release)))
        ))
      ).pipe(Effect.forkScoped({ startImmediately: true }))
      const peer = yield* gate(
        false,
        Effect.sync(() => {
          peerStarted = true
        })
      )
        .pipe(Effect.forkScoped({ startImmediately: true }))
      const closing = yield* Fiber.interrupt(owner).pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.await(finalizing)
      expect(peerStarted).toBe(false)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(closing)
      yield* Fiber.join(peer)
      expect(peerStarted).toBe(true)
    }))))
})
