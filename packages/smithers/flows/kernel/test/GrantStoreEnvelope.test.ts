import { describe, expect, it } from "@effect/vitest"
import { Capability, CapabilityPattern } from "@smthrs/capability/Capability"
import { GrantStoreError, Rule } from "@smthrs/capability/Permission"
import { Effect, Fiber, Layer } from "effect"
import type { GrantEvent } from "../src/GrantEvent.vibe"
import * as GrantStore from "../src/GrantStore.ts"
import * as Workspace from "../src/Workspace.vibe"

/**
 * Envelope grants are bulk pre-approvals bound to a plan digest, so the store
 * has to refuse anything that would let an envelope authorize more than the
 * plan the approver saw: a missing or mismatched digest, an empty digest, or a
 * pattern that widens the filesystem effect tier. The construction-time
 * envelope (replayed from durable storage) must enforce exactly the same rules
 * as the runtime `grantEnvelope` call.
 */

const insideWrite = new Capability({ action: "fs:write", resource: "/workspace/file.txt" })
const insideRead = new Capability({ action: "fs:read", resource: "/workspace/readme.md" })
const outsideRead = new Capability({ action: "fs:read", resource: "/outside/secret.md" })

const workspaceWrites = new CapabilityPattern({ action: "fs:write", resource: "/workspace/**" })
const workspaceReads = new CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })
const allWrites = new CapabilityPattern({ action: "fs:write", resource: "**" })

const make = (options?: GrantStore.MakeOptions) =>
  GrantStore.make(options).pipe(Effect.provide(Workspace.layer("/workspace")))

const itEffect = <A, E>(name: string, body: () => Effect.Effect<A, E>): void => {
  it.effect(name, () => body())
}

const recorder = () => {
  const events: Array<GrantEvent> = []
  return {
    events,
    persist: (event: GrantEvent) =>
      Effect.sync(() => {
        events.push(event)
      })
  }
}

const awaitPending = (store: GrantStore.Service, count: number): Effect.Effect<
  ReadonlyArray<{
    readonly requestId: string
    readonly capability: Capability
  }>
> =>
  Effect.suspend(() =>
    Effect.flatMap(store.list, (pending) =>
      pending.length >= count
        ? Effect.succeed(pending)
        : Effect.yieldNow.pipe(Effect.andThen(awaitPending(store, count))))
  )

