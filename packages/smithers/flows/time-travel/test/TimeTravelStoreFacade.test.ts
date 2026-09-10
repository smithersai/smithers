import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as TimeTravelStore from "../src/TimeTravelStore.ts"

const frame = { lineageId: "main", seq: 1 } as const

describe("TimeTravelStore.makeNoop", () => {
  it.effect("fails every method with `unknown`, naming the method that was called", () =>
    Effect.gen(function*() {
      const store = TimeTravelStore.makeNoop()
      const calls = [
        ["snapshotAt", store.snapshotAt("run", frame)],
        ["recordSnapshots", store.recordSnapshots([])],
        ["latestSnapshots", store.latestSnapshots("run")],
        ["descendants", store.descendants("run", frame)],
        ["writeAudit", store.writeAudit({ id: "a", runId: "run", frame, status: "in_progress" })],
        ["updateAudit", store.updateAudit("a", { status: "completed" })],
        ["pendingAudits", store.pendingAudits()],
        ["archiveAndTruncate", store.archiveAndTruncate("run", frame, [], { hostId: "h", pid: 1, nonce: "n" })],
        ["archivedAt", store.archivedAt("run", 1)],
        ["nextForkId", store.nextForkId("run", frame)],
        ["abandonForkIntents", store.abandonForkIntents(0)],
        ["createFork", store.createFork("run", frame)],
        ["recordReceipt", store.recordReceipt({ id: "r", auditId: "a", effectId: "e", receipt: {} })]
      ] as const

      for (const [method, effect] of calls) {
        const error = yield* (Effect.flip(effect as Effect.Effect<unknown, unknown>))
        expect(error).toMatchObject({ code: "unknown", message: `${method} is unavailable` })
      }
    }))

  it.effect("keeps overridden methods and leaves the rest unavailable", () =>
    Effect.gen(function*() {
      const layer = TimeTravelStore.layerNoop({
        snapshotAt: (runId, at) => Effect.succeed({ runId, frame: at, changeId: "change" })
      })

      const result = yield* (
        Effect.gen(function*() {
          const store = yield* TimeTravelStore.TimeTravelStore
          const snapshot = yield* store.snapshotAt("run", frame)
          const failed = yield* Effect.flip(store.pendingAudits())
          return { snapshot, failed }
        }).pipe(Effect.provide(layer))
      )

      expect(result.snapshot).toEqual({ runId: "run", frame, changeId: "change" })
      expect(result.failed).toMatchObject({ code: "unknown", message: "pendingAudits is unavailable" })
    }))

  it("returns the implementation unchanged from `make`", () => {
    const service = TimeTravelStore.makeNoop()
    expect(TimeTravelStore.make(service)).toStrictEqual(service)
  })
})

describe("TimeTravelStore.auditPatchKeys", () => {
  it("names exactly the keys `AuditPatch` declares", () => {
    // The list used to be hand-written beside the schema, so a field added to
    // `AuditPatch` alone was refused by `validateAuditPatch` with "unknown
    // key" before the schema ever saw it. Deriving the list is what keeps the
    // two from drifting; this asserts the derivation, not a copy of it.
    expect(TimeTravelStore.auditPatchKeys).toEqual(Object.keys(TimeTravelStore.AuditPatch.fields))
  })

  it.effect("admits every declared key and refuses anything else", () =>
    Effect.gen(function*() {
      const patch = { status: "completed", rateLimit: { allowed: true }, detail: { note: "kept" } } as const
      const admitted = yield* TimeTravelStore.validateAuditPatch(patch)
      expect(admitted).toEqual(patch)
      for (const key of Object.keys(patch)) {
        expect(TimeTravelStore.auditPatchKeys, `auditPatchKeys omits ${key}`).toContain(key)
      }

      const refused = yield* Effect.flip(
        TimeTravelStore.validateAuditPatch({ id: "audit" } as TimeTravelStore.AuditPatch)
      )
      expect(refused).toMatchObject({ code: "invalid", message: "audit patch contains unknown key id" })
    }))
})

describe("TimeTravelStore.Fork", () => {
  it("is the row a store commits, with no warnings channel", () => {
    // The boundary assessment runs above the store, so the warnings belong to
    // `TimeTravel.ForkResult`. A store that had to return `warnings: []` was
    // being handed a field it could never fill.
    expect(Object.keys(TimeTravelStore.Fork.fields)).toEqual(["runId", "edge"])
    expect(
      Schema.decodeUnknownSync(TimeTravelStore.Fork)({
        runId: "child",
        edge: { parentRunId: "run", parentSeq: 1, childRunId: "child", kind: "fork", attached: false }
      })
    ).toEqual({
      runId: "child",
      edge: { parentRunId: "run", parentSeq: 1, childRunId: "child", kind: "fork", attached: false }
    })
  })
})
