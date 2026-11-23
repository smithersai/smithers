import * as Pg from "@effect/sql-pg"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Duration, Effect, Exit, Logger, Metric, Result, Schema, Stream } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import type { Connection } from "effect/sql/SqlConnection"
import { ConnectionError, LockTimeoutError, SqlError, UnknownError } from "effect/sql/SqlError"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as DatabaseMetrics from "../src/DatabaseMetrics.ts"
import * as Dialect from "../src/Dialect.ts"
import * as DurableWriter from "../src/DurableWriter.ts"
import * as PostgresSelection from "../src/internal/PostgresSelection.ts"
import * as ReadOnly from "../src/internal/ReadOnly.ts"
import * as UnsupportedDatabase from "../src/internal/UnsupportedDatabase.ts"
import * as WriteLock from "../src/internal/WriteLock.ts"
import * as Migrations from "../src/Migrations.ts"
import * as NodeDatabase from "../src/node/NodeDatabase.ts"
import * as PostgresDatabase from "../src/postgres/PostgresDatabase.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const silentLogger = Logger.layer([])

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

interface RecordedStmt {
  readonly kind: "execute" | "executeRaw" | "executeValues" | "executeValuesUnprepared" | "executeUnprepared" | "executeStream"
  readonly sql: string
  readonly params: ReadonlyArray<unknown>
}

interface FakePgState {
  readonly log: Array<RecordedStmt>
  schemaExists: boolean
  lockTimeoutsRemaining: number
  failNextStatement: boolean
  commitReturnsRollback: boolean
  failReserve: "none" | "connection" | "auth"
  reserveDelayMs: number
  readonly registeredCodecs: Map<number, { encode: (v: unknown) => unknown; decode: (b: Uint8Array) => Result.Result<unknown, unknown> }>
}

