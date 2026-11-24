/**
 * Rewind truncation and time-travel reads against the journal's checkpoints,
 * compaction floors and dedup tombstones, on a real SQL journal.
 *
 * `archiveAndTruncate` deleted journal events and nothing else of the
 * journal's, so a checkpoint above the frame outlived the timeline it
 * captured, and a compacted attached child kept a floor and tombstones for a
 * journal that no longer existed.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Migrations from "@smthrs/engine-store/Migrations"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/sql/SqlClient"
import * as JournalPages from "../src/internal/JournalPages.ts"
import * as Replay from "../src/internal/Replay.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import * as TimeTravelStore from "../src/TimeTravelStore.ts"

const owner = { hostId: "host-a", pid: 1234, nonce: "nonce" } as const
const runId = (value: string) => value as JournalEvent.RunId
const seq = (value: number) => value as JournalEvent.Seq

const layer = Layer.mergeAll(
  SqlJournal.layer({ capacity: 64, overflow: "reject" }),
  SqlTimeTravelStore.layer,
  CacheStore.layer
).pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))

/** A run row and a consensus lease both naming {@link owner}, so every fence passes. */
const own = (id: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      INSERT INTO flows_runs
        (run_id, status, created_at_ms, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
      VALUES (${id}, 'running', 0, ${JSON.stringify({ version: 1, flowName: "Demo", payload: {} })},
              ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 0)`
    yield* sql`
      INSERT INTO flows_consensus_leases
        (run_id, owner_host_id, owner_pid, owner_nonce, granted_at_ms, heartbeat_at_ms)
      VALUES (${id}, ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 0, 0)`
  })

const emit = (id: string, count: number) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    for (let index = 0; index < count; index++) {
      yield* journal.emitDurable({
        runId: runId(id),
        sourceId: "producer" as JournalEvent.SourceId,
        sourceSeq: index as JournalEvent.SourceSeq,
        eventType: "test.event",
        payload: { index },
        meta: { lineageId: id }
      }, owner)
    }
  })

const seqs = (id: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly seq: number }>`
      SELECT seq FROM flows_journal_events WHERE run_id = ${id} ORDER BY seq`
    return rows.map((row) => Number(row.seq))
  })

describe("archiveAndTruncate and the journal's checkpoints", () => {
  it.effect("deletes the parent's checkpoints above the frame and keeps the ones at or below it", () =>
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const store = yield* TimeTravelStore.TimeTravelStore
      yield* own("parent")
      yield* emit("parent", 10)
      yield* journal.checkpoint({ runId: runId("parent"), seq: seq(3), state: { at: 3 } }, owner)
      yield* journal.checkpoint({ runId: runId("parent"), seq: seq(8), state: { at: 8 } }, owner)

      yield* store.archiveAndTruncate("parent", { lineageId: "parent", seq: 5 }, [], owner)

      // The checkpoint at 8 captured the abandoned timeline; the one at 3 did not.
      const latest = yield* journal.latestCheckpoint(runId("parent"))
      expect(Option.map(latest, (checkpoint) => [checkpoint.seq, checkpoint.state])).toEqual(
        Option.some([3, { at: 3 }])
      )
      // A compaction on the new timeline therefore floors at 3, never at 8,
      // and the surviving prefix above it stays readable.
      yield* journal.compact({ runId: runId("parent") }, owner)
      expect(yield* seqs("parent")).toEqual([3, 4, 5])
    }).pipe(Effect.provide(layer)))

  it.effect("leaves no checkpoint when the only one lay above the frame", () =>
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const store = yield* TimeTravelStore.TimeTravelStore
      yield* own("parent")
      yield* emit("parent", 10)
      yield* journal.checkpoint({ runId: runId("parent"), seq: seq(8), state: null }, owner)
      yield* store.archiveAndTruncate("parent", { lineageId: "parent", seq: 5 }, [], owner)
      expect(yield* journal.latestCheckpoint(runId("parent"))).toEqual(Option.none())
      const refused = yield* Effect.flip(journal.compact({ runId: runId("parent") }, owner))
      expect(refused.code).toBe("checkpoint_invalid")
    }).pipe(Effect.provide(layer)))

  it.effect("clears a compacted attached child's floor and tombstones with its journal", () =>
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const store = yield* TimeTravelStore.TimeTravelStore
      const sql = yield* SqlClient.SqlClient
      yield* own("parent")
      yield* own("child")
      yield* emit("parent", 6)
      yield* emit("child", 6)
      yield* journal.checkpoint({ runId: runId("child"), seq: seq(4), state: null }, owner)
      yield* journal.compact({ runId: runId("child") }, owner)
      expect((yield* Effect.flip(journal.entries({ runId: runId("child"), limit: 1 }))).code).toBe("compacted")
      yield* sql`
        INSERT INTO flows_time_travel_edges (parent_run_id, parent_seq, child_run_id, kind, attached)
        VALUES ('parent', 4, 'child', 'child', 1)`

      yield* store.archiveAndTruncate("parent", { lineageId: "parent", seq: 2 }, [], owner, new Map([["child", owner]]))

      // The emptied child reads as empty, not as compacted.
      expect(yield* journal.entries({ runId: runId("child"), limit: 1 })).toEqual({ entries: [], hasMore: false })
      expect(yield* journal.latestCheckpoint(runId("child"))).toEqual(Option.none())
      expect(yield* sql`SELECT 1 FROM flows_journal_dedup WHERE run_id = 'child'`).toEqual([])
      // The re-run child writes its first records again under the same
      // source coordinates; a surviving tombstone would silently drop them.
      yield* emit("child", 2)
      expect(yield* seqs("child")).toHaveLength(2)
    }).pipe(Effect.provide(layer)))
})

describe("time travel over a compacted run", () => {
  const compacted = Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* own("parent")
    yield* emit("parent", 10)
    yield* journal.checkpoint({ runId: runId("parent"), seq: seq(5), state: null }, owner)
    yield* journal.compact({ runId: runId("parent") }, owner)
  })
  const refusal = {
    code: "not_found",
    message: "run parent is compacted through sequence 5; history below that checkpoint no longer exists"
  }

  it.effect("refuses to truncate or fork it, and changes nothing", () =>
    Effect.gen(function*() {
      const store = yield* TimeTravelStore.TimeTravelStore
      const sql = yield* SqlClient.SqlClient
      yield* compacted
      const image = Effect.all({
        events: seqs("parent"),
        checkpoints: sql`SELECT seq FROM flows_journal_checkpoints`,
        archive: sql`SELECT 1 FROM flows_time_travel_archive`,
        runs: sql`SELECT run_id FROM flows_runs`
      })
      const before = yield* image
      const truncated = yield* Effect.flip(
        store.archiveAndTruncate("parent", { lineageId: "parent", seq: 7 }, [], owner)
      )
      expect(truncated).toMatchObject({ ...refusal, cause: { checkpointSeq: 5 } })
      yield* sql`UPDATE flows_runs SET status = 'completed', owner_host_id = NULL, owner_pid = NULL,
        owner_nonce = NULL, heartbeat_at_ms = NULL WHERE run_id = 'parent'`
      const forked = yield* Effect.flip(store.createFork("parent", { lineageId: "parent", seq: 7 }, "fork"))
      expect(forked).toMatchObject({ ...refusal, cause: { checkpointSeq: 5 } })
      expect(yield* image).toEqual({ ...before })
    }).pipe(Effect.provide(layer)))

  it.effect("reports a paged read below the floor as a typed refusal carrying the floor", () =>
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      yield* compacted
      const options = { runId: "parent", pageSize: 4, label: "test", readFailure: "could not read journal" }
      const read = yield* Effect.flip(JournalPages.forEachPage(journal, options, () => Effect.void))
      expect(read).toMatchObject({ ...refusal, cause: { checkpointSeq: 5, cause: { code: "compacted" } } })
      // From the floor's cursor the retained history pages normally.
      const seen: Array<number> = []
      yield* JournalPages.forEachPage(journal, { ...options, after: 4 }, (entries) =>
        Effect.sync(() => {
          seen.push(...entries.map((entry) => entry.seq))
        }))
      expect(seen).toEqual([5, 6, 7, 8, 9])
      // Replay folds from the first record, so it is refused the same way.
      const replayed = yield* Effect.flip(Replay.rederive(
        { lineageId: "parent", seq: 7 },
        { initial: 0, reduce: (state: number) => state + 1 },
        { runId: "parent" }
      ))
      expect(replayed).toMatchObject(refusal)
    }).pipe(Effect.provide(layer)))
})
