import * as TestSchemas from "../src/TestSchemas.ts"
/**
 * `Dialect.readTransaction`: one snapshot for every statement in it, and no
 * writer lock, on each kind of client.
 *
 * A snapshot read validates rows against a position it read first. On
 * PostgreSQL, READ COMMITTED gives each statement its own snapshot, so a writer
 * committing between the two reads made a consistent store look corrupt
 * (#2175). Every statement on a `PostgresDatabase` reserved connection runs as
 * its own transaction, so the client opens the read transaction itself.
 */
import * as Pg from "@effect/sql-pg"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Redacted } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as Dialect from "../src/Dialect.ts"
import { PostgresDatabase } from "../src/index.vibe"
import * as TestDatabase from "../src/test/TestDatabase.ts"
import { listening, pgbouncerUrl } from "./harness/listening.ts"

const count = (sql: SqlClient.SqlClient, table = "snapshot_probe") =>
  Effect.map(
    sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM ${sql(table)}`,
    (rows) => Number(rows[0]!.count)
  )

/**
 * Reads `table` twice in one read transaction while a write transaction
 * commits between the reads, and returns both counts and the count after.
 */
const readAcrossCommit = (table = "snapshot_probe") =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE ${sql(table)} (n INTEGER NOT NULL)`
    yield* sql`INSERT INTO ${sql(table)} (n) VALUES (1)`
    const firstRead = yield* Deferred.make<void>()
    const written = yield* Deferred.make<void>()
    const writer = yield* Effect.forkChild(Effect.gen(function*() {
      yield* Deferred.await(firstRead)
      // Under the writer lock on `PostgresDatabase`, which a read must not hold.
      yield* sql.withTransaction(sql`INSERT INTO ${sql(table)} (n) VALUES (2)`)
      yield* Deferred.succeed(written, undefined)
    }))
    const counts = yield* Dialect.readTransaction(
      sql,
      Effect.gen(function*() {
        const before = yield* count(sql, table)
        yield* Deferred.succeed(firstRead, undefined)
        yield* Deferred.await(written)
        return [before, yield* count(sql, table)]
      })
    )
    yield* Fiber.join(writer)
    return { counts, after: yield* count(sql, table) }
  })

/** A write in a read transaction, which PostgreSQL refuses and SQLite runs and then rolls back. */
const failingRead = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE snapshot_probe (n INTEGER NOT NULL)`
  const exit = yield* Effect.exit(Dialect.readTransaction(
    sql,
    sql`INSERT INTO snapshot_probe (n) VALUES (1)`.pipe(Effect.andThen(Effect.fail("refused" as const)))
  ))
  return { exit, after: yield* count(sql) }
})

describe("Dialect.readTransaction", () => {
  it.effect("joins the caller's transaction, seeing its uncommitted writes", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE snapshot_probe (n INTEGER NOT NULL)`
      const seen = yield* sql.withTransaction(
        sql`INSERT INTO snapshot_probe (n) VALUES (1)`.pipe(Effect.andThen(Dialect.readTransaction(sql, count(sql))))
      )
      expect(seen).toBe(1)
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("rolls back and fails with the effect's failure", () =>
    Effect.gen(function*() {
      const { after, exit } = yield* failingRead
      expect(exit._tag).toBe("Failure")
      expect(after).toBe(0)
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("commits a read that succeeds, leaving the connection free for the next statement", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE snapshot_probe (n INTEGER NOT NULL)`
      expect(yield* Dialect.readTransaction(sql, count(sql))).toBe(0)
      yield* sql`INSERT INTO snapshot_probe (n) VALUES (1)`
      expect(yield* Dialect.readTransaction(sql, count(sql))).toBe(1)
    }).pipe(Effect.provide(TestDatabase.layer)))
})

const postgres = process.env.SMITHERS_TEST_PG_URL
const endpoints = [
  { name: "PostgreSQL", url: postgres, start: "`pnpm coverage` provides a server" },
  {
    name: "PgBouncer with pool_mode=transaction",
    url: pgbouncerUrl,
    start: "run `docker compose up -d pgbouncer` in apps/mvp"
  }
]

for (const endpoint of endpoints) {
  const url = endpoint.url
  const absent = url === undefined
    ? `SMITHERS_TEST_PG_URL is unset; ${endpoint.start}`
    : await listening(url)
    ? undefined
    : `nothing listens on ${new URL(url).host}; ${endpoint.start}`

  describe(`Dialect.readTransaction on ${endpoint.name}`, () => {
    if (url === undefined || absent !== undefined) {
      it.skip(`skipped: ${absent}`, () => {})
      return
    }
    const database = (schema: string) =>
      Layer.effectDiscard(Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* Effect.addFinalizer(() => TestDatabase.dropSchema(sql, schema).pipe(Effect.orDie))
      })).pipe(Layer.provideMerge(PostgresDatabase.layer({ url, driver: Pg, schema })))
    const schema = () => TestSchemas.schemaName("snapshot")

    it.live("a PostgresDatabase read sees one snapshot while a writer commits, and takes no writer lock", () =>
      Effect.gen(function*() {
        const { after, counts } = yield* readAcrossCommit().pipe(Effect.provide(database(schema())))
        expect(counts).toEqual([1, 1])
        expect(after).toBe(2)
      }))

    it.live("a PostgresDatabase read refuses a write and rolls back", () =>
      Effect.gen(function*() {
        const { after, exit } = yield* failingRead.pipe(Effect.provide(database(schema())))
        expect(exit._tag).toBe("Failure")
        expect(after).toBe(0)
      }))

    it.live("another PostgreSQL client reads one snapshot on a reserved connection", () =>
      Effect.gen(function*() {
        const table = schema()
        const { after, counts } = yield* Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* Effect.addFinalizer(() => sql`DROP TABLE IF EXISTS ${sql(table)}`.pipe(Effect.orDie))
          return yield* readAcrossCommit(table)
        }).pipe(Effect.scoped, Effect.provide(Pg.PgClient.layer({ url: Redacted.make(url), maxConnections: 4 })))
        expect(counts).toEqual([1, 1])
        expect(after).toBe(2)
      }))
  })
}
