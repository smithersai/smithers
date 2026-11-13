import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import type * as Statement from "effect/sql/Statement"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Journal } from "../src/Journal.ts"
import { Input, RunId, SourceId } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlJournal from "../src/SqlJournal.ts"

describe.each(["memory", "file"] as const)("exact event filter (%s)", (storage) => {
  it("filters before pagination, keeps canonical cursors, and uses the composite index", async () => {
    const root = await mkdtemp(join(tmpdir(), "journal-filter-"))
    try {
      const database = DurableWriter.layer().pipe(Layer.provideMerge(NodeDatabase.layer({
        filename: storage === "memory" ? ":memory:" : join(root, "journal.db")
      })))
      const queries: Array<ReturnType<Statement.Statement<unknown>["compile"]>> = []
      const recording = Layer.effect(
        SqlClient.SqlClient,
        Effect.map(SqlClient.SqlClient, (base) =>
          new Proxy(base, {
            apply(target, thisArgument, argumentsList) {
              const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
              if (typeof statement.compile === "function") queries.push(statement.compile())
              return statement
            }
          }))
      )
      const layer = SqlJournal.layer({ capacity: 128, overflow: "reject" }).pipe(
        Layer.provide(recording),
        Layer.provideMerge(Migrations.layer.pipe(Layer.provideMerge(database)))
      )
      await Effect.runPromise(
        Effect.gen(function*() {
          const journal = yield* Journal, sql = yield* SqlClient.SqlClient
          const runId = RunId.make("filtered"), foreign = RunId.make("foreign")
          const add = (run: RunId, eventType: string) =>
            journal.emitDurableUnfenced(
              new Input({
                runId: run,
                sourceId: SourceId.make("test"),
                eventType,
                payload: { eventType }
              })
            )
          for (const eventType of ["noise", "wanted", "noise", "wanted", "wanted", "noise"]) {
            yield* add(runId, eventType)
          }
          yield* add(foreign, "wanted")
          yield* add(runId, "second")
          const readQuery = () => {
            const query = queries.find(([text]) =>
              text.includes("FROM flows_journal_events") && text.includes("ORDER BY seq")
            )
            expect(query).toBeDefined()
            return sql.unsafe(query![0], query![1])
          }
          queries.length = 0
          const first = yield* journal.entries({ runId, eventTypes: ["wanted"], limit: 2 })
          const singleQuery = readQuery()
          expect(first.entries.map((row) => row.seq)).toEqual([1, 3])
          expect(first.hasMore).toBe(true)
          const second = yield* journal.entries({
            runId,
            eventTypes: ["wanted"],
            after: first.entries[1]!.seq,
            limit: 2
          })
          expect(second.entries.map((row) => row.seq)).toEqual([4])
          expect(second.hasMore).toBe(false)
          expect(yield* journal.entries({ runId, eventTypes: ["absent"], limit: 1 })).toEqual({
            entries: [],
            hasMore: false
          })
          expect((yield* journal.entries({ runId, limit: 10 })).entries.map((row) => row.seq)).toEqual([
            0,
            1,
            2,
            3,
            4,
            5,
            6
          ])
          const newest = yield* journal.entries({ runId, eventTypes: ["wanted"], limit: 1, order: "desc" })
          expect(newest.entries.map((row) => row.seq)).toEqual([4])
          expect(newest.hasMore).toBe(true)
          expect((yield* journal.entries({ runId, after: newest.entries[0]!.seq, limit: 2, order: "desc" }))
            .entries.map((row) => row.seq)).toEqual([6, 5])
          expect(
            (yield* journal.entries({
              runId,
              eventTypes: ["wanted"],
              after: newest.entries[0]!.seq,
              limit: 2,
              order: "desc"
            })).entries
          ).toEqual([])
          expect(
            (yield* journal.entries({ runId, limit: 1, order: "sideways" as "asc" })
              .pipe(Effect.flip)).code
          ).toBe("invalid_event")
          queries.length = 0
          const combined = yield* journal.entries({ runId, eventTypes: ["second", "wanted", "wanted"], limit: 3 })
          const multiQuery = readQuery()
          expect(combined.entries.map((row) => row.seq)).toEqual([1, 3, 4])
          expect(combined.hasMore).toBe(true)
          const remaining = yield* journal.entries({
            runId,
            eventTypes: ["second", "wanted"],
            after: combined.entries[2]!.seq,
            limit: 3
          })
          expect(remaining.entries.map((row) => row.seq)).toEqual([6])
          expect(remaining.hasMore).toBe(false)
          for (const eventTypes of [[], Array.from({ length: 65 }, () => "wanted")]) {
            expect((yield* journal.entries({ runId, eventTypes, limit: 1 }).pipe(Effect.flip)).code).toBe(
              "invalid_event"
            )
          }
          for (const eventType of ["", "bad\u0000type", "\ud800"]) {
            const failure = yield* journal.entries({ runId, eventTypes: [eventType], limit: 1 }).pipe(Effect.flip)
            expect(failure.code).toBe("invalid_event")
          }
          expect(yield* journal.entries({ runId, eventTypes: ["wanted' OR 1=1 --"], limit: 1 })).toEqual({
            entries: [],
            hasMore: false
          })
          const query = yield* TestDatabase.explain(sql, singleQuery)
          expect(
            query.some((row) =>
              row.detail.includes("SEARCH") && row.detail.includes("flows_journal_events_run_event_type_idx")
            )
          ).toBe(true)
          expect(query.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false)
          const multi = yield* TestDatabase.explain(sql, multiQuery)
          expect(
            multi.some((row) =>
              row.detail.includes("SEARCH") && row.detail.includes("flows_journal_events_run_event_type_idx")
            )
          ).toBe(true)
        }).pipe(Effect.scoped, Effect.provide(layer))
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
