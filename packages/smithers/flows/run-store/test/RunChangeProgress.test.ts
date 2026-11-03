import { expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Journal, JournalEvent, SqlJournal } from "@smthrs/journal"
import * as SqlConsensus from "@smthrs/journal/SqlConsensus"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as Migrations from "../src/Migrations.vibe"

const database = Layer.provideMerge(Migrations.layer, TestDatabase.layer)
const layer = Layer.provideMerge(
  SqlJournal.layerWith({ capacity: 1024, overflow: "reject" }).pipe(Layer.provide(SqlConsensus.layer)),
  database
)

it.effect("journal inserts coalesce per run and roll back with their transaction", () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const journal = yield* Journal.Journal
    yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
      VALUES ('a', 'pending', 1, '{}'), ('b', 'pending', 1, '{}')`
    const revision = () =>
      sql<{ revision: number }>`SELECT revision FROM flows_run_source`.pipe(
        Effect.map((rows) => Number(rows[0]!.revision))
      )
    let sequence = 0
    const input = (runId: string) =>
      new JournalEvent.Input({
        runId: JournalEvent.RunId.make(runId),
        sourceId: JournalEvent.SourceId.make("trail"),
        sourceSeq: JournalEvent.SourceSeq.make(sequence++),
        eventType: "agent.turn",
        payload: {}
      })
    const before = yield* revision()
    yield* journal.emitLossy(input("a"))
    yield* journal.flush
    expect(yield* revision()).toBe(before + 1)
    // One statement gives both inserts the same database time on either backend.
    yield* sql`UPDATE flows_runs SET progress_at_ms = 1 WHERE run_id = 'a'`
    const burst = yield* revision()
    yield* sql`INSERT INTO flows_journal_events
      (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
      VALUES ('a', 100, 'burst-1', 'burst', 0, 1, 'agent.turn', '{}', '{}'),
             ('a', 101, 'burst-2', 'burst', 1, 1, 'agent.turn', '{}', '{}')`
    expect(yield* revision()).toBe(burst + 1)
    // Freeze eligibility independently of latency between PostgreSQL statements.
    yield* sql`UPDATE flows_runs SET progress_at_ms = 9007199254740991 WHERE run_id = 'a'`
    const throttled = yield* revision()
    yield* journal.emitDurableUnfenced(input("a"))
    expect(yield* revision()).toBe(throttled)
    yield* journal.emitDurableUnfenced(input("b"))
    expect(yield* revision()).toBe(throttled + 1)
    yield* journal.emitDurableUnfenced(input("absent"))
    expect(yield* revision()).toBe(throttled + 1)
    yield* sql`UPDATE flows_runs SET progress_at_ms = 1 WHERE run_id = 'a'`
    const eligible = yield* revision()
    const events = yield* sql`SELECT event_id FROM flows_journal_events ORDER BY event_id`
    const failed = yield* Effect.result(sql.withTransaction(
      journal.emitDurableUnfenced(input("a")).pipe(Effect.andThen(Effect.fail("rollback")))
    ))
    expect(failed._tag).toBe("Failure")
    expect(yield* revision()).toBe(eligible)
    expect(yield* sql`SELECT event_id FROM flows_journal_events ORDER BY event_id`).toEqual(events)
    yield* journal.emitDurableUnfenced(input("a"))
    expect(yield* revision()).toBe(eligible + 1)
    // Old event time cannot suppress progress: the trigger uses insertion time.
    yield* sql`UPDATE flows_runs SET progress_at_ms = 1 WHERE run_id = 'a'`
    const oldTime = yield* revision()
    yield* sql`INSERT INTO flows_journal_events
      (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
      VALUES ('a', 200, 'old-time', 'old-time', 0, 1, 'agent.turn', '{}', '{}')`
    expect(yield* revision()).toBe(oldTime + 1)
    const progress = yield* sql<{ progress_at_ms: number }>`SELECT progress_at_ms FROM flows_runs WHERE run_id = 'a'`
    expect(Number(progress[0]!.progress_at_ms)).toBeGreaterThan(1)
  }).pipe(Effect.provide(layer), Effect.scoped))
