import { describe, expect, it } from "@effect/vitest"
import { Capability, CapabilityPattern } from "@smthrs/capability/Capability"
import { GrantStoreError, PermissionDenied, PermissionRequired, Rule } from "@smthrs/capability/Permission"
import { Deferred, Effect, Fiber } from "effect"
import { attenuate } from "../src/CapabilitySet.ts"
import type { GrantEvent } from "../src/GrantEvent.ts"
import { make as makeGrantStore, type MakeOptions, type PendingRequest, type Service } from "../src/GrantStore.ts"
import * as Workspace from "../src/Workspace.ts"

const readme = new Capability({
  action: "fs:read",
  resource: "/workspace/readme.md"
})

const notes = new Capability({
  action: "fs:read",
  resource: "/workspace/notes.md"
})

const workspaceReads = new CapabilityPattern({
  action: "fs:read",
  resource: "/workspace/**"
})

const awaitPending = (
  store: Service,
  count: number
): Effect.Effect<ReadonlyArray<PendingRequest>> =>
  Effect.suspend(() =>
    Effect.flatMap(store.list, (pending) =>
      pending.length >= count
        ? Effect.succeed(pending)
        : Effect.yieldNow.pipe(Effect.andThen(awaitPending(store, count))))
  )

const make = (options?: MakeOptions) => makeGrantStore(options).pipe(Effect.provide(Workspace.layer("/workspace")))

const itEffect = <A, E>(
  name: string,
  body: () => Effect.Effect<A, E>
): void => {
  it.effect(name, () => body())
}

