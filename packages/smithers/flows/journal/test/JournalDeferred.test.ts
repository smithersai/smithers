/**
 * `emitDeferred`: a fenced lifecycle entry that commits with its run's next
 * write through the journal, in the order it was emitted, instead of in a
 * transaction of its own. Runs on the test database the matrix selects:
 * SQLite, or PostgreSQL under `SMITHERS_TEST_PG_URL`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Context, Effect, Exit, Layer, Logger, Metric, Scope } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import * as FastCheck from "fast-check"
import { Journal, JournalError, type Service } from "../src/Journal.ts"
import { Input, makeEventId, type RunId, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as JournalMetrics from "../src/JournalMetrics.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/OwnerId.ts"
import * as SqlJournal from "../src/SqlJournal.ts"
import * as Leases from "./fixtures/leases.ts"

const run = "deferred-run" as RunId
const other = "deferred-other" as RunId
const owner: OwnerId = { hostId: "host", pid: 1, nonce: "owner" }
const successor: OwnerId = { hostId: "host", pid: 2, nonce: "successor" }

const input = (runId: RunId, label: string, sourceSeq?: number): Input =>
  new Input({
    runId,
    sourceId: `source/${label}` as SourceId,
    ...(sourceSeq === undefined ? {} : { sourceSeq: sourceSeq as SourceSeq }),
    eventType: "flows.engine.node-settled",
    payload: { label }
  }, { disableChecks: true })

const database = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

/** Runs `body` with a fresh journal, its client and its writer; `owner` holds both runs. */
const withJournal = <A, E>(
  body: (
    journal: Service,
    sql: SqlClient.SqlClient,
    writer: DurableWriter.Service
  ) => Effect.Effect<A, E, Scope.Scope>
) =>
  Effect.scoped(Effect.gen(function*() {
    const context = yield* Layer.build(
      SqlJournal.layer({ capacity: 8, overflow: "reject" }).pipe(Layer.provideMerge(database))
    )
    const sql = Context.get(context, SqlClient.SqlClient)
    yield* Leases.hold(sql, run, owner)
    yield* Leases.hold(sql, other, owner)
    return yield* body(Context.get(context, Journal) as Service, sql, Context.get(context, DurableWriter.DurableWriter))
  })).pipe(Effect.provide(TestClock.layer()), Effect.provideService(Metric.MetricRegistry, new Map()))

/** Runs `body` with a journal whose every write goes through `writer`. */
const withJournalOver = <A, E>(
  writer: DurableWriter.Service,
  body: (journal: Service) => Effect.Effect<A, E, Scope.Scope>
) =>
  Effect.scoped(Effect.gen(function*() {
    const sql = Context.get(yield* Layer.build(database), SqlClient.SqlClient)
    const journal = Context.get(
      yield* Layer.build(
        SqlJournal.layer({ capacity: 8, overflow: "reject" }).pipe(
          Layer.provide(Layer.merge(
            Layer.succeed(DurableWriter.DurableWriter)(writer),
            Layer.succeed(SqlClient.SqlClient)(sql)
          ))
        )
      ),
      Journal
    ) as Service
    return yield* body(journal)
  })).pipe(Effect.provide(TestClock.layer()))

/** The labels `runId` has committed, in sequence order, with their sequences. */
const committed = (sql: SqlClient.SqlClient, runId: RunId) =>
  Effect.map(
    sql<{ readonly seq: number; readonly payload_json: string }>`
      SELECT seq, payload_json FROM flows_journal_events WHERE run_id = ${runId} ORDER BY seq
    `,
    (rows) => rows.map((row) => `${Number(row.seq)}:${(JSON.parse(row.payload_json) as { label: string }).label}`)
  )

/**
 * Loses one lossy entry of `other` with nobody flushing: a competing writer
 * already holds its identity with different content, so the queued writer
 * refuses it as an idempotency conflict and leaves the report for the next
 * flush.
 */
