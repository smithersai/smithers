import { describe, expect, it } from "@effect/vitest"
import { Capability, CapabilityPattern } from "@smthrs/capability/Capability"
import { GrantStoreError, PermissionDenied } from "@smthrs/capability/Permission"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { attenuate } from "../src/CapabilitySet.ts"
import * as GrantStore from "../src/GrantStore.ts"
import * as Workspace from "../src/Workspace.ts"

const readme = new Capability({ action: "fs:read", resource: "/workspace/readme.md" })
const notes = new Capability({ action: "fs:read", resource: "/workspace/notes.md" })
const workspaceReads = new CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })

const exact = (capability: Capability) =>
  new CapabilityPattern({ action: capability.action, resource: capability.resource })

const failedCommit = () => new GrantStoreError({ code: "journal_failed", message: "commit rejected" })

const make = (options?: GrantStore.MakeOptions) =>
  GrantStore.make(options).pipe(Effect.provide(Workspace.layer("/workspace")))

const awaitPending = (
  store: GrantStore.Service,
  count: number
): Effect.Effect<ReadonlyArray<GrantStore.PendingRequest>> =>
  Effect.suspend(() =>
    Effect.flatMap(store.list, (pending) =>
      pending.length >= count
        ? Effect.succeed(pending)
        : Effect.yieldNow.pipe(Effect.andThen(awaitPending(store, count))))
  )

const itEffect = <A, E>(name: string, body: () => Effect.Effect<A, E>): void => {
  it.effect(name, () => body())
}

describe("GrantStore persistence atomicity", () => {
  itEffect("keeps a once request pending and retryable when persistence fails", () =>
    Effect.scoped(
      Effect.gen(function*() {
        let shouldFail = true
        const store = yield* make({
          persist: () => shouldFail ? Effect.fail(failedCommit()) : Effect.void
        })
        const waiter = yield* store.check(readme).pipe(Effect.forkChild({ startImmediately: true }))
        const [request] = yield* awaitPending(store, 1)

        expect((yield* Effect.flip(store.reply(request!.requestId, "once"))).code).toBe("journal_failed")
        expect(waiter.pollUnsafe()).toBeUndefined()
        expect(yield* store.list).toEqual([request])

        shouldFail = false
        yield* store.reply(request!.requestId, "once")
        yield* Fiber.join(waiter)
        expect(yield* store.list).toEqual([])
      })
    ))

  itEffect("keeps a denial pending and retryable when persistence fails", () =>
    Effect.scoped(
      Effect.gen(function*() {
        let shouldFail = true
        const store = yield* make({
          persist: () => shouldFail ? Effect.fail(failedCommit()) : Effect.void
        })
        const waiter = yield* Effect.flip(store.check(readme)).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const [request] = yield* awaitPending(store, 1)

        expect((yield* Effect.flip(store.reply(request!.requestId, "deny"))).code).toBe("journal_failed")
        expect(waiter.pollUnsafe()).toBeUndefined()
        expect(yield* store.list).toEqual([request])

        shouldFail = false
        yield* store.reply(request!.requestId, "deny")
        const denied = yield* Fiber.join(waiter)
        expect(denied).toBeInstanceOf(PermissionDenied)
        if (!(denied instanceof PermissionDenied)) {
          throw new Error("expected PermissionDenied")
        }
        expect(denied.reason).toBe("permission request denied")
        expect(yield* store.list).toEqual([])
      })
    ))

  itEffect("activates no run rule and resumes no waiter after a failed commit", () =>
    Effect.scoped(
      Effect.gen(function*() {
        let shouldFail = true
        const store = yield* make({
          planDigest: "plan-1",
          persist: () => shouldFail ? Effect.fail(failedCommit()) : Effect.void
        })
        const readmeWaiter = yield* store.check(readme).pipe(
          attenuate([exact(readme)]),
          Effect.forkChild({ startImmediately: true })
        )
        const notesWaiter = yield* store.check(notes).pipe(
          attenuate([exact(notes)]),
          Effect.forkChild({ startImmediately: true })
        )
        const pending = yield* awaitPending(store, 2)
        const readmeRequest = pending.find((request) => request.capability.resource === readme.resource)!

        expect(
          (yield* Effect.flip(store.reply(readmeRequest.requestId, "run", workspaceReads))).code
        ).toBe("journal_failed")
        expect(readmeWaiter.pollUnsafe()).toBeUndefined()
        expect(notesWaiter.pollUnsafe()).toBeUndefined()
        expect(yield* store.list).toHaveLength(2)

        shouldFail = false
        yield* store.reply(readmeRequest.requestId, "run", workspaceReads)
        yield* Fiber.join(readmeWaiter)
        expect(notesWaiter.pollUnsafe()).toBeUndefined()
        const [remaining] = yield* store.list
        expect(remaining!.capability).toEqual(notes)

        yield* store.reply(remaining!.requestId, "once")
        yield* Fiber.join(notesWaiter)
      })
    ))

  itEffect("activates no envelope predicates until their commit succeeds", () =>
    Effect.scoped(
      Effect.gen(function*() {
        let shouldFail = true
        const store = yield* make({
          planDigest: "plan-1",
          persist: () => shouldFail ? Effect.fail(failedCommit()) : Effect.void
        })
        const first = yield* store.check(readme).pipe(Effect.forkChild({ startImmediately: true }))
        yield* awaitPending(store, 1)

        expect(
          (yield* Effect.flip(store.grantEnvelope({
            planDigest: "plan-1",
            patterns: [workspaceReads],
            scope: "run"
          }))).code
        ).toBe("journal_failed")
        expect(first.pollUnsafe()).toBeUndefined()

        const second = yield* store.check(notes).pipe(Effect.forkChild({ startImmediately: true }))
        expect(yield* awaitPending(store, 2)).toHaveLength(2)
        expect(second.pollUnsafe()).toBeUndefined()

        shouldFail = false
        yield* store.grantEnvelope({ planDigest: "plan-1", patterns: [workspaceReads], scope: "run" })
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        expect(yield* store.list).toEqual([])
      })
    ))
})

