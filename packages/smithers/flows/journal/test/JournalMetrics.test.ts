/**
 * The journal write counters: durable and lossy emission receipts land in the
 * registry the caller provided, keyed by channel and receipt.
 */
import { describe, expect, it } from "@effect/vitest"
import { DatabaseError, DurableWriter, type Service as WriterService } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Deferred, Effect, Layer, Logger, Metric } from "effect"
import { TestClock } from "effect/testing"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { Journal } from "../src/Journal.ts"
import { Input, type RunId, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as JournalMetrics from "../src/JournalMetrics.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlJournal from "../src/SqlJournal.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId
const sourceSeq = (value: number): SourceSeq => value as SourceSeq

const input = (sequence: number, payload: unknown = { n: 1 }): Input =>
  new Input({
    runId: runId("run-metrics"),
    sourceId: sourceId("source-metrics"),
    sourceSeq: sourceSeq(sequence),
    eventType: "counted",
    payload
  }, { disableChecks: true })

/** Holds the queued writer inside its transaction so the queue can fill. */
const gatedDatabase = (gate: Deferred.Deferred<void>): Layer.Layer<DurableWriter | SqlClient.SqlClient> =>
  Layer.provideMerge(
    Layer.effect(
      DurableWriter,
      Effect.map(Effect.service(DurableWriter), (writer) => {
        const write: WriterService["write"] = (effect) =>
          Deferred.await(gate).pipe(Effect.andThen(writer.write(effect)))
        return DurableWriter.of({ write })
      })
    ),
    TestDatabase.layer
  )

/** A writer whose every transaction fails, so each lossy batch is lost. */
const failedDatabase: Layer.Layer<DurableWriter | SqlClient.SqlClient> = Layer.provideMerge(
  Layer.succeed(DurableWriter)(
    DurableWriter.of({
      write: () => Effect.fail(new DatabaseError({ code: "io", cause: new Error("sink unavailable") })) as never
    })
  ),
  TestDatabase.layer
)

/** Records every log message so a test can assert a loss was reported. */
const capturedLogs = () => {
  const lines: Array<string> = []
  const logger = Logger.make<unknown, void>(({ message }) => {
    lines.push((Array.isArray(message) ? message : [message]).map(String).join(" "))
  })
  return { lines, layer: Logger.layer([logger]) }
}

const journalLayer = (
  overrides: Partial<SqlJournal.SqlJournalOptions> = {},
  database: Layer.Layer<DurableWriter | SqlClient.SqlClient> = TestDatabase.layer
) =>
  SqlJournal.layer({ capacity: 8, overflow: "reject", ...overrides }).pipe(
    Layer.provideMerge(Layer.provideMerge(Migrations.layer, database))
  )

const withJournal = <A, E>(
  body: Effect.Effect<A, E, Journal | DurableWriter | SqlClient.SqlClient>,
  overrides: Partial<SqlJournal.SqlJournalOptions> = {},
  database: Layer.Layer<DurableWriter | SqlClient.SqlClient> = TestDatabase.layer
) =>
  Effect.scoped(body.pipe(Effect.provide(journalLayer(overrides, database)))).pipe(
    Effect.provide(TestClock.layer()),
    Effect.provideService(Metric.MetricRegistry, new Map())
  )

const count = (metric: Metric.Metric<number, Metric.CounterState<number>>) =>
  Effect.map(Metric.value(metric), (state) => state.count)

describe("JournalMetrics", () => {
  it.effect("counts durable and lossy receipts through the provided registry", () =>
    Effect.gen(function*() {
      yield* withJournal(Effect.gen(function*() {
        const journal = yield* Journal

        expect((yield* journal.emitDurableUnfenced(input(0)))._tag).toBe("Accepted")
        expect((yield* journal.emitDurableUnfenced(input(0)))._tag).toBe("Duplicate")
        expect((yield* journal.emitLossy(input(1)))._tag).toBe("Accepted")
        expect((yield* journal.emitLossy(input(1)))._tag).toBe("Duplicate")
        yield* journal.flush

        expect(yield* count(JournalMetrics.durable.Accepted)).toBe(1)
        expect(yield* count(JournalMetrics.durable.Duplicate)).toBe(1)
        expect(yield* count(JournalMetrics.lossy.Accepted)).toBe(1)
        expect(yield* count(JournalMetrics.lossy.Duplicate)).toBe(1)
        // A dropped receipt lands in the same table; `Journal.test.ts` proves
        // the drop policies themselves.
        expect(yield* count(JournalMetrics.lossy.Dropped)).toBe(0)
      }))
    }))

  it.effect("counts a drop-newest overflow as lossy.Dropped in the registry", () =>
    Effect.gen(function*() {
      // The cell above leaves `Dropped` at zero, so the overflow receipt could
      // stop reaching the registry without any test noticing. A gated writer
      // holds the first event inside its transaction, which is what lets the
      // one-slot queue fill and the third admission overflow deterministically.
      const gate = Deferred.makeUnsafe<void>()
      yield* withJournal(
        Effect.gen(function*() {
          const journal = yield* Journal

          expect((yield* journal.emitLossy(input(0)))._tag).toBe("Accepted")
          yield* Effect.yieldNow
          expect((yield* journal.emitLossy(input(1)))._tag).toBe("Accepted")
          const dropped = yield* journal.emitLossy(input(2))
          expect(dropped).toMatchObject({ _tag: "Dropped", policy: "drop-newest" })

          expect(yield* count(JournalMetrics.lossy.Dropped)).toBe(1)
          // The drop is counted as a drop, never as an admission.
          expect(yield* count(JournalMetrics.lossy.Accepted)).toBe(2)

          yield* Deferred.succeed(gate, undefined)
          yield* journal.flush
        }).pipe(Effect.ensuring(Deferred.succeed(gate, undefined))),
        { capacity: 1, overflow: "drop-newest", batchSize: 1 },
        gatedDatabase(gate)
      )
    }))

  it.effect("counts and logs a lossy batch the writer lost, with no flush caller", () =>
    Effect.gen(function*() {
      // A telemetry producer never flushes, so the flush-time failure is not
      // an operator signal. The loss has to reach the registry and the log.
      const logs = capturedLogs()
      yield* withJournal(
        Effect.gen(function*() {
          const journal = yield* Journal
          expect((yield* journal.emitLossy(input(0)))._tag).toBe("Accepted")
          expect((yield* journal.emitLossy(input(1)))._tag).toBe("Accepted")
          yield* Effect.flip(journal.flush)

          expect(yield* count(JournalMetrics.lost("sink_failed"))).toBe(2)
        }),
        {},
        failedDatabase
      ).pipe(Effect.provide(logs.layer))
      const loss = logs.lines.filter((line) => line.includes("journal lost"))
      expect(loss.length).toBeGreaterThan(0)
      expect(loss[0]).toContain("sink_failed")
      expect(loss[0]).toContain("run-metrics")
    }))

  it.effect("logs a final flush that fails while the journal closes", () =>
    Effect.gen(function*() {
      const logs = capturedLogs()
      yield* withJournal(
        Effect.gen(function*() {
          const journal = yield* Journal
          yield* journal.emitLossy(input(0))
        }),
        {},
        failedDatabase
      ).pipe(Effect.provide(logs.layer))
      expect(logs.lines.some((line) => line.includes("final flush"))).toBe(true)
    }))
})
