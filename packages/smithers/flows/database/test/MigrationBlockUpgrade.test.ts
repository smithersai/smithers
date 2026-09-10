import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Duration, Effect, Fiber, Result } from "effect"
import { TestClock } from "effect/testing"
import * as Migrator from "effect/unstable/sql/Migrator"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Migrations from "../src/Migrations.ts"
import * as NodeDatabase from "../src/node/NodeDatabase.ts"
import { connect } from "./harness/connect.ts"

const open = (filename: string) =>
  connect(NodeDatabase.layer({ filename, sqlite: { busyTimeout: Duration.millis(1) } }))

const opened = <A, E>(filename: string, body: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.scoped(Effect.flatMap(open(filename), (sql) => Effect.provideService(body, SqlClient.SqlClient, sql)))

const lower: Migrations.MigrationSet = {
  namespace: "lower",
  idOffset: 0,
  migrations: {
    "0001_initial": Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE lower_rows (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`
      yield* sql`INSERT INTO lower_rows (id, value) VALUES (1, 'original')`
    })
  }
}
const higher: Migrations.MigrationSet = {
  namespace: "higher",
  idOffset: 4000,
  migrations: {
    "0003_initial": Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE higher_rows (id INTEGER PRIMARY KEY)`
    })
  }
}
const lowerAppend = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE INDEX lower_value ON lower_rows(value)`
  yield* sql`INSERT INTO lower_rows (id, value) VALUES (2, 'upgraded')`
})
const nextLower = (append = lowerAppend): Migrations.MigrationSet => ({
  ...lower,
  migrations: { ...lower.migrations, "0002_index": append }
})
const nextHigher: Migrations.MigrationSet = {
  ...higher,
  migrations: {
    ...higher.migrations,
    "0004_next": Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO higher_rows (id) VALUES (1)`
    })
  }
}
const inspect = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return {
    ledger: yield* sql<
      { migration_id: number; name: string }
    >`SELECT migration_id, name FROM flows_migrations ORDER BY migration_id`,
    lower: yield* sql<{ id: number; value: string }>`SELECT id, value FROM lower_rows ORDER BY id`,
    higher: yield* sql<{ id: number }>`SELECT id FROM higher_rows ORDER BY id`,
    indexes: yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'lower_value'`
  }
})
const withFile = <A, E, R>(body: (filename: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const directory = mkdtempSync(join(tmpdir(), "migration-block-upgrade-"))
    try {
      return yield* body(join(directory, "state.sqlite"))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

describe("installed package migration block upgrades", () => {
  for (
    const [label, declared, message] of [
      ["renamed namespace", { ...nextLower(), namespace: "renamed" }, "was recorded as lower_initial"],
      ["renamed applied migration", {
        ...lower,
        migrations: { "0001_rewritten": lower.migrations["0001_initial"]!, "0002_index": lowerAppend }
      }, "was recorded as lower_initial"],
      [
        "foreign namespace without a matching installed migration",
        {
          namespace: "foreign",
          idOffset: 0,
          migrations: { "0002_index": lowerAppend }
        },
        "Migration 2_foreign_index cannot append to installed block 0 without declaring a matching recorded migration"
      ],
      ["partial history without a matching installed migration", {
        ...lower,
        migrations: { "0002_index": lowerAppend }
      }, "Migration 2_lower_index cannot append to installed block 0 without declaring a matching recorded migration"]
    ] as const
  ) {
    it.effect(`refuses ${label} before applying a lower-block append`, () =>
      withFile((filename) =>
        Effect.gen(function*() {
          yield* opened(filename, Migrations.run([lower, higher]))
          const exit = yield* opened(filename, Effect.exit(Migrations.run([declared, higher])))
          expect(exit._tag).toBe("Failure")
          if (exit._tag !== "Failure") return
          const failure = Result.getOrUndefined(Cause.findError(exit.cause))
          expect(failure).toBeInstanceOf(Migrator.MigrationError)
          expect(failure).toMatchObject({ kind: "BadState" })
          expect((failure as Migrator.MigrationError).message).toContain(message)
          expect(yield* opened(filename, inspect)).toEqual({
            ledger: [{ migration_id: 1, name: "lower_initial" }, { migration_id: 4003, name: "higher_initial" }],
            lower: [{ id: 1, value: "original" }],
            higher: [],
            indexes: []
          })
          expect(yield* opened(filename, Migrations.run([lower, higher]))).toEqual([])
        })
      ))
  }

  for (const namespace of ["foreign", "lower"]) {
    it.effect(`refuses ${namespace} without matching history above the global cursor`, () =>
      withFile((filename) =>
        Effect.gen(function*() {
          yield* opened(filename, Migrations.run([lower]))
          let applications = 0
          const declared: Migrations.MigrationSet = {
            namespace,
            idOffset: 0,
            migrations: {
              "0002_index": Effect.gen(function*() {
                applications++
                yield* lowerAppend
              })
            }
          }
          const exit = yield* opened(filename, Effect.exit(Migrations.run([declared])))
          expect(exit._tag).toBe("Failure")
          if (exit._tag !== "Failure") return
          const failure = Result.getOrUndefined(Cause.findError(exit.cause))
          expect(failure).toBeInstanceOf(Migrator.MigrationError)
          expect(failure).toMatchObject({
            kind: "BadState",
            message:
              `Migration 2_${namespace}_index cannot append to installed block 0 without declaring a matching recorded migration`
          })
          expect(applications).toBe(0)
          expect(
            yield* opened(
              filename,
              Effect.gen(function*() {
                const sql = yield* SqlClient.SqlClient
                return yield* sql`SELECT migration_id, name FROM flows_migrations ORDER BY migration_id`
              })
            )
          ).toEqual([{ migration_id: 1, name: "lower_initial" }])
          expect(yield* opened(filename, Migrations.run([nextLower()]))).toEqual([[2, "lower_index"]])
          expect(yield* opened(filename, Migrations.run([nextLower()]))).toEqual([])
        })
      ))
  }

  it.effect("upgrades lower and higher blocks after reopen and preserves old binary migration history", () =>
    withFile((filename) =>
      Effect.gen(function*() {
        expect(yield* opened(filename, Migrations.run([lower, higher])))
          .toEqual([[1, "lower_initial"], [4003, "higher_initial"]])
        expect(yield* opened(filename, Migrations.run([nextHigher, nextLower()])))
          .toEqual([[2, "lower_index"], [4004, "higher_next"]])
        // An older binary may reopen the upgraded database with only its known
        // migrations. Applied future rows must be preserved rather than rerun.
        expect(yield* opened(filename, Migrations.run([lower, higher]))).toEqual([])
        expect(yield* opened(filename, Migrations.run([nextLower(), nextHigher]))).toEqual([])
        expect(yield* opened(filename, inspect)).toEqual({
          ledger: [
            { migration_id: 1, name: "lower_initial" },
            { migration_id: 2, name: "lower_index" },
            { migration_id: 4003, name: "higher_initial" },
            { migration_id: 4004, name: "higher_next" }
          ],
          lower: [{ id: 1, value: "original" }, { id: 2, value: "upgraded" }],
          higher: [{ id: 1 }],
          indexes: [{ name: "lower_value" }]
        })
      })
    ))

  it.effect("rolls back an eligible lower append when a different block contains a historical hole", () =>
    withFile((filename) =>
      Effect.gen(function*() {
        yield* opened(filename, Migrations.run([lower, higher]))
        const missingHistory: Migrations.MigrationSet = {
          ...higher,
          migrations: { ...higher.migrations, "0002_earlier": Effect.void }
        }
        const exit = yield* opened(filename, Effect.exit(Migrations.run([nextLower(), missingHistory])))
        expect(exit._tag).toBe("Failure")
        if (exit._tag !== "Failure") return
        const failure = Result.getOrUndefined(Cause.findError(exit.cause))
        expect(failure).toMatchObject({ kind: "BadState" })
        expect((failure as Migrator.MigrationError).message).toContain("Migration 4002_higher_earlier would be skipped")
        expect(yield* opened(filename, inspect)).toEqual({
          ledger: [{ migration_id: 1, name: "lower_initial" }, { migration_id: 4003, name: "higher_initial" }],
          lower: [{ id: 1, value: "original" }],
          higher: [],
          indexes: []
        })
        expect(yield* opened(filename, Migrations.run([nextLower(), higher]))).toEqual([[2, "lower_index"]])
      })
    ))

  it.effect("serializes two connections appending below the global highwater and applies non-idempotent DDL once", () =>
    withFile((filename) =>
      Effect.gen(function*() {
        yield* opened(filename, Migrations.run([lower, higher]))
        let applications = 0
        const completed = yield* Effect.scoped(Effect.gen(function*() {
          const first = yield* open(filename)
          const second = yield* open(filename)
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const appended = nextLower(Effect.gen(function*() {
            applications++
            yield* lowerAppend
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }))
          const firstRun = yield* Migrations.run([appended, nextHigher]).pipe(
            Effect.provideService(SqlClient.SqlClient, first),
            Effect.forkChild({ startImmediately: true })
          )
          yield* Deferred.await(entered)
          const secondRun = yield* Migrations.run([appended, nextHigher]).pipe(
            Effect.provideService(SqlClient.SqlClient, second),
            Effect.forkChild({ startImmediately: true })
          )
          yield* Effect.yieldNow
          expect(secondRun.pollUnsafe()).toBeUndefined()
          yield* Deferred.succeed(release, undefined)
          yield* TestClock.adjust("1 second")
          return yield* Effect.all([Fiber.join(firstRun), Fiber.join(secondRun)])
        }))
        expect(completed).toEqual([[[2, "lower_index"], [4004, "higher_next"]], []])
        expect(applications).toBe(1)
        const stored = yield* opened(filename, inspect)
        expect(stored.lower).toEqual([{ id: 1, value: "original" }, { id: 2, value: "upgraded" }])
        expect(stored.ledger.map((row) => row.migration_id)).toEqual([1, 2, 4003, 4004])
      })
    ))

  it.effect("retries a rolled-back lower-block append without duplicate completion reports or durable effects", () =>
    withFile((filename) =>
      Effect.gen(function*() {
        yield* opened(filename, Migrations.run([lower, higher]))
        const failedOnce = yield* Deferred.make<void>()
        let attempts = 0
        const retrying: Migrations.MigrationSet = {
          ...lower,
          migrations: {
            ...lower.migrations,
            "0002_index": Effect.gen(function*() {
              attempts++
              yield* lowerAppend
            }),
            "0003_retry": Effect.gen(function*() {
              if (attempts === 1) {
                yield* Deferred.succeed(failedOnce, undefined)
                return yield* new SqlError.SqlError({
                  reason: SqlError.classifySqliteError(
                    Object.assign(new Error("database is busy"), { code: "SQLITE_BUSY" })
                  )
                })
              }
              const sql = yield* SqlClient.SqlClient
              yield* sql`INSERT INTO lower_rows (id, value) VALUES (3, 'after-retry')`
            })
          }
        }
        const running = yield* opened(filename, Migrations.run([retrying, nextHigher])).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(failedOnce)
        yield* TestClock.adjust("1 second")
        expect(yield* Fiber.join(running)).toEqual([[2, "lower_index"], [3, "lower_retry"], [4004, "higher_next"]])
        expect(attempts).toBe(2)
        const stored = yield* opened(filename, inspect)
        expect(stored.lower).toEqual([
          { id: 1, value: "original" },
          { id: 2, value: "upgraded" },
          { id: 3, value: "after-retry" }
        ])
        expect(stored.ledger.map((row) => row.migration_id)).toEqual([1, 2, 3, 4003, 4004])
        expect(yield* opened(filename, Migrations.run([retrying, nextHigher]))).toEqual([])
      })
    ))
})