describe("GrantStore construction-time envelope", () => {
  itEffect("refuses a new construction envelope at the remembered signature ceiling", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const { events, persist } = recorder()
        const envelopeSignatures = Array.from(
          { length: GrantStore.maximumRules },
          (_, index) => `replayed-envelope-${index}`
        )
        const failure = yield* Effect.flip(
          make({
            planDigest: "plan-1",
            persist,
            envelopeSignatures,
            envelope: { planDigest: "plan-1", patterns: [workspaceReads] }
          })
        )

        expect(failure).toBeInstanceOf(GrantStoreError)
        expect(failure.message).toBe(`grant envelopes exceed ${GrantStore.maximumRules} entries`)
        expect(events).toEqual([])
      })
    ))

  itEffect("accepts a known construction envelope at the remembered signature ceiling", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const { events, persist } = recorder()
        const envelopeSignatures = [
          GrantStore.envelopeSignature("plan-1", "run", [workspaceReads]),
          ...Array.from(
            { length: GrantStore.maximumRules - 1 },
            (_, index) => `replayed-envelope-${index}`
          )
        ]
        const store = yield* make({
          attended: false,
          planDigest: "plan-1",
          persist,
          envelopeSignatures,
          envelope: { planDigest: "plan-1", patterns: [workspaceReads] }
        })

        yield* store.check(insideRead)
        expect(events).toEqual([])
      })
    ))

  itEffect("activates a run envelope and records it exactly once", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const { events, persist } = recorder()
        const store = yield* make({
          attended: false,
          runId: "run-1",
          planDigest: "plan-1",
          persist,
          envelope: { planDigest: "plan-1", patterns: [workspaceWrites], scope: "run" }
        })
        yield* store.check(insideWrite)
        expect(events).toMatchObject([
          {
            eventType: "flows.kernel.grant.envelope.v1",
            runId: "run-1",
            planDigest: "plan-1",
            scope: "run"
          }
        ])
      })
    ))

  itEffect("defaults an envelope without an explicit scope to the run scope", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const { events, persist } = recorder()
        const store = yield* make({
          attended: false,
          planDigest: "plan-1",
          persist,
          envelope: { planDigest: "plan-1", patterns: [workspaceReads] }
        })
        yield* store.check(insideRead)
        // No runId was configured, so the durable event carries an empty one.
        expect(events).toMatchObject([{ scope: "run", runId: "" }])
      })
    ))

  itEffect("routes a remembered envelope into the remembered ruleset", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const { events, persist } = recorder()
        const store = yield* make({
          attended: false,
          runId: "run-1",
          planDigest: "plan-1",
          persist,
          envelope: { planDigest: "plan-1", patterns: [workspaceReads], scope: "remembered" }
        })
        yield* store.check(insideRead)
        expect(events).toMatchObject([{ scope: "remembered" }])
      })
    ))

  itEffect("keeps a configured deny a hard veto over a remembered envelope", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({
          attended: false,
          planDigest: "plan-1",
          rules: [new Rule({ effect: "deny", pattern: workspaceReads })],
          envelope: { planDigest: "plan-1", patterns: [workspaceReads], scope: "remembered" }
        })
        expect((yield* Effect.flip(store.check(insideRead))).code).toBe("permission_denied")
      })
    ))

  itEffect("ignores an envelope with no patterns", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const { events, persist } = recorder()
        const store = yield* make({
          attended: false,
          planDigest: "plan-1",
          persist,
          // An empty pattern list grants nothing, so no digest check applies.
          envelope: { planDigest: "mismatched", patterns: [] }
        })
        expect(events).toEqual([])
        expect((yield* Effect.flip(store.check(insideRead))).code).toBe("permission_required")
      })
    ))

  itEffect("refuses an envelope when the store has no active plan digest", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const { events, persist } = recorder()
        const failure = yield* Effect.flip(
          make({
            persist,
            envelope: { planDigest: "plan-1", patterns: [workspaceReads] }
          })
        )
        expect(failure).toBeInstanceOf(GrantStoreError)
        expect(failure.code).toBe("invalid_resolution")
        expect(events).toEqual([])
      })
    ))

  itEffect("refuses an envelope bound to a different plan digest", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const failure = yield* Effect.flip(
          make({
            planDigest: "plan-1",
            envelope: { planDigest: "plan-2", patterns: [workspaceReads] }
          })
        )
        expect(failure.code).toBe("invalid_resolution")
      })
    ))

  itEffect("refuses an envelope bound to an empty plan digest", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const failure = yield* Effect.flip(
          make({
            planDigest: "",
            envelope: { planDigest: "", patterns: [workspaceReads] }
          })
        )
        expect(failure.code).toBe("invalid_resolution")
      })
    ))

  itEffect("refuses a runtime-invalid envelope scope with a typed store error", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const failure = yield* Effect.flip(
          make({
            planDigest: "plan-1",
            envelope: {
              planDigest: "plan-1",
              patterns: [workspaceReads],
              scope: "once" as unknown as "run" | "remembered"
            }
          })
        )
        expect(failure.code).toBe("invalid_resolution")
      })
    ))

  itEffect("refuses an envelope pattern that widens the filesystem effect tier", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const failure = yield* Effect.flip(
          make({
            planDigest: "plan-1",
            envelope: { planDigest: "plan-1", patterns: [workspaceReads, allWrites] }
          })
        )
        expect(failure.code).toBe("invalid_resolution")
      })
    ))

  itEffect("refuses replayed run rules that widen the filesystem effect tier", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const failure = yield* Effect.flip(
          make({ runRules: [new Rule({ effect: "allow", pattern: allWrites })] })
        )
        expect(failure.code).toBe("invalid_resolution")
      })
    ))

  itEffect("accepts replayed run rules that stay inside the workspace", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({
          attended: false,
          runRules: [new Rule({ effect: "allow", pattern: workspaceWrites })]
        })
        yield* store.check(insideWrite)
      })
    ))
})

