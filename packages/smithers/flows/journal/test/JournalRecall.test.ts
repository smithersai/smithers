/**
 * `recall` and `recorded`: a resumed run re-emits what its journal already
 * holds, the interpreter's node records and an attempt's lifecycle records,
 * and each re-emission used to cost an INSERT that collided and a SELECT of
 * the row it collided with, in a write transaction. A journal that has read
 * the run's entries answers those from memory: `emitDeferred` drops an
 * identical one, and `recorded` tells a caller it need not emit at all. Runs
 * on the test database the matrix selects: SQLite, or PostgreSQL under
 * `SMITHERS_TEST_PG_URL`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Context, Effect, Layer, Scope } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import type * as Statement from "effect/sql/Statement"
import { TestClock } from "effect/testing"
import { Journal, type JournalError, type Service } from "../src/Journal.ts"
import { Input, type RunId, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/OwnerId.ts"
import * as SqlJournal from "../src/SqlJournal.ts"
import * as Leases from "./fixtures/leases.ts"

const run = "recall-run" as RunId
const other = "recall-other" as RunId
const owner: OwnerId = { hostId: "host", pid: 1, nonce: "owner" }

/** One node record; `sourceSeq: null` emits it with no producer sequence. */
const input = (runId: RunId, label: string, payload: unknown = { label }, sourceSeq: number | null = 0) =>
  new Input({
    runId,
    sourceId: `source/${label}` as SourceId,
    ...(sourceSeq === null ? {} : { sourceSeq: sourceSeq as SourceSeq }),
    eventType: "flows.engine.node-settled",
    payload
  }, { disableChecks: true })

/** Every statement the journals over it build, by its SQL text. */
interface Trace {
  readonly statements: Array<string>
}

const traced = (trace: Trace) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.map(SqlClient.SqlClient, (base) =>
      new Proxy(base, {
        apply(target, receiver, args) {
          const statement = Reflect.apply(target, receiver, args) as Statement.Statement<unknown>
          trace.statements.push(statement.compile()[0].replace(/\s+/g, " ").trim())
          return statement
        }
      }))
  )

/**
 * One database, and a way to open journals over it: each a fresh process's,
 * reading at startup only the `sourceEventCache` most recent entries.
 */
