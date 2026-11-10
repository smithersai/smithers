import { expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { Journal } from "../src/Journal.vibe"
import { Input, type RunId, type SourceId, type SourceSeq } from "../src/JournalEvent.vibe"
import * as JournalGeneration from "../src/JournalGeneration.vibe"
import * as Migrations from "../src/Migrations.vibe"
import * as SqlJournal from "../src/SqlJournal.ts"

const stack = SqlJournal.layer({ capacity: 16, overflow: "reject" }).pipe(
  Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
)

it.effect("forgets lossy identities and allocation floors after truncation without affecting another run", () =>
  Effect.scoped(
    Effect.gen(function*() {
      const journal = yield* Journal
      const sql = yield* SqlClient.SqlClient
      const input = (runId: string, sourceSeq?: number) =>
        new Input({
          runId: runId as RunId,
          sourceId: "source" as SourceId,
          ...(sourceSeq === undefined ? {} : { sourceSeq: sourceSeq as SourceSeq }),
          eventType: "event",
          payload: null
        })
      const event = input("rewound", 0)
      yield* journal.emitLossy(event)
      yield* journal.emitLossy(input("rewound", 1))
      yield* journal.emitLossy(input("other", 0))
      yield* journal.flush
      yield* sql`DELETE FROM flows_journal_events WHERE run_id = 'rewound'`
      yield* JournalGeneration.forget([event.runId])
      expect(yield* journal.emitLossy(event)).toMatchObject({ _tag: "Accepted", seq: 0 })
      expect(yield* journal.emitLossy(input("rewound"))).toMatchObject({ _tag: "Accepted", seq: 1 })
      expect(yield* journal.emitLossy(input("other", 0))).toMatchObject({ _tag: "Duplicate", seq: 0 })
      yield* journal.flush
      const rows = yield* sql<{ seq: number; sourceSeq: number }>`
      SELECT seq, source_seq AS "sourceSeq" FROM flows_journal_events WHERE run_id = 'rewound' ORDER BY seq
    `
      expect(rows).toEqual([{ seq: 0, sourceSeq: 0 }, { seq: 1, sourceSeq: 1 }])
    }).pipe(Effect.provide(stack))
  ))

it.effect("can forget a truncation before any journal is opened on the database", () =>
  Effect.scoped(
    Effect.gen(function*() {
      yield* JournalGeneration.forget(["before-open"])
      yield* Effect.gen(function*() {
        const journal = yield* Journal
        const input = new Input({
          runId: "before-open" as RunId,
          sourceId: "source" as SourceId,
          sourceSeq: 0 as SourceSeq,
          eventType: "event",
          payload: null
        })
        expect(yield* journal.emitLossy(input)).toMatchObject({ _tag: "Accepted", seq: 0 })
        yield* journal.flush
      }).pipe(Effect.provide(SqlJournal.layer({ capacity: 16, overflow: "reject" })))
    }).pipe(Effect.provide(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))
  ))