const makeFakePgDriver = (state: FakePgState): PostgresDatabase.Driver => {
  const makeConn = (): Connection => {
    const runStmt = (
      kind: RecordedStmt["kind"],
      sql: string,
      params: ReadonlyArray<unknown>
    ): Effect.Effect<ReadonlyArray<any>, SqlError> =>
      Effect.suspend((): Effect.Effect<ReadonlyArray<any>, SqlError> => {
        state.log.push({ kind, sql, params })
        if (sql.includes("pg_advisory_xact_lock") && state.lockTimeoutsRemaining > 0) {
          state.lockTimeoutsRemaining -= 1
          return Effect.fail(
            new SqlError({
              reason: new LockTimeoutError({
                cause: new Error("canceling statement due to lock timeout"),
                message: "lock timeout",
                operation: "execute"
              })
            })
          )
        }
        if (
          state.failNextStatement &&
          !sql.startsWith("BEGIN") &&
          !sql.startsWith("ROLLBACK") &&
          !sql.startsWith("COMMIT") &&
          !sql.includes("set_config")
        ) {
          state.failNextStatement = false
          return Effect.fail(
            new SqlError({
              reason: new UnknownError({
                cause: new Error("injected statement failure"),
                message: "injected statement failure",
                operation: "execute"
              })
            })
          )
        }
        if (sql.includes("FROM pg_namespace")) {
          return Effect.succeed([{ found: state.schemaExists }])
        }
        if (sql.includes("CREATE SCHEMA")) {
          state.schemaExists = true
          return Effect.succeed([])
        }
        if (sql.includes("FROM pg_constraint") && sql.includes("contype = 'c'")) {
          return Effect.succeed([{ table_name: "items", name: "chk_positive", definition: "CHECK (v > 0)" }])
        }
        if (sql.includes("FROM pg_constraint") && sql.includes("contype = 'f'")) {
          return Effect.succeed([{ table_name: "items", name: "fk_parent", definition: "FOREIGN KEY (p) REFERENCES parents(id)" }])
        }
        if (sql.includes("FROM pg_trigger")) {
          return Effect.succeed([{ table_name: "items" }])
        }
        if (sql.startsWith("EXPLAIN")) {
          return Effect.succeed([{ "QUERY PLAN": "Index Scan on items" }])
        }
        return Effect.succeed([{ ok: 1, sql }])
      })

    return {
      execute: (sql, params) => runStmt("execute", sql, params),
      executeRaw: (sql, params) =>
        Effect.suspend(() => {
          state.log.push({ kind: "executeRaw", sql, params })
          if (sql === "COMMIT" && state.commitReturnsRollback) {
            state.commitReturnsRollback = false
            return Effect.succeed({ command: "ROLLBACK", rows: [] })
          }
          if (sql === "COMMIT") {
            return Effect.succeed({ command: "COMMIT", rows: [] })
          }
          return Effect.succeed({ command: "SELECT", rows: [{ ok: 1 }] })
        }),
      executeValues: (sql, params) =>
        runStmt("executeValues", sql, params).pipe(Effect.as([[1]] as ReadonlyArray<ReadonlyArray<unknown>>)),
      executeValuesUnprepared: (sql, params) =>
        runStmt("executeValuesUnprepared", sql, params).pipe(Effect.as([[1]] as ReadonlyArray<ReadonlyArray<unknown>>)),
      executeUnprepared: (sql, params) => runStmt("executeUnprepared", sql, params),
      executeStream: (sql, params) => {
        state.log.push({ kind: "executeStream", sql, params })
        if (state.failNextStatement) {
          state.failNextStatement = false
          return Stream.fail(
            new SqlError({
              reason: new UnknownError({
                cause: new Error("stream error"),
                message: "stream error",
                operation: "execute"
              })
            })
          )
        }
        return Stream.fromIterable([{ row: 1 }, { row: 2 }, { row: 3 }])
      }
    }
  }

  return {
    PgTypes: {
      ...Pg.PgTypes,
      makeRegistry: () => {
        const reg = Pg.PgTypes.makeRegistry()
        return {
          ...reg,
          register: (oid: number, codec: any) => {
            state.registeredCodecs.set(oid, codec)
            return reg.register(oid, codec)
          }
        }
      }
    },
    PgClient: {
      ...Pg.PgClient,
      make: (options) =>
        Effect.sync(() => {
          const reserve = Effect.gen(function*() {
            if (state.reserveDelayMs > 0) {
              yield* Effect.sleep(Duration.millis(state.reserveDelayMs))
            }
            if (state.failReserve === "connection") {
              return yield* Effect.fail(
                new SqlError({
                  reason: new ConnectionError({
                    cause: new Error("ECONNREFUSED"),
                    message: "ECONNREFUSED",
                    operation: "connect"
                  })
                })
              )
            }
            if (state.failReserve === "auth") {
              return yield* Effect.fail(
                new SqlError({
                  reason: new UnknownError({
                    cause: new Error("password authentication failed"),
                    message: "password authentication failed",
                    operation: "connect"
                  })
                })
              )
            }
            return makeConn()
          })
          return { reserve } as any
        })
    }
  }
}

const ENV_KEYS = ["SMITHERS_POSTGRES_URL", "DATABASE_URL", "SMITHERS_POSTGRES_SCHEMA", "SMITHERS_BACKEND"] as const
const savedEnv: Record<string, string | undefined> = {}
const saveEnv = () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
}
const restoreEnv = () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
}