describe("GrantStore.grantEnvelope", () => {
  itEffect("persists each predicate only once inside a runtime envelope", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const { events, persist } = recorder()
        const store = yield* make({ attended: false, planDigest: "plan-1", persist })
        yield* store.grantEnvelope({
          planDigest: "plan-1",
          patterns: [workspaceReads, workspaceReads],
          scope: "run"
        })

        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({ patterns: [workspaceReads] })
      })
    ))

  itEffect("makes repeated and reordered runtime envelopes idempotent", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const { events, persist } = recorder()
        const store = yield* make({ attended: false, planDigest: "plan-1", persist })
        yield* store.grantEnvelope({
          planDigest: "plan-1",
          patterns: [workspaceReads, workspaceWrites],
          scope: "run"
        })
        yield* store.grantEnvelope({
          planDigest: "plan-1",
          patterns: [workspaceWrites, workspaceReads],
          scope: "run"
        })
        yield* store.grantEnvelope({
          planDigest: "plan-1",
          patterns: [workspaceReads, workspaceWrites],
          scope: "run"
        })

        expect(events).toHaveLength(1)
        yield* store.check(insideRead)
        yield* store.check(insideWrite)
      })
    ))

  itEffect("accepts an empty pattern list as a no-op without persisting", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const { events, persist } = recorder()
        const store = yield* make({ attended: false, planDigest: "plan-1", persist })
        yield* store.grantEnvelope({ planDigest: "plan-1", patterns: [] })
        expect(events).toEqual([])
        expect((yield* Effect.flip(store.check(insideRead))).code).toBe("permission_required")
      })
    ))

  itEffect("records an empty runId when the store has no run identity", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const { events, persist } = recorder()
        const store = yield* make({ attended: false, planDigest: "plan-1", persist })
        yield* store.grantEnvelope({ planDigest: "plan-1", patterns: [workspaceReads] })
        expect(events).toMatchObject([{ runId: "", scope: "run" }])
        yield* store.check(insideRead)
      })
    ))

  itEffect("refuses an envelope after the store scope has closed", () =>
    Effect.gen(function*() {
      const store = yield* Effect.scoped(make({ planDigest: "plan-1" }))
      const failure = yield* Effect.flip(
        store.grantEnvelope({ planDigest: "plan-1", patterns: [workspaceReads] })
      )
      expect(failure.code).toBe("store_closed")
    }))

  itEffect("refuses an envelope when the store has no active plan digest", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({ attended: false })
        const failure = yield* Effect.flip(
          store.grantEnvelope({ planDigest: "plan-1", patterns: [workspaceReads] })
        )
        expect(failure.code).toBe("invalid_resolution")
      })
    ))

  itEffect("leaves waiters outside the envelope pending", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const store = yield* make({ planDigest: "plan-1" })
        const covered = yield* store.check(insideRead).pipe(Effect.forkChild({ startImmediately: true }))
        const uncovered = yield* store.check(outsideRead).pipe(Effect.forkChild({ startImmediately: true }))
        yield* awaitPending(store, 2)

        yield* store.grantEnvelope({ planDigest: "plan-1", patterns: [workspaceReads] })
        yield* Fiber.join(covered)

        const remaining = yield* store.list
        expect(remaining.map((request) => request.capability)).toEqual([outsideRead])
        expect(uncovered.pollUnsafe()).toBeUndefined()
        yield* Fiber.interrupt(uncovered)
      })
    ))
})

describe("GrantStore layers and stubs", () => {
  itEffect("provides a scoped in-memory store through its layer", () =>
    Effect.gen(function*() {
      const store = yield* GrantStore.GrantStore
      expect((yield* Effect.flip(store.check(insideRead))).code).toBe("permission_required")
    }).pipe(
      Effect.provide(
        GrantStore.layer({ attended: false }).pipe(Layer.provide(Workspace.layer("/workspace")))
      ),
      Effect.scoped
    ))

  itEffect("fails layer construction when the replayed policy is unsafe", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(
        Effect.gen(function*() {
          return yield* GrantStore.GrantStore
        }).pipe(
          Effect.provide(
            GrantStore.layer({ runRules: [new Rule({ effect: "allow", pattern: allWrites })] }).pipe(
              Layer.provide(Workspace.layer("/workspace"))
            )
          )
        )
      )
      expect(failure.code).toBe("invalid_resolution")
    }).pipe(Effect.scoped))

  itEffect("allows everything through the noop store", () =>
    Effect.gen(function*() {
      const store = GrantStore.makeNoop
      yield* store.check(insideWrite)
      yield* store.reply("permission-1", "remembered", allWrites)
      yield* store.grantEnvelope({ planDigest: "", patterns: [allWrites] })
      expect(yield* store.list).toEqual([])
    }))

  itEffect("provides the noop store through its layer", () =>
    Effect.gen(function*() {
      const store = yield* GrantStore.GrantStore
      yield* store.check(insideWrite)
      expect(yield* store.list).toEqual([])
    }).pipe(Effect.provide(GrantStore.layerNoop)))
})
