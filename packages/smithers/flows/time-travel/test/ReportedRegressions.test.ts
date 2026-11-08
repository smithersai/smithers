import { expect, it } from "@effect/vitest"
import { EventTypes } from "@smthrs/engine-store/EventTypes"
import * as Effect from "effect/Effect"
import * as Memory from "../src/MemoryTimeTravelStore.vibe"
import type { Snapshot } from "../src/TimeTravelStore.vibe"

it.effect("isolates seeded records, written anchors, and every snapshot read", () =>
  Effect.gen(function*() {
    const payload = { state: { value: 1 } }
    const frame = { lineageId: "lineage", seq: 0 }
    const snapshot = { runId: "run", frame, changeId: "original" }
    const store = Memory.make({
      records: [{ runId: "run", seq: 0, eventId: "0", payload, eventType: EventTypes.runDecision }],
      snapshots: [snapshot]
    })
    payload.state.value = 2
    snapshot.changeId = "mutated"
    expect(yield* store.stateAt("run", frame)).toBe("{\"value\":1}")
    expect((yield* store.snapshotAt("run", frame))?.changeId).toBe("original")
    const written = { runId: "run", frame: { ...frame, seq: 1 }, changeId: "written" }
    yield* store.recordSnapshot(written)
    written.changeId = "mutated"
    const read = (yield* store.snapshotAt("run", written.frame))!
    ;(read as { changeId: string }).changeId = "read-mutation"
    const latest = yield* store.latestSnapshots("run")
    ;(latest[0]!.frame as { seq: number }).seq = 99
    const state = store.state()
    ;(state.records[0]!.payload as typeof payload).state.value = 9
    ;(state.snapshots[0]! as { changeId: string }).changeId = "state-mutation"
    expect(yield* store.stateAt("run", frame)).toBe("{\"value\":1}")
    expect((yield* store.snapshotAt("run", written.frame))?.changeId).toBe("written")
    expect(store.state().snapshots.map((s) => s.frame.seq)).toEqual([0, 1])
  }))

it.effect("reads inherited lineage evidence for carried children", () =>
  Effect.gen(function*() {
    const store = Memory.make({
      records: [{
        runId: "child",
        seq: 0,
        eventId: "0",
        lineageId: "old",
        eventType: EventTypes.runDecision,
        payload: { state: { inherited: true } }
      }],
      edges: [{ parentRunId: "parent", parentSeq: 1, childRunId: "child", kind: "child", attached: true }]
    })
    expect(yield* store.stateAt("child", { lineageId: "new", seq: 0 })).toBe("{\"inherited\":true}")
  }))

it.effect("rolls back a snapshot batch when a malformed member throws", () =>
  Effect.gen(function*() {
    const store = Memory.make()
    const failure = yield* Effect.flip(store.recordSnapshots([
      { runId: "run", frame: { lineageId: "lineage", seq: 0 }, changeId: "change" },
      null as unknown as Snapshot
    ]))
    expect(failure).toMatchObject({ code: "unknown", message: "memory transaction failed" })
    expect(store.state().snapshots).toEqual([])
  }))