describe("@smthrs/database Deep Fuzz (PostgresDatabase, PostgresSelection, NodeDatabase & TestDatabase)", () => {
  afterEach(() => {
    restoreEnv()
  })

  it("PostgresSelection.layer & location fuzz: credential-safe validation and deterministic schema mapping", async () => {
    saveEnv()
    const arb = Arbitrary.schema(
      Schema.Struct({
        backend: Schema.Literals(["", "sqlite", "postgres", "POSTGRES"]),
        pgUrl: Schema.Literals([
          "",
          "postgres://user:supersecret@db.internal:5432/app",
          "postgresql://user:supersecret@db.internal/app?schema=custom_s&sslmode=require",
          "mysql://user:supersecret@db.internal/app",
          "postgres://[invalid-host"
        ]),
        dbUrl: Schema.Literals([
          "",
          "postgres://u:supersecret@host/db",
          "file:./local.db",
          "mysql://u:supersecret@host/db",
          "postgres://["
        ]),
        schemaEnv: Schema.Literals(["", "ws_alpha", "My-Workspace!"]),
        target: Schema.Literals([
          ":memory:",
          "",
          "file:memdb?mode=memory",
          "/work/a/.flows/engine.db",
          "/work/b/.flows/engine.db",
          "postgres://user:supersecret@host/db?schema=inline_s",
          "postgresql://host/db"
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.sync(() => {
            process.env.SMITHERS_BACKEND = c.backend
            process.env.SMITHERS_POSTGRES_URL = c.pgUrl
            process.env.DATABASE_URL = c.dbUrl
            process.env.SMITHERS_POSTGRES_SCHEMA = c.schemaEnv

            let threw: unknown
            let layerRes: unknown
            try {
              layerRes = PostgresSelection.layer(c.target)
            } catch (e) {
              threw = e
            }

            if (threw !== undefined) {
              if (!UnsupportedDatabase.isUnsupportedDatabase(threw)) return false
              const msg = (threw as { message: string }).message
              if (msg.includes("supersecret")) return false
              return true
            }

            const loc = PostgresSelection.location(c.target)
            if (layerRes === undefined && loc !== undefined) return false
            if (layerRes !== undefined && loc === undefined) return false
            if (loc !== undefined) {
              if (loc.schema.length === 0 || loc.schema.length > 63) return false
              if (loc.url.includes("schema=")) return false
            }
            return true
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("PostgresDatabase schema validation, PgTypes int8/numeric codecs, compiler unsafe-int conversion, and lone/stream queries", async () => {
    const invalidArb = Arbitrary.schema(
      Schema.Literals([
        "",
        "bad\0schema",
        "a".repeat(64),
        "é".repeat(32),
        "漢".repeat(22)
      ])
    )
    const state0: FakePgState = {
      log: [],
      schemaExists: true,
      lockTimeoutsRemaining: 0,
      failNextStatement: false,
      commitReturnsRollback: false,
      failReserve: "none",
      reserveDelayMs: 0,
      registeredCodecs: new Map()
    }
    const invalidReport = await Effect.runPromise(
      Fuzz.run(
        invalidArb,
        (badSchema) =>
          Effect.sync(() => {
            try {
              PostgresDatabase.layer({
                url: "postgres://localhost/test",
                driver: makeFakePgDriver(state0),
                schema: badSchema
              })
              return false
            } catch (err) {
              return (
                UnsupportedDatabase.isUnsupportedDatabase(err) &&
                (err as { code: string }).code === "postgres_schema_invalid"
              )
            }
          }),
        { seed: seed + 1, executions: Math.min(executions, 30) }
      )
    )
    assertPassed(invalidReport)

    const opSchema = Schema.Literals([
      "qualified",
      "unqualified",
      "raw",
      "values",
      "unprepared",
      "streamFull",
      "streamTake1",
      "streamFail",
      "loneFail",
      "unsafeIntParam",
      "readTx"
    ])
    const arb = Arbitrary.schema(
      Schema.Struct({
        schemaExists: Schema.Boolean,
        readOnly: Schema.Boolean,
        ops: Schema.Array(opSchema).pipe(Schema.check(Schema.isMinLength(2)), Schema.check(Schema.isMaxLength(10)))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ schemaExists, readOnly, ops }) =>
          Effect.gen(function*() {
            const state: FakePgState = {
              log: [],
              schemaExists,
              lockTimeoutsRemaining: 0,
              failNextStatement: false,
              commitReturnsRollback: false,
              failReserve: "none",
              reserveDelayMs: 0,
              registeredCodecs: new Map()
            }
            const layer = PostgresDatabase.layer({
              url: "postgres://localhost/test",
              driver: makeFakePgDriver(state),
              schema: "s_fuzz",
              readOnly
            })
            return yield* Effect.scoped(
              Effect.gen(function*() {
                const sql = yield* SqlClient.SqlClient
                if (ReadOnly.has(sql) !== readOnly) return false

                const createdSchema = state.log.some((l) => l.sql.includes("CREATE SCHEMA"))
                if (createdSchema !== (!readOnly && !schemaExists)) return false

                for (const oid of [Pg.PgTypes.OID.int8, Pg.PgTypes.OID.numeric]) {
                  const codec = state.registeredCodecs.get(oid)
                  if (codec === undefined) return false
                  const encoded = codec.encode(42) as Result.Result<Uint8Array, unknown>
                  if (Result.isFailure(encoded)) return false
                  const decoded = codec.decode(encoded.success)
                  if (Result.isFailure(decoded) || decoded.success !== 42) return false
                  const bigRes = Pg.PgTypes.encode(
                    oid === Pg.PgTypes.OID.numeric ? "9007199254740999" : 9007199254740999n,
                    oid
                  )
                  if (Result.isFailure(bigRes)) return false
                  const bigDecoded = codec.decode(bigRes.success)
                  if (Result.isSuccess(bigDecoded)) return false
                }

                for (const op of ops) {
                  if (op === "qualified") {
                    yield* sql`SELECT * FROM flows_runs WHERE run_id = ${"r1"}`
                  } else if (op === "unqualified") {
                    yield* sql`SELECT 1 AS n`
                  } else if (op === "raw") {
                    yield* sql`SELECT 2`.raw
                  } else if (op === "values") {
                    yield* sql`SELECT 3`.values
                  } else if (op === "unprepared") {
                    yield* sql.unsafe("SELECT 4")
                  } else if (op === "streamFull") {
                    const chunk = yield* Stream.runCollect(sql`SELECT 5`.stream)
                    if (chunk.length !== 3) return false
                  } else if (op === "streamTake1") {
                    const chunk = yield* Stream.runCollect(Stream.take(sql`SELECT 6`.stream, 1))
                    if (chunk.length !== 1) return false
                  } else if (op === "streamFail") {
                    state.failNextStatement = true
                    const r = yield* Effect.result(Stream.runCollect(sql`SELECT 7`.stream))
                    if (Result.isSuccess(r)) return false
                  } else if (op === "loneFail") {
                    state.failNextStatement = true
                    const r = yield* Effect.result(sql`SELECT 8`)
                    if (Result.isSuccess(r)) return false
                  } else if (op === "unsafeIntParam") {
                    const unsafe = 1e20
                    yield* sql`SELECT ${unsafe} AS big`
                  } else if (op === "readTx") {
                    const res = yield* Dialect.readTransaction(sql, sql`SELECT 9`)
                    if (res.length === 0) return false
                  }
                }
                return true
              }).pipe(Effect.provide(layer), Effect.provide(silentLogger))
            )
          }),
        { seed: seed + 2, executions: Math.min(executions, 45) }
      )
    )
    assertPassed(report)
  })

  it("PostgresDatabase transactions, partition locking, widening, savepoints, rollbacks, lock-timeout retries & TestDatabase PG helpers", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        lockTimeouts: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)), Schema.check(Schema.isLessThanOrEqualTo(2))),
        outerPartition: Schema.Literals(["none", "p-alpha", "p-beta"]),
        innerAction: Schema.Literals([
          "widen",
          "join",
          "readOnlySavepoint",
          "cleanDedup",
          "rollbackInner",
          "commitAborted"
        ]),
        runTestHelpers: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (s) =>
          Effect.gen(function*() {
            const outerPart = s.outerPartition === "none" ? undefined : s.outerPartition
            const state: FakePgState = {
              log: [],
              schemaExists: true,
              lockTimeoutsRemaining: s.lockTimeouts,
              failNextStatement: false,
              commitReturnsRollback: false,
              failReserve: "none",
              reserveDelayMs: 0,
              registeredCodecs: new Map()
            }
            const layer = PostgresDatabase.layer({
              url: "postgres://localhost/test",
              driver: makeFakePgDriver(state),
              schema: "s_tx",
              writerLockTimeout: "2 millis"
            })
            return yield* Effect.scoped(
              Effect.gen(function*() {
                const sql = yield* SqlClient.SqlClient
                const writer = DurableWriter.make(sql)

                const runInner = (
                  body: Effect.Effect<void, SqlError | Error>,
                  opts?: { readonly partition?: string | undefined; readonly readOnly?: boolean | undefined }
                ) =>
                  Effect.provideService(
                    Effect.provideService(
                      sql.withTransaction(body),
                      WriteLock.Requested,
                      opts?.partition
                    ),
                    WriteLock.ReadOnlyBody,
                    opts?.readOnly === true
                  )

                const outerBody = Effect.gen(function*() {
                  if (s.innerAction === "widen") {
                    yield* runInner(Effect.asVoid(sql`INSERT INTO t VALUES (1)`), { partition: undefined })
                    yield* runInner(Effect.asVoid(sql`INSERT INTO t VALUES (2)`), { partition: undefined })
                  } else if (s.innerAction === "join") {
                    yield* runInner(Effect.asVoid(sql`INSERT INTO t VALUES (1)`), { partition: "p-gamma" })
                    yield* runInner(Effect.asVoid(sql`INSERT INTO t VALUES (2)`), { partition: "p-gamma" })
                  } else if (s.innerAction === "readOnlySavepoint") {
                    const r = yield* Effect.result(
                      runInner(Effect.fail(new Error("ro-fail")), { partition: outerPart, readOnly: true })
                    )
                    if (Result.isSuccess(r)) return
                  } else if (s.innerAction === "cleanDedup") {
                    yield* runInner(
                      runInner(Effect.asVoid(sql`SELECT 1`), { partition: outerPart }),
                      { partition: outerPart }
                    )
                  } else if (s.innerAction === "rollbackInner") {
                    const r = yield* Effect.result(
                      runInner(
                        Effect.gen(function*() {
                          yield* sql`INSERT INTO t VALUES (1)`
                          return yield* Effect.fail(new Error("inner-abort"))
                        }),
                        { partition: undefined }
                      )
                    )
                    if (Result.isSuccess(r)) return
                  } else if (s.innerAction === "commitAborted") {
                    yield* sql`INSERT INTO t VALUES (1)`
                    state.commitReturnsRollback = true
                  }
                })

                const outerExit = yield* Effect.exit(
                  outerPart !== undefined
                    ? writer.write(outerBody, { partition: outerPart })
                    : writer.write(outerBody)
                )

                if (s.innerAction === "commitAborted") {
                  if (Exit.isSuccess(outerExit)) return false
                } else {
                  if (Exit.isFailure(outerExit)) return false
                }

                if (s.runTestHelpers) {
                  yield* TestDatabase.checks(sql, false)
                  yield* TestDatabase.checks(sql, true)
                  yield* TestDatabase.foreignKeys(sql, false)
                  yield* TestDatabase.foreignKeys(sql, true)
                  yield* TestDatabase.dropTrigger(sql, "trg_test")
                  const cat = TestDatabase.catalog(sql)
                  yield* sql`SELECT * FROM ${cat}`
                  const plan = yield* TestDatabase.explain(sql, sql`SELECT 1`)
                  if (plan.length === 0) return false
                }

                return true
              }).pipe(Effect.provide(layer), Effect.provide(silentLogger))
            )
          }),
        { seed: seed + 3, executions: Math.min(executions, 40) }
      )
    )
    assertPassed(report)
  })

  it("PostgresDatabase connection reserve failure metrics/logging and acquireWarning path", async () => {
    for (const mode of ["connection", "auth"] as const) {
      const state: FakePgState = {
        log: [],
        schemaExists: true,
        lockTimeoutsRemaining: 0,
        failNextStatement: false,
        commitReturnsRollback: false,
        failReserve: mode,
        reserveDelayMs: 0,
        registeredCodecs: new Map()
      }
      const before = await Effect.runPromise(Metric.value(DatabaseMetrics.loginFailures))
      const layer = PostgresDatabase.layer({
        url: "postgres://localhost/test",
        driver: makeFakePgDriver(state),
        schema: "s_fail",
        readOnly: true
      })
      const res = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            return yield* Effect.result(sql`SELECT 1`)
          }).pipe(Effect.provide(layer), Effect.provide(silentLogger))
        )
      )
      expect(Result.isFailure(res)).toBe(true)
      const after = await Effect.runPromise(Metric.value(DatabaseMetrics.loginFailures))
      expect(after.count).toBeGreaterThan(before.count)
    }

    const slowState: FakePgState = {
      log: [],
      schemaExists: true,
      lockTimeoutsRemaining: 0,
      failNextStatement: false,
      commitReturnsRollback: false,
      failReserve: "none",
      reserveDelayMs: 15,
      registeredCodecs: new Map()
    }
    const slowLayer = PostgresDatabase.layer({
      url: "postgres://localhost/test",
      driver: makeFakePgDriver(slowState),
      schema: "s_slow",
      readOnly: true,
      acquireWarning: "5 millis"
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const rows = yield* sql`SELECT 1`
          expect(rows.length).toBeGreaterThan(0)
        }).pipe(Effect.provide(slowLayer), Effect.provide(silentLogger))
      )
    )
  })

  it("NodeDatabase file & read-only lifecycle + TestDatabase SQLite helpers fuzz", async () => {
    const dir = mkdtempSync(join(tmpdir(), "db-deep-fuzz-"))
    try {
      const dbPath = join(dir, "fuzz.db")
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            yield* Migrations.run([
              {
                namespace: "fuzz_store",
                idOffset: 0,
                migrations: {
                  "0001_init_items": Effect.flatMap(
                    SqlClient.SqlClient,
                    (s) => Effect.asVoid(s`CREATE TABLE items (id INTEGER PRIMARY KEY, val INTEGER CHECK (val > 0))`)
                  )
                }
              }
            ])
            yield* sql`CREATE TRIGGER trg_items AFTER INSERT ON items BEGIN SELECT 1; END`
            yield* sql`INSERT INTO items (id, val) VALUES (1, 10)`
            yield* TestDatabase.foreignKeys(sql, false)
            yield* TestDatabase.foreignKeys(sql, true)
            yield* TestDatabase.dropTrigger(sql, "trg_items")
            const cat = TestDatabase.catalog(sql)
            const catRows = yield* sql`SELECT name FROM ${cat}`
            expect(catRows.length).toBeGreaterThan(0)
            const plan = yield* TestDatabase.explain(sql, sql`SELECT * FROM items WHERE id = 1`)
            expect(plan.length).toBeGreaterThan(0)
          }).pipe(Effect.provide(NodeDatabase.layer({ filename: dbPath })), Effect.provide(silentLogger))
        )
      )

      // Open migrated file read-only and verify reads succeed while writes fail
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            expect(ReadOnly.has(sql)).toBe(true)
            const rows = yield* sql<{ readonly id: number; readonly val: number }>`SELECT id, val FROM items`
            expect(rows).toEqual([{ id: 1, val: 10 }])
            const writeRes = yield* Effect.result(sql`INSERT INTO items (id, val) VALUES (2, 20)`)
            expect(Result.isFailure(writeRes)).toBe(true)
          }).pipe(Effect.provide(NodeDatabase.layer({ filename: dbPath, readOnly: true })), Effect.provide(silentLogger))
        )
      )

      // Unmigrated file with existing table is refused on re-open as unsupported_database_file
      const legacyPath = join(dir, "legacy.db")
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            yield* sql`CREATE TABLE legacy_table (id INTEGER)`
          }).pipe(Effect.provide(NodeDatabase.layer({ filename: legacyPath })), Effect.provide(silentLogger))
        )
      )
      const legacyExit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function*() {
            yield* SqlClient.SqlClient
          }).pipe(Effect.provide(NodeDatabase.layer({ filename: legacyPath })), Effect.provide(silentLogger))
        )
      )
      expect(Exit.isFailure(legacyExit)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
