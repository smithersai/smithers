import { describe, expect, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Migrations from "../src/Migrations.ts"
import * as NodeDatabase from "../src/node/NodeDatabase.ts"
import { connect } from "./harness/connect.ts"

const open = (filename: string) =>
  connect(NodeDatabase.layer({ filename, sqlite: { busyTimeout: Duration.millis(1) } }))

const runWithConnection = <A, E>(
  filename: string,
  body: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>
) =>
  Effect.scoped(Effect.gen(function*() {
    const sql = yield* open(filename)
    return yield* body(sql).pipe(Effect.provideService(SqlClient.SqlClient, sql))
  }))

const persistentSet: Migrations.MigrationSet = {
  namespace: "file",
  idOffset: 0,
  migrations: {
    "0001_initial": Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE file_rows (id INTEGER PRIMARY KEY, marker TEXT NOT NULL)`
      yield* sql`INSERT INTO file_rows (id, marker) VALUES (1, 'applied-once')`
    })
  }
}

describe("file-backed migrations", () => {
  it.effect("persists migration history across close and reopen without reapplying", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "flows-migrations-file-"))
      const filename = join(directory, "migrations.sqlite")
      try {
        const first = yield* runWithConnection(filename, () => Migrations.run([persistentSet]))
        const reopened = yield* runWithConnection(filename, (sql) =>
          Effect.gen(function*() {
            const completed = yield* Migrations.run([persistentSet])
            const rows = yield* sql<
              { readonly id: number; readonly marker: string }
            >`SELECT id, marker FROM file_rows ORDER BY id`
            const migrations = yield* sql<
              { readonly migration_id: number; readonly name: string }
            >`SELECT migration_id, name FROM ${sql(Migrations.table)} ORDER BY migration_id`
            return { completed, migrations, rows }
          }))

        expect(first).toEqual([[1, "file_initial"]])
        expect(reopened.completed).toEqual([])
        expect(reopened.rows).toEqual([{ id: 1, marker: "applied-once" }])
        expect(reopened.migrations).toEqual([{ migration_id: 1, name: "file_initial" }])
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }))

  it.effect("serializes two connections migrating one file without duplicate application", () =>
    Effect.gen(function*() {
      const directory = mkdtempSync(join(tmpdir(), "flows-migrations-concurrent-"))
      const filename = join(directory, "migrations.sqlite")
      try {
        const result = yield* (
          Effect.scoped(Effect.gen(function*() {
            const sqlA = yield* open(filename)
            const sqlB = yield* open(filename)
            const entered = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const concurrentSet: Migrations.MigrationSet = {
              namespace: "file",
              idOffset: 0,
              migrations: {
                "0001_initial": Effect.gen(function*() {
                  const sql = yield* SqlClient.SqlClient
                  yield* sql`CREATE TABLE file_rows (id INTEGER PRIMARY KEY, marker TEXT NOT NULL)`
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(release)
                  yield* sql`INSERT INTO file_rows (id, marker) VALUES (1, 'applied-once')`
                })
              }
            }
            const firstFiber = yield* Migrations.run([concurrentSet]).pipe(
              Effect.provideService(SqlClient.SqlClient, sqlA),
              Effect.forkChild({ startImmediately: true })
            )
            yield* Deferred.await(entered)
            const secondFiber = yield* Migrations.run([concurrentSet]).pipe(
              Effect.provideService(SqlClient.SqlClient, sqlB),
              Effect.exit,
              Effect.forkChild({ startImmediately: true })
            )
            // The migration retry schedule consumes the caller's Clock. Let
            // the peer observe the lock, commit the winner, then drive that
            // schedule deterministically instead of smuggling in wall time.
            yield* Effect.yieldNow
            yield* Deferred.succeed(release, undefined)
            yield* TestClock.adjust("1 second")
            const second = yield* Fiber.join(secondFiber)
            const first = yield* Fiber.join(firstFiber)
            const rows = yield* sqlA<
              { readonly id: number; readonly marker: string }
            >`SELECT id, marker FROM file_rows ORDER BY id`
            const migrations = yield* sqlA<
              { readonly migration_id: number; readonly name: string }
            >`SELECT migration_id, name FROM ${sqlA(Migrations.table)} ORDER BY migration_id`
            return { first, migrations, rows, second }
          }))
        )

        expect(result.first).toEqual([[1, "file_initial"]])
        expect(Exit.isSuccess(result.second)).toBe(true)
        expect(Exit.isSuccess(result.second) ? result.second.value : "failed").toEqual([])
        expect(result.rows).toEqual([{ id: 1, marker: "applied-once" }])
        expect(result.migrations).toEqual([{ migration_id: 1, name: "file_initial" }])
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }))
})
