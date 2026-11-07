/**
 * `ObjectDatabase` in Node, over a `node:sqlite` copy of a Durable Object's
 * storage that refuses transaction SQL as the real one does
 * (`fixtures/SqliteStorage.ts`): statements, transactions and the engine's
 * read transactions all run, the transactions in `storage.transaction()`.
 * `ObjectDatabaseWorkerd.test.ts` runs a whole flow on the real storage.
 */
import { SqliteClient } from "@effect/sql-sqlite-do"
import { describe, expect, it } from "@effect/vitest"
import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as SqlClient from "effect/sql/SqlClient"
import { ObjectDatabase } from "../src/index.ts"
import * as SqliteStorage from "./fixtures/SqliteStorage.ts"

describe("ObjectDatabase", () => {
  it.effect("commits a transaction, rolls a failed one back, and nests one as a savepoint", () => {
    const store = SqliteStorage.make()
    return Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE notes (n INTEGER NOT NULL)`
      yield* sql.withTransaction(sql`INSERT INTO notes (n) VALUES (1)`)
      const failed = yield* Effect.exit(sql.withTransaction(Effect.gen(function*() {
        yield* sql`INSERT INTO notes (n) VALUES (2)`
        return yield* Effect.fail("refused")
      })))
      expect(Exit.isFailure(failed)).toBe(true)
      yield* sql.withTransaction(Effect.gen(function*() {
        yield* sql`INSERT INTO notes (n) VALUES (3)`
        yield* Effect.exit(sql.withTransaction(
          Effect.andThen(sql`INSERT INTO notes (n) VALUES (4)`, Effect.fail("inner refused"))
        ))
      }))
      expect(yield* sql<{ readonly n: number }>`SELECT n FROM notes ORDER BY n`).toEqual([{ n: 1 }, { n: 3 }])
      expect(store.transactions()).toBe(4)
    }).pipe(Effect.provide(ObjectDatabase.layer(store.storage)))
  })

  it.effect("runs the engine's read transactions in storage.transaction(), where BEGIN is refused", () => {
    const store = SqliteStorage.make()
    return Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE notes (n INTEGER NOT NULL)`
      yield* sql`INSERT INTO notes (n) VALUES (1), (2)`
      // The client is the Durable Object driver's own, so its transactions use storage, never SQL.
      expect(SqliteClient.TypeId in sql).toBe(true)
      const before = store.transactions()
      const counted = yield* Dialect.readTransaction(
        sql,
        Effect.map(sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM notes`, (rows) => rows[0]!.count)
      )
      expect(counted).toBe(2)
      expect(store.transactions()).toBe(before + 1)
    }).pipe(Effect.provide(ObjectDatabase.layer(store.storage)))
  })
})