describe("GrantStore", () => {
  itEffect("rejects checks outside the ambient capability ceiling", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({
          rules: [
            new Rule({
              effect: "allow",
              pattern: new CapabilityPattern({ action: "*", resource: "**" })
            })
          ]
        })
        const failure = yield* Effect.flip(
          store.check(readme).pipe(
            attenuate([
              new CapabilityPattern({
                action: "net:get",
                resource: "**"
              })
            ])
          )
        )
        expect(failure).toBeInstanceOf(PermissionDenied)
        if (!(failure instanceof PermissionDenied)) {
          throw new Error("expected PermissionDenied")
        }
        expect(failure.reason).toBe("outside capability ceiling")
      })
    ))

  itEffect("cannot replace ambient authority with a wider service", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({
          rules: [
            new Rule({
              effect: "allow",
              pattern: new CapabilityPattern({ action: "*", resource: "**" })
            })
          ]
        })
        const failure = yield* Effect.flip(
          attenuate([
            new CapabilityPattern({
              action: "net:get",
              resource: "**"
            })
          ])(
            store.check(readme)
          )
        )
        expect(failure).toBeInstanceOf(PermissionDenied)
      })
    ))

  itEffect("reply once resumes exactly one waiter", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make()
        const first = yield* store.check(readme).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const second = yield* store.check(readme).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const pending = yield* awaitPending(store, 2)

        yield* store.reply(pending[0]!.requestId, "once")
        yield* Fiber.join(first)
        expect(second.pollUnsafe()).toBeUndefined()

        const remaining = yield* store.list
        expect(remaining).toHaveLength(1)
        expect(remaining[0]!.requestId).toBe(pending[1]!.requestId)
        yield* store.reply(remaining[0]!.requestId, "once")
        yield* Fiber.join(second)
      })
    ))

  itEffect("records a once grant before resuming its waiter", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const events: Array<GrantEvent> = []
        const store = yield* make({
          runId: "run-1",
          planDigest: "plan-1",
          persist: (event) =>
            Effect.sync(() => {
              events.push(event)
            })
        })
        const waiter = yield* store.check(readme).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const [pending] = yield* awaitPending(store, 1)
        yield* store.reply(pending!.requestId, "once")
        yield* Fiber.join(waiter)

        expect(events).toMatchObject([
          {
            eventType: "flows.kernel.grant.once.v1",
            runId: "run-1",
            planDigest: "plan-1",
            capability: readme,
            scope: "once"
          }
        ])
      })
    ))

  itEffect("a remembered grant resolves every newly covered waiter", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const persisted = yield* Deferred.make<void>()
        const store = yield* make({
          runId: "run-1",
          persist: () => Deferred.succeed(persisted, undefined)
        })
        const first = yield* store.check(readme).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const second = yield* store.check(notes).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const pending = yield* awaitPending(store, 2)

        yield* store.reply(pending[0]!.requestId, "remembered", workspaceReads)
        yield* Deferred.await(persisted)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        expect(yield* store.list).toEqual([])
      })
    ))

  itEffect("a run grant cannot outlive the capability ceiling captured by its request", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const events: Array<GrantEvent> = []
        const store = yield* make({
          planDigest: "plan-1",
          persist: (event) =>
            Effect.sync(() => {
              events.push(event)
            })
        })
        const first = yield* store.check(readme).pipe(
          attenuate([
            new CapabilityPattern({
              action: "fs:read",
              resource: readme.resource
            })
          ]),
          Effect.forkChild({ startImmediately: true })
        )
        const [pending] = yield* awaitPending(store, 1)
        yield* store.reply(
          pending!.requestId,
          "run",
          workspaceReads
        )
        yield* Fiber.join(first)

        expect(events).toMatchObject([{
          eventType: "flows.kernel.grant.run.v2",
          pattern: workspaceReads,
          ceiling: [[{ action: "fs:read", resource: readme.resource }]]
        }])

        const second = yield* store.check(notes).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const [next] = yield* awaitPending(store, 1)
        expect(next!.capability).toEqual(notes)
        yield* store.reply(next!.requestId, "once")
        yield* Fiber.join(second)
      })
    ))

  itEffect("a run grant resolves every already-pending covered waiter", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({ planDigest: "plan-1" })
        const first = yield* store.check(readme).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const second = yield* store.check(notes).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const pending = yield* awaitPending(store, 2)

        yield* store.reply(pending[0]!.requestId, "run", workspaceReads)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        expect(yield* store.list).toEqual([])
      })
    ))

  itEffect("an envelope is persisted before activation and resolves covered waiters", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const events: Array<GrantEvent> = []
        const store = yield* make({
          runId: "run-1",
          planDigest: "plan-1",
          persist: (event) =>
            Effect.sync(() => {
              events.push(event)
            })
        })
        const waiter = yield* store.check(readme).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* awaitPending(store, 1)
        yield* store.grantEnvelope({
          planDigest: "plan-1",
          patterns: [workspaceReads],
          scope: "run"
        })
        yield* Fiber.join(waiter)

        expect(events.map((event) => event.eventType)).toEqual(["flows.kernel.grant.envelope.v1"])
        expect(yield* store.list).toEqual([])
        yield* store.check(notes)
      })
    ))

  itEffect("rejects envelope authority for a different active plan digest", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const events: Array<GrantEvent> = []
        const store = yield* make({
          runId: "run-1",
          planDigest: "plan-1",
          persist: (event) =>
            Effect.sync(() => {
              events.push(event)
            })
        })
        const failure = yield* Effect.flip(
          store.grantEnvelope({
            planDigest: "plan-2",
            patterns: [workspaceReads]
          })
        )
        expect(failure.code).toBe("invalid_resolution")
        expect(events).toEqual([])

        const waiter = yield* store.check(readme).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        expect(yield* awaitPending(store, 1)).toHaveLength(1)
        yield* Fiber.interrupt(waiter)
      })
    ))

  itEffect("serializes concurrent replies so only one decision is persisted", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const persistenceStarted = yield* Deferred.make<void>()
        const releasePersistence = yield* Deferred.make<void>()
        const events: Array<GrantEvent> = []
        const store = yield* make({
          persist: (event) =>
            Effect.gen(function*() {
              events.push(event)
              yield* Deferred.succeed(persistenceStarted, undefined)
              yield* Deferred.await(releasePersistence)
            })
        })
        const waiter = yield* store.check(readme).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const [pending] = yield* awaitPending(store, 1)
        const firstReply = yield* store.reply(pending!.requestId, "once").pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(persistenceStarted)
        const secondReply = yield* Effect.flip(store.reply(pending!.requestId, "deny")).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        // The losing reply fails fast instead of queueing behind the
        // suspended journal write.
        const failure = yield* Fiber.join(secondReply)
        expect(failure.code).toBe("request_not_found")

        yield* Deferred.succeed(releasePersistence, undefined)
        yield* Fiber.join(firstReply)
        yield* Fiber.join(waiter)
        expect(events.map((event) => event.eventType)).toEqual(["flows.kernel.grant.once.v1"])
      })
    ))

  itEffect("closing the scope fails every waiter and clears the pending map", () =>
    Effect.gen(function*() {
      const retained = yield* Effect.scoped(
        Effect.gen(function*() {
          const store = yield* make()
          const first = yield* Effect.flip(store.check(readme)).pipe(
            Effect.forkDetach({ startImmediately: true })
          )
          const second = yield* Effect.flip(store.check(notes)).pipe(
            Effect.forkDetach({ startImmediately: true })
          )
          yield* awaitPending(store, 2)
          return { store, first, second }
        })
      )

      const failures = yield* Effect.all([
        Fiber.join(retained.first),
        Fiber.join(retained.second)
      ])
      expect(failures).toHaveLength(2)
      for (const failure of failures) {
        expect(failure).toBeInstanceOf(PermissionDenied)
        if (!(failure instanceof PermissionDenied)) {
          throw new Error("expected PermissionDenied")
        }
        expect(failure.reason).toBe("grant store closed")
      }
      expect(yield* retained.store.list).toEqual([])
      const denied = yield* Effect.flip(retained.store.check(readme))
      expect(denied).toBeInstanceOf(GrantStoreError)
      expect(denied.code).toBe("store_closed")
      const closed = yield* Effect.flip(retained.store.reply("permission-1", "once"))
      expect(closed.code).toBe("store_closed")
    }))

  itEffect("interrupting a waiter removes its pending request", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make()
        const waiter = yield* store.check(readme).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* awaitPending(store, 1)
        yield* Fiber.interrupt(waiter)
        expect(yield* store.list).toEqual([])
      })
    ))

  itEffect("serializes request allocation and never reuses an interrupted request id", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const first = new Capability({ action: "fs:read", resource: "/workspace/first.md" })
        const second = new Capability({ action: "fs:read", resource: "/workspace/second.md" })
        const third = new Capability({ action: "fs:read", resource: "/workspace/third.md" })
        const store = yield* make()
        const firstFiber = yield* store.check(first).pipe(Effect.forkChild({ startImmediately: true }))
        const secondFiber = yield* store.check(second).pipe(Effect.forkChild({ startImmediately: true }))

        const initial = yield* awaitPending(store, 2)
        expect(initial.map(({ requestId }) => requestId)).toEqual(["permission-1", "permission-2"])

        yield* Fiber.interrupt(firstFiber)
        const thirdFiber = yield* store.check(third).pipe(Effect.forkChild({ startImmediately: true }))
        const remaining = yield* awaitPending(store, 2)
        expect(remaining.map(({ requestId }) => requestId)).toEqual(["permission-2", "permission-3"])

        // Allocation runs under the same permit as the closed-state check and
        // the counter advances monotonically, so duplicate and mid-allocation
        // cleanup branches are unreachable store states.
        yield* Effect.forEach(remaining, ({ requestId }) => store.reply(requestId, "once"), { discard: true })
        yield* Fiber.join(secondFiber)
        yield* Fiber.join(thirdFiber)
        expect(yield* store.list).toEqual([])
      })
    ))

  itEffect("unattended checks carry one exact capability and its tier", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({
          attended: false,
          runId: "run-7"
        })
        const capability = new Capability({
          action: "proc:spawn",
          resource: "git status"
        })
        const failure = yield* Effect.flip(store.check(capability, { command: "git status" }))

        expect(failure).toBeInstanceOf(PermissionRequired)
        if (!(failure instanceof PermissionRequired)) {
          throw new Error("expected PermissionRequired")
        }
        expect(failure.requestId).toBe("permission-1")
        expect(failure.runId).toBe("run-7")
        expect(failure.capability).toEqual(capability)
        expect(failure.capability).not.toBeInstanceOf(CapabilityPattern)
        expect(failure.tier).toBe("irreversible")
        expect(failure.meta).toEqual({ command: "git status" })
      })
    ))

  itEffect("configured deny remains a hard veto over an initial remembered allow", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({
          attended: false,
          rules: [
            [
              new Rule({
                effect: "deny",
                pattern: workspaceReads
              })
            ],
            [
              new Rule({
                effect: "allow",
                pattern: workspaceReads
              })
            ]
          ]
        })
        const failure = yield* Effect.flip(store.check(readme))
        expect(failure).toBeInstanceOf(PermissionDenied)
        if (!(failure instanceof PermissionDenied)) {
          throw new Error("expected PermissionDenied")
        }
        expect(failure.reason).toBe("denied by permission policy")
      })
    ))

  itEffect("rejects remembered patterns that change the action class", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make()
        const waiter = yield* store.check(readme).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const [pending] = yield* awaitPending(store, 1)
        const failure = yield* Effect.flip(
          store.reply(
            pending!.requestId,
            "remembered",
            new CapabilityPattern({ action: "*", resource: "**" })
          )
        )
        expect(failure.code).toBe("invalid_resolution")
        expect(yield* store.list).toHaveLength(1)
        yield* store.reply(pending!.requestId, "once")
        yield* Fiber.join(waiter)
      })
    ))

  itEffect("rejects run and remembered grants that widen the displayed effect tier", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({ planDigest: "plan-1" })
        const get = new Capability({ action: "net:get", resource: "api.example.test" })
        const waiter = yield* store.check(get).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const [pending] = yield* awaitPending(store, 1)
        const crossAction = new CapabilityPattern({ action: "net:*", resource: "**" })

        expect((yield* Effect.flip(store.reply(pending!.requestId, "run", crossAction))).code)
          .toBe("invalid_resolution")
        expect((yield* Effect.flip(store.reply(pending!.requestId, "remembered", crossAction))).code)
          .toBe("invalid_resolution")

        yield* store.reply(pending!.requestId, "once")
        yield* Fiber.join(waiter)
      })
    ))

  itEffect("rejects a compensable write grant whose resource glob reaches outside the workspace", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({ planDigest: "plan-1" })
        const write = new Capability({ action: "fs:write", resource: "/workspace/file.txt" })
        const waiter = yield* store.check(write).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const [pending] = yield* awaitPending(store, 1)
        const allWrites = new CapabilityPattern({ action: "fs:write", resource: "**" })

        expect((yield* Effect.flip(store.reply(pending!.requestId, "run", allWrites))).code)
          .toBe("invalid_resolution")
        expect((yield* Effect.flip(store.reply(pending!.requestId, "remembered", allWrites))).code)
          .toBe("invalid_resolution")
        expect(
          (yield* Effect.flip(store.grantEnvelope({
            planDigest: "plan-1",
            patterns: [new CapabilityPattern({ action: "net:*", resource: "**" })]
          }))).code
        ).toBe("invalid_resolution")

        yield* store.reply(pending!.requestId, "once")
        yield* Fiber.join(waiter)
      })
    ))

  itEffect("keeps irreversible filesystem grants on one exact resource", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make()
        const write = new Capability({ action: "fs:write", resource: "/outside/file.txt" })
        const waiter = yield* store.check(write).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const [pending] = yield* awaitPending(store, 1)
        const outsideWrites = new CapabilityPattern({ action: "fs:write", resource: "/outside/**" })

        expect((yield* Effect.flip(store.reply(pending!.requestId, "remembered", outsideWrites))).code)
          .toBe("invalid_resolution")

        yield* store.reply(pending!.requestId, "once")
        yield* Fiber.join(waiter)
      })
    ))

  itEffect("classifies writes against the supplied Workspace without a root fallback", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* makeGrantStore({ attended: false }).pipe(
          Effect.provide(Workspace.layer("/project"))
        )
        const failure = yield* Effect.flip(
          store.check(new Capability({ action: "fs:write", resource: "/workspace/file.txt" }))
        )
        expect(failure).toBeInstanceOf(PermissionRequired)
        if (!(failure instanceof PermissionRequired)) {
          throw new Error("expected PermissionRequired")
        }
        expect(failure.tier).toBe("irreversible")
      })
    ))

  itEffect("rejects unsafe replayed remembered rules", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const failure = yield* Effect.flip(
          make({
            rules: [
              [],
              [
                new Rule({
                  effect: "allow",
                  pattern: new CapabilityPattern({ action: "net:*", resource: "**" })
                })
              ]
            ]
          })
        )
        expect(failure.code).toBe("invalid_resolution")
      })
    ))

  itEffect("a persistence failure blocks remembered-rule activation", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({
          persist: () =>
            Effect.fail(
              new GrantStoreError({
                code: "journal_failed",
                message: "journal unavailable"
              })
            )
        })
        const first = yield* store.check(readme).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const [pending] = yield* awaitPending(store, 1)
        const failure = yield* Effect.flip(
          store.reply(pending!.requestId, "remembered", workspaceReads)
        )
        expect(failure.code).toBe("journal_failed")
        expect(yield* store.list).toHaveLength(1)

        yield* Fiber.interrupt(first)

        const second = yield* store.check(notes).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        const next = yield* awaitPending(store, 1)
        expect(next[0]!.capability).toEqual(notes)
        yield* Fiber.interrupt(second)
      })
    ))
})
