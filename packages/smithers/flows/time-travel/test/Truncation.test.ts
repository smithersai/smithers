import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { forkCreatedEventType, type LineageEdge } from "../src/Frame.ts"
import * as Memory from "../src/MemoryTimeTravelStore.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"

const records: ReadonlyArray<Memory.JournalRecord> = [
  { runId: "parent", seq: 0, eventId: "parent-0", lineageId: "parent/root", payload: null },
  { runId: "parent", seq: 2, eventId: "parent-2", lineageId: "parent/root", payload: null },
  { runId: "child", seq: 0, eventId: "child-0", lineageId: "child/root", payload: null },
  { runId: "grandchild", seq: 0, eventId: "grandchild-0", lineageId: "grandchild/root", payload: null },
  { runId: "detached", seq: 0, eventId: "detached-0", lineageId: "detached/root", payload: null }
]

const owner = { hostId: "host-a", pid: 1234, nonce: "nonce" } as const

const edges: ReadonlyArray<LineageEdge> = [
  { parentRunId: "parent", parentSeq: 2, childRunId: "child", kind: "child", attached: true },
  { parentRunId: "child", parentSeq: 0, childRunId: "grandchild", kind: "continuation", attached: true },
  { parentRunId: "parent", parentSeq: 2, childRunId: "detached", kind: "child", attached: false }
]

