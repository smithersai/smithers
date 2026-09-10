import { describe, expect, it } from "@effect/vitest"
import * as Capability from "@smthrs/capability/Capability"
import { PermissionRequired } from "@smthrs/capability/Permission"
import { Journal } from "@smthrs/journal/Journal"
import * as JournalModule from "@smthrs/journal/Journal"
import { Input, type RunId, type SourceId } from "@smthrs/journal/JournalEvent"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect, Fiber } from "effect"
import type * as Scope from "effect/Scope"
import * as GrantEvent from "../src/GrantEvent.ts"
import * as JournalGrantStore from "../src/JournalGrantStore.ts"
import * as Workspace from "../src/Workspace.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId
const capability = new Capability.Capability({ action: "fs:write", resource: "/workspace/file.txt" })
const pattern = new Capability.CapabilityPattern({ action: "fs:write", resource: "/workspace/**" })

const options = {
  runId: "run",
  policyRunId: "policy",
  sourceId: "kernel",
  planDigest: "plan-1",
  attended: true
} as const

const run = <A, E>(effect: Effect.Effect<A, E, Journal | Scope.Scope | Workspace.Workspace>) =>
  effect.pipe(
    Effect.provide(TestJournal.layer()),
    Effect.provide(Workspace.layer("/workspace")),
    Effect.scoped
  )

const itEffect = <A, E>(name: string, body: () => Effect.Effect<A, E>): void => {
  it.effect(name, () => body())
}

const remembered = () =>
  new GrantEvent.RememberedGrant({
    eventType: "flows.kernel.grant.remembered.v1",
    requestId: "request",
    runId: options.runId,
    planDigest: options.planDigest,
    capability,
    pattern,
    scope: "remembered",
    tier: "compensable"
  })

