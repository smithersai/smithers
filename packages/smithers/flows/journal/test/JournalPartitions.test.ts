import { TestSchemas } from "@smthrs/database"
/**
 * Runs write their journals side by side on PostgreSQL: every durable append
 * names its run's partition
 * (`packages/smithers/flows/database/docs/decisions/0001-run-writer-locks.md`), so one run's appends wait only
 * for that run's. Each run's journal is its own client, the way each Durable
 * Object builds its own, behind a slow network that charges every round trip
 * what Hyperdrive does, so the time a transaction holds its lock dominates.
 *
 * Runs on `SMITHERS_TEST_PG_URL`; skips where it is unset.
 */
import * as Pg from "@effect/sql-pg"
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter, layer as writerLayer } from "@smthrs/database/DurableWriter"
import * as PostgresDatabase from "@smthrs/database/postgres/PostgresDatabase"
import * as SlowNetwork from "@smthrs/database/test/SlowNetwork"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Clock, Context, Deferred, Duration, Effect, Fiber, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { randomUUID } from "node:crypto"
import { Consensus } from "../src/Consensus.vibe"
import { Journal, JournalError, type Service } from "../src/Journal.vibe"
import { Input, type RunId, type SourceId, type SourceSeq } from "../src/JournalEvent.vibe"
import * as Migrations from "../src/Migrations.vibe"
import type { OwnerId } from "../src/OwnerId.vibe"
import * as SqlConsensus from "../src/SqlConsensus.vibe"
import * as SqlJournal from "../src/SqlJournal.ts"
import * as Leases from "./fixtures/leases.ts"

const url = process.env.SMITHERS_TEST_PG_URL

/** Each chunk waits this long each way: a 10 ms round trip, so the network, not this process, sets the pace. */
const delayMs = 5
/** Entries a not-found clone's run writes. */
const entries = 35
const runs = 8

const owner = (name: string): OwnerId => ({ hostId: name, pid: 1, nonce: name })

const input = (run: RunId, source: string, sequence: number): Input =>
  new Input({
    runId: run,
    sourceId: source as SourceId,
    sourceSeq: sequence as SourceSeq,
    eventType: "flows.engine.node-settled",
    payload: { sequence }
  }, { disableChecks: true })

/** One process: its journal, client and writer, as a Durable Object builds them. */
interface Incarnation {
  readonly journal: Service
  readonly consensus: Consensus["Service"]
  readonly sql: SqlClient.SqlClient
  readonly writer: DurableWriter["Service"]
}

/** An incarnation on `schema` at `databaseUrl`, with its own client, writer and lease strategy. */
const incarnation = (databaseUrl: string, schema: string) =>
  Effect.gen(function*() {
    const database = Layer.provideMerge(
      writerLayer(),
      PostgresDatabase.layer({ url: databaseUrl, driver: Pg, schema, postgres: { maxConnections: 1 } })
    )
    const context = yield* Layer.build(
      SqlJournal.layerWith({ capacity: 64, overflow: "reject" }).pipe(
        Layer.provideMerge(SqlConsensus.layer),
        Layer.provideMerge(Layer.provideMerge(Migrations.layer, database))
      )
    )
    return {
      journal: Context.get(context, Journal) as Service,
      consensus: Context.get(context, Consensus),
      sql: Context.get(context, SqlClient.SqlClient),
      writer: Context.get(context, DurableWriter)
    } satisfies Incarnation
  })

/** Makes `holder` the run's owner through the run's partition, as a takeover commits. */
const take = (process: Incarnation, run: RunId, holder: OwnerId) =>
  process.writer.write(Leases.hold(process.sql, run, holder), { partition: run })

/** Appends a not-found clone's entries to `run`, fenced as its owner. */
const append = (process: Incarnation, run: RunId, holder: OwnerId) =>
  Effect.forEach(
    Array.from({ length: entries }, (_, index) => index),
    (index) => process.journal.emitDurable(input(run, "engine", index), holder),
    { discard: true }
  )

/** Whether a request for `run`'s partition lock in `schema` is waiting. */
const waitingFor = (sql: SqlClient.SqlClient, schema: string, run: RunId) =>
  Effect.map(
    sql<{ readonly waiting: boolean }>`SELECT EXISTS (SELECT 1 FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted AND objsubid = 2
        AND classid::bigint = (hashtext(${schema})::bigint & 4294967295)
        AND objid::bigint = (hashtext(${run})::bigint & 4294967295)) AS waiting`,
    ([row]) => row!.waiting
  )

const seqsOf = (sql: SqlClient.SqlClient, run: RunId) =>
  Effect.map(
    sql<{ readonly seq: number; readonly source_id: string }>`
      SELECT seq, source_id FROM flows_journal_events WHERE run_id = ${run} ORDER BY seq
    `,
    (rows) => rows.map((row) => ({ seq: Number(row.seq), source: row.source_id }))
  )

