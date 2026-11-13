import { describe, expect, it } from "@effect/vitest"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import type * as Statement from "effect/sql/Statement"
import * as Migrations from "../src/Migrations.ts"
import * as SqlJournal from "../src/SqlJournal.ts"

const previous = {
  ...Migrations.set,
  migrations: Object.fromEntries(
    Object.entries(Migrations.set.migrations).filter(([id]) => id < "0003_startup_index")
  )
}
const other: DatabaseMigrations.MigrationSet = {
  namespace: "later-package",
  idOffset: 4000,
  migrations: { "0001_initial": Effect.void }
}

describe("journal startup ordering", () => {
  it.effect("upgrades a retained database after higher package migrations and avoids a history sort", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* DatabaseMigrations.run([previous, other])
      yield* sql`WITH RECURSIVE numbers(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM numbers WHERE n < 4999)
      INSERT INTO flows_journal_events (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
      SELECT CASE WHEN n % 2 = 0 THEN 'run-a' ELSE 'run-b' END, n, 'event-' || n, 'source', n, n / 3, 'event', '{}', 'null' FROM numbers`
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
      // Construct the real journal against the retained schema to capture its
      // startup read, including the configured cache bound.
      yield* Effect.scoped(Effect.void.pipe(Effect.provide(
        SqlJournal.layer({ capacity: 1, overflow: "reject", sourceEventCache: 20 }).pipe(Layer.provide(recording))
      )))
      const startup = queries.find(([text]) => text.includes("FROM flows_journal_events") && text.includes("ORDER BY"))
      expect(startup).toBeDefined()
      const query = sql.unsafe(startup![0], startup![1])
      const expected = yield* query
      expect(expected).toHaveLength(20)
      const before = yield* TestDatabase.explain(sql, query)
      expect(before.some((row) => /TEMP B-TREE|Sort/.test(row.detail))).toBe(true)
      expect(yield* DatabaseMigrations.run([Migrations.set, other])).toEqual([
        [3, "journal_startup_index"],
        [4, "journal_dedup"],
        [5, "journal_run_event_type"],
        [6, "journal_consensus"]
      ])
      const after = yield* TestDatabase.explain(sql, query)
      expect(after.some((row) => row.detail.includes("flows_journal_events_startup_idx"))).toBe(true)
      expect(after.some((row) => /TEMP B-TREE|Sort/.test(row.detail))).toBe(false)
      expect(yield* query).toEqual(expected)
      expect(yield* DatabaseMigrations.run([Migrations.set, other])).toEqual([])
      expect((yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM flows_journal_events`)[0]!.count).toBe(5000)
    }).pipe(Effect.provide(TestDatabase.layer)))
})