describe("JournalGrantStore", () => {
  itEffect("requires a non-empty plan digest", () =>
    run(
      Effect.gen(function*() {
        const failure = yield* Effect.flip(
          JournalGrantStore.make({ ...options, planDigest: "" })
        )
        expect(failure.code).toBe("invalid_resolution")
      })
    ))

  itEffect("validates every journal namespace before replay", () =>
    run(
      Effect.gen(function*() {
        const cases: ReadonlyArray<
          readonly [
            Partial<JournalGrantStore.JournalGrantStoreOptions>,
            string
          ]
        > = [
          [{ runId: "" }, "runId must be non-empty, bounded, well-formed text"],
          [{ policyRunId: "" }, "policyRunId must be non-empty, bounded, well-formed text"],
          [{ sourceId: "x".repeat(4_097) }, "sourceId must be non-empty, bounded, well-formed text"],
          [{ planDigest: "bad\0digest" }, "planDigest must be non-empty, bounded, well-formed text"],
          [{ runId: "\ud800" }, "runId must be non-empty, bounded, well-formed text"],
          [{ runId: "\udc00" }, "runId must be non-empty, bounded, well-formed text"],
          [{ runId: options.policyRunId }, "runId and policyRunId must be distinct"]
        ]
        for (const [override, message] of cases) {
          const failure = yield* Effect.flip(JournalGrantStore.make({ ...options, ...override }))
          expect(failure).toMatchObject({ code: "invalid_resolution", message })
        }
        const unicode = yield* JournalGrantStore.make({
          ...options,
          runId: "run-😀",
          policyRunId: "policy-😀",
          sourceId: "kernel-😀",
          planDigest: "plan-😀"
        })
        expect(yield* unicode.list).toEqual([])
        const exact = yield* JournalGrantStore.make({ ...options, sourceId: "x".repeat(4_096) })
        expect(yield* exact.list).toEqual([])
      })
    ))

  itEffect("replays remembered grants from the dedicated policy run", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const payload = GrantEvent.encode(remembered())
        if (payload._tag === "Failure") {
          throw new Error("could not encode remembered grant")
        }
        yield* journal.emitDurableUnfenced(
          new Input({
            runId: runId(options.policyRunId),
            sourceId: sourceId(options.sourceId),
            eventType: "flows.kernel.grant.remembered.v1",
            payload: payload.success
          })
        )
        yield* journal.flush
        const store = yield* JournalGrantStore.make(options)
        yield* store.check(capability)
      })
    ))

  itEffect("persists a remembered reply before activating its rule", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const store = yield* JournalGrantStore.make(options)
        const checked = yield* store.check(capability).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        const pending = yield* store.list
        const request = pending[0]
        if (request === undefined) {
          throw new Error("expected a pending permission request")
        }
        yield* store.reply(request.requestId, "remembered", pattern)
        yield* Fiber.join(checked)

        const page = yield* journal.entries({ runId: runId(options.policyRunId), limit: 10 })
        expect(page.entries).toHaveLength(1)
        const event = GrantEvent.decode(page.entries[0]?.payload)
        expect(event).toMatchObject({
          _tag: "Success",
          success: { eventType: "flows.kernel.grant.remembered.v1", pattern }
        })
        yield* store.check(capability)
      })
    ))

  itEffect("records denials", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const store = yield* JournalGrantStore.make(options)
        const checked = yield* store.check(capability).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        const pending = yield* store.list
        const request = pending[0]
        if (request === undefined) {
          throw new Error("expected a pending permission request")
        }
        yield* store.reply(request.requestId, "deny", pattern)
        yield* Fiber.await(checked)

        const page = yield* journal.entries({ runId: runId(options.runId), limit: 10 })
        expect(GrantEvent.decode(page.entries[0]?.payload)).toMatchObject({
          _tag: "Success",
          success: { eventType: "flows.kernel.grant.denied.v1" }
        })
      })
    ))

  itEffect("records once grants without replaying them as authority", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const store = yield* JournalGrantStore.make(options)
        const checked = yield* store.check(capability).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        const request = (yield* store.list)[0]
        if (request === undefined) {
          throw new Error("expected a pending permission request")
        }
        yield* store.reply(request.requestId, "once")
        yield* Fiber.join(checked)

        const page = yield* journal.entries({ runId: runId(options.runId), limit: 10 })
        expect(GrantEvent.decode(page.entries[0]?.payload)).toMatchObject({
          _tag: "Success",
          success: { eventType: "flows.kernel.grant.once.v1", planDigest: options.planDigest }
        })

        const resumed = yield* JournalGrantStore.make({ ...options, attended: false })
        const failure = yield* Effect.flip(resumed.check(capability))
        expect(failure).toBeInstanceOf(PermissionRequired)
      })
    ))

  itEffect("replays run grants for the same run and plan digest", () =>
    run(
      Effect.gen(function*() {
        const store = yield* JournalGrantStore.make(options)
        const checked = yield* store.check(capability).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        const request = (yield* store.list)[0]
        if (request === undefined) {
          throw new Error("expected a pending permission request")
        }
        yield* store.reply(request.requestId, "run", pattern)
        yield* Fiber.join(checked)

        const resumed = yield* JournalGrantStore.make({ ...options, attended: false })
        yield* resumed.check(capability)
        const otherPlan = yield* JournalGrantStore.make({
          ...options,
          planDigest: "plan-2",
          attended: false
        })
        expect(yield* Effect.flip(otherPlan.check(capability))).toBeInstanceOf(PermissionRequired)
      })
    ))

  itEffect("fails closed when journal admission fails", () =>
    Effect.gen(function*() {
      const store = yield* JournalGrantStore.make(options)
      const checked = yield* store.check(capability).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Effect.yieldNow
      const pending = yield* store.list
      const request = pending[0]
      if (request === undefined) {
        throw new Error("expected a pending permission request")
      }
      const failure = yield* Effect.flip(store.reply(request.requestId, "remembered", pattern))
      expect(failure.code).toBe("journal_failed")
      expect(yield* store.list).toHaveLength(1)
      yield* Fiber.interrupt(checked)
    }).pipe(
      Effect.provide(JournalModule.layerNoop({
        entries: () => Effect.succeed({ entries: [], hasMore: false })
      })),
      Effect.provide(Workspace.layer("/workspace")),
      Effect.scoped
    ))

  itEffect("records envelope grants", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const store = yield* JournalGrantStore.make(options)
        yield* store.grantEnvelope({
          planDigest: options.planDigest,
          patterns: [pattern],
          scope: "run"
        })
        const page = yield* journal.entries({ runId: runId(options.runId), limit: 10 })
        expect(GrantEvent.decode(page.entries[0]?.payload)).toMatchObject({
          _tag: "Success",
          success: { eventType: "flows.kernel.grant.envelope.v1" }
        })
      })
    ))

  itEffect("replays an initial run envelope without emitting it again", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const withEnvelope = {
          ...options,
          envelope: { patterns: [pattern], scope: "run" as const }
        }
        const store = yield* JournalGrantStore.make(withEnvelope)
        yield* store.check(capability)
        const resumed = yield* JournalGrantStore.make(withEnvelope)
        yield* resumed.check(capability)

        const page = yield* journal.entries({ runId: runId(options.runId), limit: 10 })
        expect(page.entries).toHaveLength(1)
        expect(GrantEvent.decode(page.entries[0]?.payload)).toMatchObject({
          _tag: "Success",
          success: { eventType: "flows.kernel.grant.envelope.v1" }
        })
      })
    ))

  itEffect("persists and replays remembered envelope predicates from the policy run", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const store = yield* JournalGrantStore.make(options)
        yield* store.grantEnvelope({
          planDigest: options.planDigest,
          patterns: [pattern],
          scope: "remembered"
        })

        const page = yield* journal.entries({ runId: runId(options.policyRunId), limit: 10 })
        expect(GrantEvent.decode(page.entries[0]?.payload)).toMatchObject({
          _tag: "Success",
          success: {
            eventType: "flows.kernel.grant.envelope.v1",
            planDigest: options.planDigest,
            scope: "remembered"
          }
        })

        const resumed = yield* JournalGrantStore.make({
          ...options,
          runId: "run-2",
          planDigest: "plan-2",
          attended: false
        })
        yield* resumed.check(capability)
      })
    ))

  itEffect("rejects a grant whose journal event type disagrees with its payload", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const payload = GrantEvent.encode(remembered())
        if (payload._tag === "Failure") {
          throw new Error("could not encode remembered grant")
        }
        yield* journal.emitDurableUnfenced(
          new Input({
            runId: runId(options.policyRunId),
            sourceId: sourceId(options.sourceId),
            eventType: "flows.kernel.grant.run.v2",
            payload: payload.success
          })
        )
        yield* journal.flush

        const failure = yield* Effect.flip(JournalGrantStore.make(options))
        expect(failure.code).toBe("invalid_resolution")
      })
    ))

  itEffect("ignores grant payloads from a different journal source", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const payload = GrantEvent.encode(remembered())
        if (payload._tag === "Failure") {
          throw new Error("could not encode remembered grant")
        }
        yield* journal.emitDurableUnfenced(
          new Input({
            runId: runId(options.policyRunId),
            sourceId: sourceId("other-source"),
            eventType: "flows.kernel.grant.remembered.v1",
            payload: payload.success
          })
        )
        yield* journal.flush

        const store = yield* JournalGrantStore.make({ ...options, attended: false })
        expect(yield* Effect.flip(store.check(capability))).toBeInstanceOf(PermissionRequired)
      })
    ))
})