describe("truncation", () => {
  it.effect("projects the nearest snapshot, deduplicates cyclic attached descendants, and preserves detached edges", () =>
    Effect.gen(function*() {
      const cyclic: ReadonlyArray<LineageEdge> = [
        { parentRunId: "parent", parentSeq: 1, childRunId: "child", kind: "child", attached: true },
        { parentRunId: "parent", parentSeq: 2, childRunId: "child", kind: "continuation", attached: true },
        { parentRunId: "child", parentSeq: 0, childRunId: "parent", kind: "continuation", attached: true },
        { parentRunId: "parent", parentSeq: 2, childRunId: "detached", kind: "child", attached: false },
        { parentRunId: "parent", parentSeq: 3, childRunId: "detached", kind: "fork", attached: false }
      ]
      const store = Memory.make({
        edges: cyclic,
        snapshots: [
          { runId: "parent", frame: { lineageId: "parent/root", seq: 0 }, changeId: "old" },
          { runId: "parent", frame: { lineageId: "parent/root", seq: 2 }, changeId: "near" }
        ]
      })
      expect(yield* (store.snapshotAt("parent", { lineageId: "parent/root", seq: 1 })))
        .toMatchObject({ changeId: "old" })
      expect(yield* (store.snapshotAt("parent", { lineageId: "parent/root", seq: 2 })))
        .toMatchObject({ changeId: "near" })
      expect(yield* (store.snapshotAt("parent", { lineageId: "other", seq: 5 }))).toBeUndefined()
      expect(yield* (store.descendants("parent", { lineageId: "parent/root", seq: 0 })))
        .toEqual({ attached: [cyclic[0], cyclic[2]], detached: [cyclic[3]] })
    }))

  it.effect("makes audit, receipt, fork, and layer operations transactional", () =>
    Effect.gen(function*() {
      const store = Memory.make({ records, liveRuns: new Set(["ancestor"]) })
      yield* (
        store.writeAudit({
          id: "audit",
          runId: "parent",
          frame: { lineageId: "parent/root", seq: 0 },
          status: "in_progress"
        })
      )
      yield* (store.updateAudit("audit", { status: "completed", detail: { finished: true } }))
      yield* (
        store.recordReceipt({ id: "receipt", auditId: "audit", effectId: "effect", receipt: { undo: true } })
      )
      expect(yield* (store.pendingAudits())).toEqual([])
      expect(store.state()).toMatchObject({ receipts: [{ id: "receipt" }], audits: [{ status: "completed" }] })
      const fork = yield* (store.createFork("parent", { lineageId: "parent/root", seq: 0 }))
      // The copied prefix plus the fork-created marker the SQL store also
      // writes at `frame.seq + 1`, naming the parent and the offset it cut at.
      expect(store.state().records.filter((record) => record.runId === fork.runId)).toEqual([
        expect.objectContaining({ eventId: `fork:${fork.runId}:0` }),
        expect.objectContaining({
          eventId: `fork:${fork.runId}:created`,
          eventType: forkCreatedEventType,
          payload: { parentRunId: "parent", forkJournalOffset: 0, childRunId: fork.runId }
        })
      ])
      const failed = Memory.make({ records, failAt: "recordReceipt" })
      yield* (Effect.flip(failed.recordReceipt({ id: "r", auditId: "a", effectId: "e", receipt: null })))
      expect(failed.state().receipts).toEqual([])
      const layered = yield* (
        Effect.gen(function*() {
          const timeTravel = yield* TimeTravelStore
          return yield* timeTravel.pendingAudits()
        }).pipe(Effect.provide(Memory.layer()))
      )
      expect(layered).toEqual([])
    }))
  it.effect("archives the parent suffix and every attached descendant atomically", () =>
    Effect.gen(function*() {
      const store = Memory.make({ records, edges })
      const result = yield* (
        store.archiveAndTruncate("parent", { lineageId: "parent/root", seq: 0 }, [], owner)
      )

      expect(result.archived).toBe(3)
      expect(result.orphaned.map((edge) => edge.childRunId)).toEqual(["detached"])
      expect(yield* (store.archivedAt("parent", 2))).toBe(true)
      expect(yield* (store.archivedAt("parent", 0))).toBe(false)
      expect(store.state().records.map((record) => record.eventId)).toEqual(["parent-0", "detached-0"])
      expect(store.state().archived.map((record) => record.eventId)).toEqual([
        "parent-2",
        "child-0",
        "grandchild-0"
      ])
      expect(store.state().edges).toEqual([edges[2]])
    }))

  it.effect("rolls back every mutation when the transaction fails before truncation", () =>
    Effect.gen(function*() {
      const store = Memory.make({ records, edges, failAt: "archiveAndTruncate:before-truncate" })
      const before = store.state()

      yield* (
        Effect.flip(store.archiveAndTruncate("parent", { lineageId: "parent/root", seq: 0 }, [], owner))
      )

      expect(store.state()).toEqual(before)
    }))

  it.effect("keeps every in-memory transaction atomic at each mutation boundary", () =>
    Effect.gen(function*() {
      const receipt = { id: "receipt", auditId: "audit", effectId: "effect", receipt: { reverted: true } }
      for (
        const failAt of [
          "archiveAndTruncate:start",
          "archiveAndTruncate:before-archive",
          "archiveAndTruncate:commit"
        ]
      ) {
        const store = Memory.make({ records, edges, failAt })
        const before = store.state()
        yield* (
          Effect.flip(store.archiveAndTruncate("parent", { lineageId: "parent/root", seq: 0 }, [receipt], owner))
        )
        expect(store.state()).toEqual(before)
      }

      for (const failAt of ["createFork:start", "createFork:copy", "createFork:commit"]) {
        const store = Memory.make({ records, edges, failAt })
        const before = store.state()
        yield* (
          Effect.flip(store.createFork("parent", { lineageId: "parent/root", seq: 0 }))
        )
        expect(store.state()).toEqual(before)
      }
    }))

  for (const failAt of ["writeAudit", "updateAudit"] as const) {
    it.effect(`rolls back the ${failAt} in-memory persistence fault`, () =>
      Effect.gen(function*() {
        const store = Memory.make({ failAt })
        if (failAt === "updateAudit") {
          yield* (
            store.writeAudit({
              id: "audit",
              runId: "parent",
              frame: { lineageId: "parent/root", seq: 0 },
              status: "in_progress"
            })
          )
        }
        const before = store.state()
        const failure = yield* (
          Effect.flip(
            failAt === "writeAudit"
              ? store.writeAudit({
                id: "audit",
                runId: "parent",
                frame: { lineageId: "parent/root", seq: 0 },
                status: "in_progress"
              })
              : store.updateAudit("audit", { status: "completed" })
          )
        )

        expect(failure).toMatchObject({
          code: "unknown",
          message: `injected failure at ${failAt}`
        })
        expect(store.state()).toEqual(before)
      }))
  }

  it.effect("rolls back a failed fork-id mint without leaking an intent or an id", () =>
    Effect.gen(function*() {
      const store = Memory.make({ records, edges, failAt: "nextForkId" })
      const before = store.state()

      const failure = yield* (
        Effect.flip(store.nextForkId("parent", { lineageId: "parent/root", seq: 0 }))
      )

      expect(failure).toMatchObject({ code: "unknown", message: "injected failure at nextForkId" })
      // Nothing was reserved, so `forkIntents` is still empty and the next
      // mint still hands out the ordinal the failed one would have taken.
      expect(before.forkIntents).toEqual([])
      expect(store.state()).toEqual(before)
    }))

  it.effect("rolls back a failed intent reclaim and leaves every intent outstanding", () =>
    Effect.gen(function*() {
      const store = Memory.make({ records, edges, failAt: "abandonForkIntents" })
      const childRunId = yield* (store.nextForkId("parent", { lineageId: "parent/root", seq: 0 }))
      const before = store.state()
      expect(before.forkIntents).toEqual([
        { childRunId, parentRunId: "parent", parentSeq: 0, reservedAtMs: 0 }
      ])

      const failure = yield* (Effect.flip(store.abandonForkIntents(1)))

      expect(failure).toMatchObject({ code: "unknown", message: "injected failure at abandonForkIntents" })
      expect(store.state()).toEqual(before)
    }))

  it.effect("reports a missing audit without changing the stored audit history", () =>
    Effect.gen(function*() {
      const store = Memory.make()
      const failure = yield* (Effect.flip(store.updateAudit("missing", { status: "failed" })))

      expect(failure).toMatchObject({ code: "not_found", message: "audit missing was not found" })
      expect(store.state().audits).toEqual([])
    }))

  it.effect("normalizes unexpected in-memory transaction failures and restores state", () =>
    Effect.gen(function*() {
      const malformed = {
        runId: "parent",
        seq: 1,
        eventId: "malformed",
        lineageId: "parent/root",
        payload: null
      }
      Object.defineProperty(malformed, "runId", {
        get: () => {
          throw Object.assign(new Error("record read failed"), { code: "EIO" })
        }
      })
      const store = Memory.make({ records: [malformed] })
      const before = store.state()

      const failure = yield* (
        Effect.flip(store.archiveAndTruncate("parent", { lineageId: "parent/root", seq: 0 }, [], owner))
      )

      expect(failure).toMatchObject({ code: "unknown", message: "memory transaction failed" })
      expect(store.state()).toEqual(before)
    }))

  it.effect("does not consume a fork identity when an in-memory transaction rolls back", () =>
    Effect.gen(function*() {
      let reads = 0
      const flaky = {
        runId: "parent",
        seq: 0,
        eventId: "parent-0",
        lineageId: "parent/root",
        payload: null
      }
      Object.defineProperty(flaky, "runId", {
        enumerable: true,
        get: () => {
          reads += 1
          if (reads === 1) throw new Error("transient record read failure")
          return "parent"
        }
      })
      const store = Memory.make({ records: [flaky] })

      const failure = yield* (
        Effect.flip(store.createFork("parent", { lineageId: "parent/root", seq: 0 }))
      )
      const fork = yield* (
        store.createFork("parent", { lineageId: "parent/root", seq: 0 })
      )

      expect(failure).toMatchObject({ code: "unknown", message: "memory transaction failed" })
      expect(fork.runId).toBe("parent:fork:0:1")
      expect(store.state().edges).toEqual([fork.edge])
    }))
})
