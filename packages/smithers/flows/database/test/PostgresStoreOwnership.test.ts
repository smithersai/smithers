import * as Pg from "@effect/sql-pg"
import { Cause, Context, Effect, Exit, Layer, Metric } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { isSqlError } from "effect/sql/SqlError"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as DatabaseMetrics from "../src/DatabaseMetrics.ts"
import * as Selection from "../src/internal/PostgresSelection.ts"
import { isUnsupportedDatabase } from "../src/internal/UnsupportedDatabase.ts"
import * as PostgresDatabase from "../src/postgres/PostgresDatabase.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"
import * as TestSchemas from "../src/TestSchemas.ts"
import { connect } from "./harness/connect.ts"

const url = process.env.SMITHERS_TEST_PG_URL
afterEach(() => vi.unstubAllEnvs())

const fixture = <A, E>(body: (admin: SqlClient, schema: string) => Effect.Effect<A, E, import("effect").Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const prefix = TestSchemas.schemaName("ownership")
    const schema = TestSchemas.forStore(prefix, "cache_db")
    vi.stubEnv("SMITHERS_BACKEND", "postgres")
    vi.stubEnv("SMITHERS_POSTGRES_URL", url!)
    vi.stubEnv("SMITHERS_POSTGRES_SCHEMA", prefix)
    const admin = yield* connect(PostgresDatabase.layer({ url: url!, driver: Pg, schema }))
    yield* Effect.addFinalizer(() => TestDatabase.dropSchema(admin, schema).pipe(Effect.orDie))
    return yield* body(admin, schema)
  })))