describe.skipIf(url === undefined)("SqlJournal partitions over PostgreSQL", () => {
  it.live(
    `${runs} runs appending ${entries} entries each finish within three times one run alone`,
    () =>
      Effect.gen(function*() {
        const schema = TestSchemas.schemaName("journal_partitions")
        const slow = yield* SlowNetwork.proxy(url!, { delayMs })
        // One incarnation installs the schema; each run then gets its own.
        const installer = yield* incarnation(slow, schema)
        yield* Effect.addFinalizer(() => TestDatabase.dropSchema(installer.sql, schema).pipe(Effect.orDie))
        const processes = yield* Effect.forEach(
          Array.from({ length: runs + 1 }, () => schema),
          (name) => incarnation(slow, name)
        )
        const ids = Array.from({ length: runs + 1 }, () => `run-${randomUUID()}` as RunId)
        yield* Effect.forEach(ids, (run, index) => take(processes[index]!, run, owner(run)), { discard: true })

        const [alone] = yield* Effect.timed(append(processes[0]!, ids[0]!, owner(ids[0]!)))
        const [together] = yield* Effect.timed(
          Effect.forEach(
            ids.slice(1),
            (run, index) => append(processes[index + 1]!, run, owner(run)),
            { concurrency: "unbounded", discard: true }
          )
        )
        yield* Effect.logInfo("journal partitions").pipe(Effect.annotateLogs({
          aloneMs: Math.round(Duration.toMillis(alone)),
          togetherMs: Math.round(Duration.toMillis(together))
        }))
        // Under one schema-wide lock the eight would take about eight times as long.
        expect(Duration.toMillis(together)).toBeLessThan(3 * Duration.toMillis(alone))
        for (const run of ids) {
          expect((yield* seqsOf(installer.sql, run)).map((row) => row.seq)).toEqual(
            Array.from({ length: entries }, (_, index) => index)
          )
        }
      }),
    120_000
  )

  it.live(
    "two incarnations of one run: the takeover waits for the stale one's open append, which then loses its fence",
    () =>
      Effect.gen(function*() {
        const schema = TestSchemas.schemaName("journal_incarnations")
        const first = yield* incarnation(url!, schema)
        yield* Effect.addFinalizer(() => TestDatabase.dropSchema(first.sql, schema).pipe(Effect.orDie))
        const [second, observer] = [yield* incarnation(url!, schema), yield* incarnation(url!, schema)]
        const run = `run-${randomUUID()}` as RunId
        // One host: the successor proves the stale owner's process gone.
        const stale: OwnerId = { hostId: "host", pid: 1, nonce: "stale" }
        const successor: OwnerId = { hostId: "host", pid: 2, nonce: "successor" }
        yield* take(first, run, stale)

        // The stale incarnation's append has passed its fence and inserted,
        // and its transaction is still open.
        const inside = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const appending = yield* first.journal.transact(
          Effect.gen(function*() {
            yield* first.journal.emitDurable(input(run, "stale", 0), stale)
            yield* Deferred.succeed(inside, undefined)
            yield* Deferred.await(gate)
          }),
          { partition: run }
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(inside)

        // The successor's takeover, through the lease strategy, waits for it.
        const nowMs = yield* Clock.currentTimeMillis
        const takeover = yield* Effect.gen(function*() {
          const claimed = yield* second.consensus.steal(run, successor, nowMs, {
            expectedOwner: stale,
            checkedAtMs: nowMs,
            kind: "same-host-pid-dead"
          })
          if (claimed._tag !== "Claimed") return claimed._tag
          return (yield* second.consensus.activate(run, successor, claimed.grantedAtMs, nowMs))._tag
        }).pipe(Effect.forkScoped)
        yield* TestDatabase.until(waitingFor(observer.sql, schema, run))
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(appending)
        expect(yield* Fiber.join(takeover)).toBe("Activated")

        // The successor appends after the stale entry; the stale incarnation
        // cannot append again.
        for (let index = 0; index < 2; index++) {
          yield* second.journal.emitDurable(input(run, "successor", index), successor)
        }
        const lost = yield* Effect.flip(first.journal.emitDurable(input(run, "stale", 1), stale))
        expect(lost).toBeInstanceOf(JournalError)
        expect((lost as JournalError).code).toBe("fence_lost")
        expect(yield* seqsOf(observer.sql, run)).toEqual([
          { seq: 0, source: "stale" },
          { seq: 1, source: "successor" },
          { seq: 2, source: "successor" }
        ])
      }),
    60_000
  )
})