const loseUnflushedEntry = (journal: Service, sql: SqlClient.SqlClient) =>
  Effect.gen(function*() {
    const retried = input(other, "retried", 0)
    yield* sql`
      INSERT INTO flows_journal_events (
        run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
        event_type, payload_json, meta_json
      ) VALUES (
        ${other}, 0, ${makeEventId(other, retried.sourceId, 0 as SourceSeq)}, ${retried.sourceId}, 0, 0,
        'original', '{"label":"original"}', 'null'
      )
    `
    yield* journal.emitLossy(retried)
    const lost = Metric.value(JournalMetrics.lost("idempotency_conflict"))
    yield* TestDatabase.until(Effect.map(lost, (state) => state.count > 0))
    expect((yield* lost).count).toBe(1)
  })

describe("SqlJournal.emitDeferred", () => {
  it.effect("drops only what the owner that lost the run queued", () =>
    withJournal((journal, sql, writer) =>
      Effect.gen(function*() {
        yield* journal.emitDeferred!(input(run, "stale"), owner)
        yield* writer.write(Leases.hold(sql, run, successor), { partition: run })
        yield* journal.emitDeferred!(input(run, "successor"), successor)
        yield* journal.flush
        expect(yield* committed(sql, run)).toEqual(["0:successor"])
      })
    ))

  it.effect("reports a write that could not commit queued entries as a sink failure, and keeps them", () =>
    Effect.gen(function*() {
      const failing = DurableWriter.makeNoop()
      yield* withJournalOver(failing, (journal) =>
        Effect.gen(function*() {
          yield* journal.emitDeferred!(input(run, "kept"), owner)
          const failed = yield* Effect.flip(journal.flush)
          expect((failed as JournalError).code).toBe("sink_failed")
        }))
    }))

  it.effect("commits queued entries with the run's next write, ahead of what it appends", () =>
    withJournal((journal, sql) =>
      Effect.gen(function*() {
        yield* journal.emitDeferred!(input(run, "first"), owner)
        yield* journal.emitDeferred!(input(run, "second"), owner)
        expect(yield* committed(sql, run)).toEqual([])
        const receipt = yield* journal.emitDurable(input(run, "third"), owner)
        expect(receipt.seq).toBe(2)
        expect(yield* committed(sql, run)).toEqual(["0:first", "1:second", "2:third"])
        expect(yield* Effect.map(Metric.value(JournalMetrics.durable.Accepted), (state) => state.count)).toBe(3)
      })
    ))

  it.effect("commits them with a transaction that names the run, not one that names none or another", () =>
    withJournal((journal, sql) =>
      Effect.gen(function*() {
        yield* journal.emitDeferred!(input(run, "queued"), owner)
        yield* journal.transact(Effect.void)
        yield* journal.transact(Effect.void, { partition: other })
        expect(yield* committed(sql, run)).toEqual([])
        yield* journal.transact(Effect.void, { partition: run })
        expect(yield* committed(sql, run)).toEqual(["0:queued"])
      })
    ))

  it.effect("writes at once inside an open transaction", () =>
    withJournal((journal, sql) =>
      Effect.gen(function*() {
        const inside = yield* journal.transact(
          Effect.andThen(journal.emitDeferred!(input(run, "inside"), owner), committed(sql, run))
        )
        expect(inside).toEqual(["0:inside"])
      })
    ))

  it.effect("writes queued entries once in a transaction that writes the run twice", () =>
    withJournal((journal, sql) =>
      Effect.gen(function*() {
        yield* journal.emitDeferred!(input(run, "queued"), owner)
        yield* journal.transact(
          Effect.andThen(
            journal.emitDurable(input(run, "one"), owner),
            journal.emitDurable(input(run, "two"), owner)
          ),
          { partition: run }
        )
        expect(yield* committed(sql, run)).toEqual(["0:queued", "1:one", "2:two"])
      })
    ))

  it.effect("publishes sibling savepoints of one deferred batch once after the outer commit", () =>
    withJournal((journal, sql, writer) =>
      Effect.gen(function*() {
        yield* journal.emitDeferred!(input(run, "queued"), owner)
        yield* writer.write(
          Effect.gen(function*() {
            yield* journal.transact(Effect.void, { partition: run })
            yield* journal.transact(Effect.void, { partition: run })
          }),
          { partition: run }
        )
        expect(yield* committed(sql, run)).toEqual(["0:queued"])
        yield* journal.emitDeferred!(input(run, "next"), owner)
        yield* journal.flush
        expect((yield* committed(sql, run)).map((row) => row.split(":")[1])).toEqual(["queued", "next"])
      })
    ))

  it.effect("keeps queued entries when the write that wrote them rolls back", () =>
    withJournal((journal, sql) =>
      Effect.gen(function*() {
        yield* journal.emitDeferred!(input(run, "queued"), owner)
        const failed = yield* Effect.exit(journal.transact(Effect.fail("refused"), { partition: run }))
        expect(Exit.isFailure(failed)).toBe(true)
        expect(yield* committed(sql, run)).toEqual([])
        yield* journal.emitDurable(input(run, "next"), owner)
        expect((yield* committed(sql, run)).map((row) => row.split(":")[1])).toEqual(["queued", "next"])
      })
    ))

  it.effect("drops what an owner that lost the run queued, and its next fenced write fails", () =>
    withJournal((journal, sql, writer) =>
      Effect.gen(function*() {
        yield* journal.emitDeferred!(input(run, "stale"), owner)
        yield* writer.write(Leases.hold(sql, run, successor), { partition: run })
        yield* journal.emitDurable(input(run, "successor"), successor)
        expect(yield* committed(sql, run)).toEqual(["0:successor"])
        const lost = yield* Effect.flip(journal.emitDurable(input(run, "stale-again"), owner))
        expect((lost as JournalError).code).toBe("fence_lost")
      })
    ))

  it.effect("reports a queued identity conflict once and commits later entries", () =>
    withJournal((journal, sql) =>
      Effect.gen(function*() {
        yield* journal.emitDurable(input(run, "once", 0), owner)
        yield* journal.emitDeferred!(
          new Input({
            runId: run,
            sourceId: "source/once" as SourceId,
            sourceSeq: 0 as SourceSeq,
            eventType: "flows.engine.node-settled",
            payload: { label: "changed" }
          }, { disableChecks: true }),
          owner
        )
        yield* journal.emitDeferred!(input(run, "later"), owner)
        const failed = yield* Effect.flip(journal.flush)
        expect(failed.code).toBe("idempotency_conflict")
        expect(yield* committed(sql, run)).toEqual(["0:once", "2:later"])
        yield* journal.flush
        expect((yield* journal.emitDurable(input(run, "next"), owner))._tag).toBe("Accepted")
        expect(yield* committed(sql, run)).toEqual(["0:once", "2:later", "3:next"])
      })
    ))

  it.effect("a deferred conflict cannot fail its host write, and is logged and counted once", () => {
    const lines: Array<string> = []
    const logger = Logger.make<unknown, void>(({ message }) => {
      lines.push((Array.isArray(message) ? message : [message]).map(String).join(" "))
    })
    return withJournal((journal, sql) =>
      Effect.gen(function*() {
        yield* journal.emitDurable(input(run, "once", 0), owner)
        yield* journal.emitDeferred!(
          new Input({
            ...input(run, "once", 0),
            payload: { label: "changed-private-payload" }
          }, { disableChecks: true }),
          owner
        )
        yield* journal.emitDeferred!(input(run, "later"), owner)
        expect((yield* journal.emitDurable(input(run, "next"), owner))._tag).toBe("Accepted")
        expect((yield* journal.emitDurable(input(run, "another"), owner))._tag).toBe("Accepted")
        expect(yield* committed(sql, run)).toEqual(["0:once", "2:later", "3:next", "4:another"])
        const metric = Metric.withAttributes(JournalMetrics.lostEntries, {
          channel: "deferred",
          code: "idempotency_conflict"
        })
        expect((yield* Metric.value(metric)).count).toBe(1)
        expect((yield* Metric.value(JournalMetrics.lost("idempotency_conflict"))).count).toBe(0)
        expect(lines.filter((line) => line.includes("deferred"))).toHaveLength(1)
        expect(lines.join(" ")).not.toContain("changed-private-payload")
        expect((yield* Effect.flip(journal.flush)).code).toBe("idempotency_conflict")
        yield* journal.flush
        expect((yield* Metric.value(metric)).count).toBe(1)
      })
    ).pipe(Effect.provide(Logger.layer([logger])))
  })

  it.effect("drops an exhausted deferred producer without blocking another producer", () =>
    withJournal((journal, sql) =>
      Effect.gen(function*() {
        yield* journal.emitDurable(input(run, "exhausted", Number.MAX_SAFE_INTEGER - 1), owner)
        yield* journal.emitDeferred!(input(run, "exhausted"), owner)
        yield* journal.emitDeferred!(input(run, "later"), owner)
        yield* journal.flush.pipe(Effect.flip, Effect.map((cause) => expect(cause.code).toBe("invalid_event")))
        expect(yield* committed(sql, run)).toEqual(["0:exhausted", "1:later"])
        yield* journal.flush
        expect((yield* journal.emitDurable(input(run, "next"), owner))._tag).toBe("Accepted")
      })
    ))

  it.effect("keeps valid deferred entries after a host rollback but drops a permanent conflict once", () =>
    withJournal((journal, sql) =>
      Effect.gen(function*() {
        yield* journal.emitDurable(input(run, "once", 0), owner)
        yield* journal.emitDeferred!(
          new Input({
            ...input(run, "once", 0),
            payload: { label: "changed" }
          }, { disableChecks: true }),
          owner
        )
        yield* journal.emitDeferred!(input(run, "kept"), owner)
        const failed = yield* Effect.flip(journal.transact(Effect.fail("refused"), { partition: run }))
        expect(failed).toBe("refused")
        expect(yield* committed(sql, run)).toEqual(["0:once"])
        yield* journal.emitDurable(input(run, "next"), owner)
        expect((yield* committed(sql, run)).map((row) => row.split(":")[1])).toEqual(["once", "kept", "next"])
        expect((yield* Effect.flip(journal.flush)).code).toBe("idempotency_conflict")
        yield* journal.flush
        expect(
          (yield* Metric.value(Metric.withAttributes(JournalMetrics.lostEntries, {
            channel: "deferred",
            code: "idempotency_conflict"
          }))).count
        ).toBe(1)
      })
    ))

  it.effect("retains deferred entries after a SQL failure and commits them when the database recovers", () =>
    withJournal((journal, sql) =>
      Effect.gen(function*() {
        yield* journal.emitDeferred!(input(run, "kept"), owner)
        yield* sql`ALTER TABLE flows_journal_events RENAME TO unavailable_events`
        expect((yield* Effect.flip(journal.flush)).code).toBe("sink_failed")
        yield* sql`ALTER TABLE unavailable_events RENAME TO flows_journal_events`
        expect((yield* journal.emitDurable(input(run, "next"), owner))._tag).toBe("Accepted")
        expect(yield* committed(sql, run)).toEqual(["0:kept", "1:next"])
        yield* journal.flush
      })
    ))

  it.effect("retains deferred entries after a consensus failure and retries when the fence can be read", () =>
    withJournal((journal, sql) =>
      Effect.gen(function*() {
        yield* journal.emitDeferred!(input(run, "kept"), owner)
        yield* sql`ALTER TABLE flows_consensus_leases RENAME TO unavailable_leases`
        const failure = yield* Effect.flip(journal.flush)
        expect(failure.code).toBe("sink_failed")
        expect(failure.cause).toMatchObject({ code: "persistence_failed" })
        expect(yield* committed(sql, run)).toEqual([])
        yield* sql`ALTER TABLE unavailable_leases RENAME TO flows_consensus_leases`
        yield* journal.emitDurable(input(run, "next"), owner)
        expect(yield* committed(sql, run)).toEqual(["0:kept", "1:next"])
        yield* journal.flush
      })
    ))

  it("preserves valid entries and run isolation across arbitrary deferred conflict positions", async () => {
    await FastCheck.assert(
      FastCheck.asyncProperty(
        FastCheck.array(FastCheck.boolean(), { maxLength: 8 }).map((flags) => [true, ...flags]),
        async (conflicts) => {
          await Effect.runPromise(withJournal((journal, sql) =>
            Effect.gen(function*() {
              yield* journal.emitDurable(input(run, "once", 0), owner)
              const expected = ["once"]
              for (const [index, conflict] of conflicts.entries()) {
                const label = `entry-${index}`
                if (conflict) {
                  yield* journal.emitDeferred!(
                    new Input({
                      ...input(run, "once", 0),
                      payload: { label }
                    }, { disableChecks: true }),
                    owner
                  )
                } else {
                  yield* journal.emitDeferred!(input(run, label), owner)
                  expected.push(label)
                }
              }
              yield* journal.emitDeferred!(input(other, "isolated"), owner)
              expect((yield* Effect.flip(journal.flush)).code).toBe("idempotency_conflict")
              expect((yield* committed(sql, run)).map((row) => row.split(":")[1])).toEqual(expected)
              expect(yield* committed(sql, other)).toEqual(["0:isolated"])
              yield* journal.flush
              expect((yield* journal.emitDurable(input(run, "next"), owner))._tag).toBe("Accepted")
              expect((yield* committed(sql, run)).map((row) => row.split(":")[1])).toEqual([...expected, "next"])
              expect(
                (yield* Metric.value(Metric.withAttributes(JournalMetrics.lostEntries, {
                  channel: "deferred",
                  code: "idempotency_conflict"
                }))).count
              ).toBe(conflicts.filter(Boolean).length)
            })
          ))
        }
      ),
      { numRuns: 20 }
    )
  })

  it.effect("keeps a deferred entry when the transaction that conflicted with it rolls back", () =>
    withJournal((journal, sql, writer) =>
      Effect.gen(function*() {
        const queued = input(run, "kept", 0)
        yield* journal.emitDeferred!(queued, owner)
        const failed = yield* Effect.flip(writer.write(
          Effect.gen(function*() {
            yield* sql`
            INSERT INTO flows_journal_events (
              run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
              event_type, payload_json, meta_json
            ) VALUES (
              ${run}, 0, ${makeEventId(run, queued.sourceId, 0 as SourceSeq)}, ${queued.sourceId}, 0, 0,
              'different', '{"label":"temporary"}', 'null'
            )
          `
            yield* journal.transact(Effect.void, { partition: run })
            return yield* Effect.fail("rolled-back")
          }),
          { partition: run }
        ))
        expect(failed).toBe("rolled-back")
        expect(yield* committed(sql, run)).toEqual([])
        const lost = Metric.withAttributes(JournalMetrics.lostEntries, {
          channel: "deferred",
          code: "idempotency_conflict"
        })
        expect((yield* Metric.value(lost)).count).toBe(0)
        yield* journal.flush
        expect((yield* committed(sql, run)).map((row) => row.split(":")[1])).toEqual(["kept"])
        expect((yield* Metric.value(lost)).count).toBe(0)
      })
    ))

  it.effect("reports a deferred failure after an earlier lossy failure instead of losing the report", () =>
    withJournal((journal, sql) =>
      Effect.gen(function*() {
        yield* journal.emitDurable(input(run, "exhausted", Number.MAX_SAFE_INTEGER - 1), owner)
        yield* loseUnflushedEntry(journal, sql)
        yield* journal.emitDeferred!(input(run, "exhausted"), owner)
        yield* journal.emitDeferred!(input(run, "later"), owner)
        expect((yield* Effect.flip(journal.flush)).code).toBe("idempotency_conflict")
        expect(yield* committed(sql, run)).toEqual(["0:exhausted", "1:later"])
        expect((yield* Effect.flip(journal.flush)).code).toBe("invalid_event")
        yield* journal.flush
      })
    ))

  it.effect("counts a deferred conflict once across sibling savepoints", () =>
    withJournal((journal, sql, writer) =>
      Effect.gen(function*() {
        yield* journal.emitDurable(input(run, "once", 0), owner)
        yield* journal.emitDeferred!(
          new Input({
            ...input(run, "once", 0),
            payload: { label: "changed" }
          }, { disableChecks: true }),
          owner
        )
        yield* writer.write(
          Effect.gen(function*() {
            yield* journal.transact(Effect.void, { partition: run })
            yield* journal.transact(Effect.void, { partition: run })
          }),
          { partition: run }
        )
        expect(
          (yield* Metric.value(Metric.withAttributes(JournalMetrics.lostEntries, {
            channel: "deferred",
            code: "idempotency_conflict"
          }))).count
        ).toBe(1)
        expect((yield* Effect.flip(journal.flush)).code).toBe("idempotency_conflict")
        yield* journal.flush
        expect(yield* committed(sql, run)).toEqual(["0:once"])
      })
    ))

  it.effect("commits a queued entry whose identity already committed as a duplicate", () =>
    withJournal((journal, sql) =>
      Effect.gen(function*() {
        yield* journal.emitDurable(input(run, "once", 0), owner)
        yield* journal.emitDeferred!(input(run, "once", 0), owner)
        yield* journal.flush
        expect(yield* committed(sql, run)).toEqual(["0:once"])
        expect(yield* Effect.map(Metric.value(JournalMetrics.durable.Duplicate), (state) => state.count)).toBe(1)
      })
    ))

  it.effect("flush commits every run's queued entries", () =>
    withJournal((journal, sql) =>
      Effect.gen(function*() {
        yield* journal.emitDeferred!(input(run, "one"), owner)
        yield* journal.emitDeferred!(input(other, "two"), owner)
        yield* journal.flush
        expect([yield* committed(sql, run), yield* committed(sql, other)]).toEqual([["0:one"], ["0:two"]])
      })
    ))

  it.effect("commits queued entries when the journal closes, and refuses new ones after", () =>
    Effect.scoped(Effect.gen(function*() {
      const sql = Context.get(yield* Layer.build(database), SqlClient.SqlClient)
      yield* Leases.hold(sql, run, owner)
      const scope = yield* Scope.make()
      const journal = Context.get(
        yield* Layer.buildWithScope(
          SqlJournal.layer({ capacity: 8, overflow: "reject" }).pipe(
            Layer.provide(Layer.provideMerge(DurableWriter.layer(), Layer.succeed(SqlClient.SqlClient)(sql)))
          ),
          scope
        ),
        Journal
      ) as Service
      yield* journal.emitDeferred!(input(run, "at-close"), owner)
      yield* Scope.close(scope, Exit.void)
      expect(yield* committed(sql, run)).toEqual(["0:at-close"])
      const refused = yield* Effect.flip(journal.emitDeferred!(input(run, "after"), owner))
      expect((refused as JournalError).code).toBe("journal_closed")
    })).pipe(Effect.provide(TestClock.layer())))

  it.effect("commits queued entries when it reports another run's earlier lossy loss", () =>
    withJournal((journal, sql) =>
      Effect.gen(function*() {
        yield* loseUnflushedEntry(journal, sql)
        yield* journal.emitDeferred!(input(run, "kept"), owner)
        const failed = yield* Effect.flip(journal.flush)
        expect((failed as JournalError).code).toBe("idempotency_conflict")
        expect(yield* committed(sql, run)).toEqual(["0:kept"])
      })
    ))

  it.effect("commits queued entries at close after another run lost a lossy entry nobody flushed", () =>
    Effect.scoped(Effect.gen(function*() {
      const sql = Context.get(yield* Layer.build(database), SqlClient.SqlClient)
      yield* Leases.hold(sql, run, owner)
      const scope = yield* Scope.make()
      const journal = Context.get(
        yield* Layer.buildWithScope(
          SqlJournal.layer({ capacity: 8, overflow: "reject" }).pipe(
            Layer.provide(Layer.provideMerge(DurableWriter.layer(), Layer.succeed(SqlClient.SqlClient)(sql)))
          ),
          scope
        ),
        Journal
      ) as Service
      yield* loseUnflushedEntry(journal, sql)
      yield* journal.emitDeferred!(input(run, "at-close"), owner)
      yield* Scope.close(scope, Exit.void)
      expect(yield* committed(sql, run)).toEqual(["0:at-close"])
    })).pipe(Effect.provide(TestClock.layer()), Effect.provideService(Metric.MetricRegistry, new Map())))

  it.effect("refuses a malformed owner", () =>
    withJournal((journal) =>
      Effect.gen(function*() {
        const refused = yield* Effect.flip(journal.emitDeferred!(input(run, "orphan"), {} as OwnerId))
        expect((refused as JournalError).code).toBe("invalid_event")
      })
    ))
})