describe("GrantStore lifecycle during blocked persistence", () => {
  itEffect("cancels a waiter without activating a failed blocked decision", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let attempts = 0
        const store = yield* make({
          persist: () =>
            Effect.suspend(() => {
              attempts += 1
              return attempts === 1
                ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(Effect.fail(failedCommit()))
                )
                : Effect.void
            })
        })
        const waiter = yield* store.check(readme).pipe(Effect.forkChild({ startImmediately: true }))
        const [request] = yield* awaitPending(store, 1)
        const reply = yield* Effect.flip(store.reply(request!.requestId, "once")).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(started)

        const cancellation = yield* Fiber.interrupt(waiter).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        // Cancellation no longer queues behind the suspended journal write.
        yield* Fiber.join(cancellation)
        expect(reply.pollUnsafe()).toBeUndefined()
        expect(yield* store.list).toEqual([])

        yield* Deferred.succeed(release, undefined)
        expect((yield* Fiber.join(reply)).code).toBe("journal_failed")
        expect(yield* store.list).toEqual([])

        const retry = yield* store.check(readme).pipe(Effect.forkChild({ startImmediately: true }))
        const [retryRequest] = yield* awaitPending(store, 1)
        expect(retryRequest!.requestId).toBe("permission-2")
        yield* store.reply(retryRequest!.requestId, "once")
        yield* Fiber.join(retry)
      })
    ))

  itEffect("closes cleanly without waiting for a blocked journal write", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const storeScope = yield* Scope.make()
      const store = yield* make({
        persist: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.fail(failedCommit()))
          )
      }).pipe(Scope.provide(storeScope))
      const waiter = yield* Effect.flip(store.check(readme)).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      const [request] = yield* awaitPending(store, 1)
      const reply = yield* Effect.flip(store.reply(request!.requestId, "once")).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(started)

      const closing = yield* Scope.close(storeScope, Exit.void).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      // Scope closure no longer waits on the suspended journal write: it
      // fails the stranded waiter while the reply is still persisting.
      yield* Fiber.join(closing)
      const denied = yield* Fiber.join(waiter)
      expect(denied).toBeInstanceOf(PermissionDenied)
      if (!(denied instanceof PermissionDenied)) {
        throw new Error("expected PermissionDenied")
      }
      expect(denied.reason).toBe("grant store closed")
      expect(reply.pollUnsafe()).toBeUndefined()

      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(reply)).code).toBe("journal_failed")
      expect(yield* store.list).toEqual([])
      expect((yield* Effect.flip(store.check(readme))).code).toBe("store_closed")
    }))
})
