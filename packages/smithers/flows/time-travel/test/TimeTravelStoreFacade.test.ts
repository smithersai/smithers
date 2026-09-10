import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
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