const withDatabase = <A, E>(
  body: (
    open: (sourceEventCache?: number) => Effect.Effect<Service, JournalError, Scope.Scope>,
    sql: SqlClient.SqlClient,
    trace: Trace
  ) => Effect.Effect<A, E, Scope.Scope>
) =>
  Effect.scoped(Effect.gen(function*() {
    const trace: Trace = { statements: [] }
    const database = yield* Layer.build(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
    const sql = Context.get(database, SqlClient.SqlClient)
    yield* Leases.hold(sql, run, owner)
    yield* Leases.hold(sql, other, owner)
    const open = (sourceEventCache?: number) =>
      Effect.map(
        Layer.build(
          SqlJournal.layer({
            capacity: 8,
            overflow: "reject",
            ...(sourceEventCache === undefined ? {} : { sourceEventCache })
          }).pipe(Layer.provide(traced(trace)), Layer.provide(Layer.succeedContext(database)))
        ),
        (context) => Context.get(context, Journal) as Service
      )
    return yield* body(open, sql, trace)
  })).pipe(Effect.provide(TestClock.layer()))

const committed = (sql: SqlClient.SqlClient, runId: RunId) =>
  Effect.map(
    sql<{ readonly seq: number; readonly source_id: string }>`
      SELECT seq, source_id FROM flows_journal_events WHERE run_id = ${runId} ORDER BY seq
    `,
    (rows) => rows.map((row) => `${Number(row.seq)}:${row.source_id}`)
  )

const inserts = (trace: Trace) => trace.statements.filter((text) => text.startsWith("INSERT INTO flows_journal_events"))

describe("SqlJournal.recorded", () => {
  it.effect("knows what this journal committed, by identity and content", () =>
    withDatabase((open) =>
      Effect.gen(function*() {
        const journal = yield* open()
        yield* journal.emitDurable(input(run, "first"), owner)
        expect(yield* journal.recorded!(input(run, "first"))).toBe(true)
        // The same identity with other content is a conflict, which the write reports, never memory.
        expect(yield* journal.recorded!(input(run, "first", { label: "changed" }))).toBe(false)
        expect(yield* journal.recorded!(input(run, "second"))).toBe(false)
        // An entry that names no producer sequence is a new entry every time.
        expect(yield* journal.recorded!(input(run, "first", { label: "first" }, null))).toBe(false)
        // An input the journal refuses is not known; its emit reports why.
        expect(yield* journal.recorded!(input("" as RunId, "first"))).toBe(false)
      })
    ))

  it.effect("does not know an entry it only queued", () =>
    withDatabase((open) =>
      Effect.gen(function*() {
        const journal = yield* open()
        yield* journal.emitLossy(input(run, "queued"))
        expect(yield* journal.recorded!(input(run, "queued"))).toBe(false)
        yield* journal.flush
        expect(yield* journal.recorded!(input(run, "queued"))).toBe(true)
      })
    ))
})

describe("SqlJournal durable allocation", () => {
  it.effect("a durable write reads no sequence floor before its insert, and still allocates above another journal's", () =>
    withDatabase((open, sql, trace) =>
      Effect.gen(function*() {
        const first = yield* open()
        const second = yield* open()
        yield* first.emitDurable(input(run, "a"), owner)
        // The second journal's floor for the run is unknown, and the first's is behind this write.
        yield* second.emitDurable(input(run, "b"), owner)
        trace.statements.length = 0
        yield* first.emitDurable(input(run, "c"), owner)
        // Each statement is a round trip on the production database: the insert allocates its own sequence.
        expect(trace.statements.filter((text) => text.includes("MAX(seq) + 1 AS next"))).toEqual([])
        expect(inserts(trace)).toHaveLength(1)
        expect(yield* committed(sql, run)).toEqual(["0:source/a", "1:source/b", "2:source/c"])
      })
    ))
})

describe("SqlJournal.recall", () => {
  it.effect("reads a run's entries in one statement, so a journal that started without them knows them", () =>
    withDatabase((open, _sql, trace) =>
      Effect.gen(function*() {
        const first = yield* open()
        yield* first.emitDurable(input(run, "a"), owner)
        yield* first.emitDurable(input(run, "b"), owner)
        // Newer entries of another run fill the next journal's startup read.
        yield* TestClock.adjust(1000)
        yield* first.emitDurable(input(other, "x"), owner)
        yield* first.emitDurable(input(other, "y"), owner)
        const second = yield* open(2)
        expect(yield* second.recorded!(input(run, "a"))).toBe(false)
        trace.statements.length = 0
        yield* second.recall!(run)
        expect(trace.statements).toHaveLength(1)
        expect(yield* second.recorded!(input(run, "a"))).toBe(true)
        expect(yield* second.recorded!(input(run, "b"))).toBe(true)
        expect(yield* second.recorded!(input(run, "b", { label: "changed" }))).toBe(false)
      })
    ))

  it.effect("keeps at most sourceEventCache entries, the run's latest", () =>
    withDatabase((open) =>
      Effect.gen(function*() {
        const first = yield* open()
        for (const label of ["a", "b", "c"]) yield* first.emitDurable(input(run, label), owner)
        yield* TestClock.adjust(1000)
        for (const label of ["x", "y"]) yield* first.emitDurable(input(other, label), owner)
        const second = yield* open(2)
        expect(yield* second.recorded!(input(run, "c"))).toBe(false)
        yield* second.recall!(run)
        expect(yield* second.recorded!(input(run, "a"))).toBe(false)
        expect(yield* second.recorded!(input(run, "b"))).toBe(true)
        expect(yield* second.recorded!(input(run, "c"))).toBe(true)
      })
    ))

  it.effect("refuses a run id outside the journal's identifier contract", () =>
    withDatabase((open) =>
      Effect.gen(function*() {
        const journal = yield* open()
        const refused = yield* Effect.flip(journal.recall!("" as RunId))
        expect(refused.code).toBe("invalid_event")
      })
    ))

  it.effect("reports a read that failed", () =>
    withDatabase((open, sql) =>
      Effect.gen(function*() {
        const journal = yield* open()
        yield* sql`DROP TABLE flows_journal_events`
        const failed = yield* Effect.flip(journal.recall!(run))
        expect(failed.code).toBe("read_failed")
      })
    ))
})

describe("SqlJournal.emitDeferred over what the journal holds", () => {
  it.effect("drops an identical re-emission: the run's next write inserts only what is new", () =>
    withDatabase((open, sql, trace) =>
      Effect.gen(function*() {
        const first = yield* open()
        yield* first.emitDurable(input(run, "scheduled"), owner)
        yield* first.emitDurable(input(run, "settled"), owner)
        const resumed = yield* open()
        yield* resumed.recall!(run)
        yield* resumed.emitDeferred!(input(run, "scheduled"), owner)
        yield* resumed.emitDeferred!(input(run, "settled"), owner)
        trace.statements.length = 0
        yield* resumed.emitDurable(input(run, "next"), owner)
        expect(inserts(trace)).toHaveLength(1)
        expect(yield* committed(sql, run)).toEqual(["0:source/scheduled", "1:source/settled", "2:source/next"])
      })
    ))

  it.effect("queues a re-emission with other content, and the write that commits it reports the conflict", () =>
    withDatabase((open, sql) =>
      Effect.gen(function*() {
        const first = yield* open()
        yield* first.emitDurable(input(run, "settled"), owner)
        const resumed = yield* open()
        yield* resumed.recall!(run)
        yield* resumed.emitDeferred!(input(run, "settled", { label: "changed" }), owner)
        const conflict = yield* Effect.flip(resumed.emitDurable(input(run, "next"), owner))
        expect(conflict.code).toBe("idempotency_conflict")
        expect(yield* committed(sql, run)).toEqual(["0:source/settled"])
      })
    ))
})