describe.skipIf(!url)("prefixed PostgreSQL store ownership", () => {
  it("claims legacy schemas without moving data and refuses sanitized aliases on writable and read-only opens", async () => {
    await fixture((admin, schema) =>
      Effect.gen(function*() {
        yield* admin`CREATE TABLE saved_data (value TEXT)`
        yield* admin`INSERT INTO saved_data VALUES ('retained')`
        // Legacy read-only opens do not create ownership metadata.
        const legacy = yield* connect(Selection.layer("cache.db", true)!)
        expect(yield* legacy`SELECT value FROM saved_data`).toEqual([{ value: "retained" }])
        expect(yield* admin`SELECT to_regclass('flows_store_owner') AS owner`).toEqual([{ owner: null }])

        // An empty legacy metadata table is also inspected without claiming it.
        yield* admin`CREATE TABLE flows_store_owner (id INTEGER PRIMARY KEY CHECK (id = 1), basename TEXT NOT NULL)`
        yield* connect(Selection.layer("cache.db", true)!)
        expect(yield* admin`SELECT basename FROM flows_store_owner`).toEqual([])

        const first = yield* connect(Selection.layer("cache.db")!)
        expect(yield* first`SELECT value FROM saved_data`).toEqual([{ value: "retained" }])
        const before = yield* Metric.value(DatabaseMetrics.writerLockWait)
        const same = yield* connect(Selection.layer("another-directory/cache.db")!)
        expect((yield* Metric.value(DatabaseMetrics.writerLockWait)).count).toBe(before.count)
        expect(yield* same`SELECT basename FROM flows_store_owner`).toEqual([{ basename: "cache.db" }])
        yield* connect(Selection.layer("cache.db", true)!)

        for (const basename of ["cache-db", "cache_db"]) {
          for (const readOnly of [false, true]) {
            const exit = yield* Effect.exit(Layer.build(Selection.layer(basename, readOnly)!))
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              const defect = Cause.squash(exit.cause)
              expect(isUnsupportedDatabase(defect)).toBe(true)
              if (isUnsupportedDatabase(defect)) {
                expect(defect.code).toBe("postgres_schema_collision")
                expect(defect.message).toContain("cache.db")
                expect(defect.message).toContain(basename)
                expect(defect.message).toContain(schema)
                expect(defect.message).not.toContain(url!)
              }
            }
          }
        }
        expect(yield* first`SELECT value FROM saved_data`).toEqual([{ value: "retained" }])
        // Explicit URLs intentionally address an existing schema directly.
        const explicit = new URL(url!)
        explicit.searchParams.set("schema", schema)
        yield* connect(Selection.layer(explicit.toString())!)
      })
    )
  })

  it("creates and claims a fresh schema before exposing its store", async () => {
    await fixture((admin, schema) =>
      Effect.gen(function*() {
        yield* TestDatabase.dropSchema(admin, schema)
        const sql = yield* connect(Selection.layer("cache.db")!)
        expect(yield* sql`SELECT basename FROM flows_store_owner`).toEqual([{ basename: "cache.db" }])
        expect(yield* sql`SELECT current_schema() AS schema`).toEqual([{ schema }])
      })
    )
  })

  it("fails closed when a restricted reader cannot inspect the ownership row", async () => {
    await fixture((admin, schema) =>
      Effect.gen(function*() {
        const role = "store_reader_" + crypto.randomUUID().replaceAll("-", "")
        yield* admin`CREATE ROLE ${admin(role)}`
        yield* Effect.addFinalizer(() =>
          Effect.gen(function*() {
            yield* admin`DROP OWNED BY ${admin(role)}`
            yield* admin`DROP ROLE ${admin(role)}`
          }).pipe(Effect.orDie)
        )
        yield* admin`CREATE TABLE saved_data (value TEXT)`
        yield* admin`INSERT INTO saved_data VALUES ('retained')`
        yield* connect(Selection.layer("cache.db")!)
        yield* admin`GRANT USAGE ON SCHEMA ${admin(schema)} TO ${admin(role)}`
        yield* admin`GRANT SELECT ON saved_data TO ${admin(role)}`
        const restricted = new URL(url!)
        restricted.searchParams.set("options", "-c role=" + role)
        vi.stubEnv("SMITHERS_POSTGRES_URL", restricted.toString())

        const inaccessible = yield* Effect.exit(Layer.build(Selection.layer("cache-db", true)!))
        expect(Exit.isFailure(inaccessible)).toBe(true)
        if (Exit.isFailure(inaccessible)) {
          const defect = Cause.squash(inaccessible.cause)
          expect(isSqlError(defect)).toBe(true)
          if (isSqlError(defect)) expect(defect.reason._tag).toBe("AuthorizationError")
        }

        yield* admin`GRANT SELECT ON flows_store_owner TO ${admin(role)}`
        const collision = yield* Effect.exit(Layer.build(Selection.layer("cache-db", true)!))
        expect(Exit.isFailure(collision)).toBe(true)
        if (Exit.isFailure(collision)) {
          const defect = Cause.squash(collision.cause)
          expect(isUnsupportedDatabase(defect)).toBe(true)
          if (isUnsupportedDatabase(defect)) expect(defect.code).toBe("postgres_schema_collision")
        }
        const reader = yield* connect(Selection.layer("cache.db", true)!)
        expect(yield* reader`SELECT value FROM saved_data`).toEqual([{ value: "retained" }])
      })
    )
  })

  it("arbitrates concurrent first opens and keeps a durable owner across new pools", async () => {
    await fixture((admin) =>
      Effect.gen(function*() {
        const results = yield* Effect.all(
          ["cache.db", "cache-db"].map((name) => Effect.exit(Layer.build(Selection.layer(name)!))),
          { concurrency: 2 }
        )
        expect(results.filter(Exit.isSuccess)).toHaveLength(1)
        expect(results.filter(Exit.isFailure)).toHaveLength(1)
        const success = results.find(Exit.isSuccess)!
        const sql = Context.get(success.value, SqlClient)
        const rows = yield* sql<{ basename: string }>`SELECT basename FROM flows_store_owner`
        const owner = rows[0]!.basename
        yield* connect(Selection.layer(owner)!)
        expect(yield* admin`SELECT basename FROM flows_store_owner`).toEqual([{ basename: owner }])
      })
    )
  })
})
