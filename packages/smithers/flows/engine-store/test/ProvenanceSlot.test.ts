/**
 * A cache-provenance producer identity names one fact about one cache row, so
 * a re-emission with fresh measurements collapses onto the record already in
 * the slot — but only onto THAT fact. An unrelated event, another key, another
 * action, or another recorded row in the slot surfaces the journal's conflict
 * (review finding flows-engine-store-b/robustness/1).
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as ProvenanceSlot from "../src/internal/ProvenanceSlot.ts"

const runId = "provenance-slot"
const sourceId = "cache:digest-1:expired:recorded-run:7"
const conflict = new Journal.JournalError({ code: "idempotency_conflict", message: "reused with different content" })
const record = new JournalEvent.Input({
  runId: JournalEvent.RunId.make(runId),
  sourceId: JournalEvent.SourceId.make(sourceId),
  sourceSeq: JournalEvent.SourceSeq.make(0),
  eventType: "flows.engine.cache-provenance",
  payload: {
    keyDigest: "digest-1",
    action: "expired",
    ttlMs: 1000,
    ageMs: 1500,
    recordedRunId: "recorded-run",
    recordedEventSeq: 7
  },
  meta: { lineageId: "smithers-journal-lineage/v1:[\"provenance-slot\"]" }
})
const occupying = (overrides: Partial<JournalEvent.Entry> = {}): JournalEvent.Entry =>
  new JournalEvent.Entry({
    runId: JournalEvent.RunId.make(runId),
    seq: JournalEvent.Seq.make(3),
    eventId: "slot",
    sourceId: JournalEvent.SourceId.make(sourceId),
    sourceSeq: JournalEvent.SourceSeq.make(0),
    emittedAtMs: 100,
    eventType: "flows.engine.cache-provenance",
    payload: {
      keyDigest: "digest-1",
      action: "expired",
      ttlMs: 1000,
      ageMs: 1001,
      recordedRunId: "recorded-run",
      recordedEventSeq: 7
    },
    meta: { lineageId: "smithers-journal-lineage/v1:[\"the-fork-parent\"]" },
    ...overrides
  })

const accept = (entries: ReadonlyArray<JournalEvent.Entry>) =>
  ProvenanceSlot.accept({
    journal: Journal.makeNoop({ entries: () => Effect.succeed({ entries, hasMore: false }) }),
    runId,
    record,
    conflict
  }).pipe(Effect.result)

describe("ProvenanceSlot.accept", () => {
  it.effect("collapses onto the same fact re-measured, whatever lineage recorded it", () =>
    Effect.gen(function*() {
      expect(yield* accept([occupying()])).toEqual(Result.succeed(undefined))
    }))

  const rejected: ReadonlyArray<[string, ReadonlyArray<JournalEvent.Entry>]> = [
    ["an empty slot", []],
    ["an unrelated event type", [occupying({ eventType: "unrelated.event" })]],
    ["another key", [
      occupying({
        payload: { keyDigest: "digest-2", action: "expired", recordedRunId: "recorded-run", recordedEventSeq: 7 }
      })
    ]],
    ["another action", [
      occupying({
        payload: { keyDigest: "digest-1", action: "hit", recordedRunId: "recorded-run", recordedEventSeq: 7 }
      })
    ]],
    ["another recorded row", [
      occupying({
        payload: { keyDigest: "digest-1", action: "expired", recordedRunId: "recorded-run", recordedEventSeq: 8 }
      })
    ]],
    ["a payload that is not a record", [occupying({ payload: "expired" })]]
  ]
  for (const [shape, entries] of rejected) {
    it.effect(`surfaces the conflict for ${shape}`, () =>
      Effect.gen(function*() {
        const result = yield* accept(entries)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure).toBe(conflict)
      }))
  }

  it.effect("surfaces a history read failure", () =>
    Effect.gen(function*() {
      const result = yield* ProvenanceSlot.accept({
        journal: Journal.makeNoop({
          entries: () => Effect.fail(new Journal.JournalError({ code: "read_failed", message: "unavailable" }))
        }),
        runId,
        record,
        conflict
      }).pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toMatchObject({ code: "read_failed" })
    }))
})
