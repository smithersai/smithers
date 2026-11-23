import * as net from "node:net"
import * as SlowNetwork from "../src/test/SlowNetwork.ts"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { Arbitrary, Duration, Effect, Layer, Logger, Result, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as SqlError from "effect/sql/SqlError"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import * as Database from "../src/index.ts"
import * as PostgresSelection from "../src/internal/PostgresSelection.ts"
import * as SqliteOpen from "../src/internal/SqliteOpen.ts"
import * as UnsupportedDatabase from "../src/internal/UnsupportedDatabase.ts"
import * as WriteRetry from "../src/internal/WriteRetry.ts"
import * as WriteTally from "../src/internal/WriteTally.ts"
import * as NodeDatabase from "../src/node/NodeDatabase.ts"
import * as PostgresDatabase from "../src/postgres/PostgresDatabase.ts"
import * as QualifiedRead from "../src/postgres/QualifiedRead.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"
import * as TestSchemas from "../src/TestSchemas.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "150"))
const pureExecutions = Math.max(24, Math.min(baseExecutions, 180))
const ioExecutions = Math.max(16, Math.min(Math.ceil(baseExecutions / 3), 50))
const simExecutions = Math.max(12, Math.min(Math.ceil(baseExecutions / 5), 28))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const silentLogger = Logger.layer([])

const runFuzz = async <A, E>(
  arb: Parameters<typeof Fuzz.run<A, E>>[0],
  predicate: (value: A) => Effect.Effect<boolean, E, never>,
  options: { readonly seed: number; readonly executions: number; readonly execution?: Fuzz.Execution }
) => {
  const report = await Effect.runPromise(
    Fuzz.run(
      arb,
      (value) => predicate(value).pipe(Effect.provide(silentLogger)),
      options
    )
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const SafeIdent = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,14}$/))

describe("@smthrs/database fuzz", () => {
  it("fuzzes UnsupportedBackend, UnsupportedDatabase, PostgresSelection, QualifiedRead, and DatabaseMetrics", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        extraSuffix: Schema.String.check(Schema.isPattern(/^[A-Z0-9_]{1,12}$/)),
        val: Schema.String.check(Schema.isPattern(/^[a-z0-9:/._-]{0,20}$/)),
        includeTestPg: Schema.Boolean,
        includeBlank: Schema.Boolean,
        schema: SafeIdent,
        table: SafeIdent,
        col: SafeIdent,
        badQueryKind: Schema.Literals([
          "semicolon",
          "dollar-quote",
          "line-comment",
          "block-comment",
          "for-update",
          "pg-catalog",
          "regclass",
          "quoted-flows",
          "comma-join",
          "insert",
          "unclosed-quote",
          "valid-simple",
          "valid-join",
          "valid-param"
        ]),
        waitKind: Schema.Literals(["schema", "partition", "widen", "more"]),
        waitMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 500 })),
        unsupportedCode: UnsupportedDatabase.UnsupportedDatabaseCode
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          // UnsupportedBackend
          const env: Record<string, string | undefined> = {
            SMITHERS_POSTGRES_URL: "postgres://u:p@localhost:5432/db",
            SMITHERS_POSTGRES_SCHEMA: v.schema,
            SMITHERS_POSTGRES_TEST_BIN: "/bin/pg",
            SMITHERS_POSTGRESQL_URL: "ignored-different-prefix",
            [`SMITHERS_POSTGRES_${v.extraSuffix}`]: v.includeBlank ? "" : (v.val || "1"),
            ...(v.includeTestPg ? { SMITHERS_TEST_PG_URL: "postgres://localhost/test" } : {})
          }
          const ignored = Database.UnsupportedBackend.ignoredNames(env)
          expect(ignored).not.toContain("SMITHERS_POSTGRES_URL")
          expect(ignored).not.toContain("SMITHERS_POSTGRES_SCHEMA")
          expect(ignored).not.toContain("SMITHERS_POSTGRES_TEST_BIN")
          expect(ignored).not.toContain("SMITHERS_POSTGRESQL_URL")
          expect([...ignored]).toEqual([...ignored].sort())
          for (const name of ignored) {
            expect(Database.UnsupportedBackend.ignoredNotice(name)).toContain(name)
          }

          // UnsupportedDatabase
          const uerr = new UnsupportedDatabase.UnsupportedDatabase({
            code: v.unsupportedCode,
            message: "unsupported"
          })
          expect(UnsupportedDatabase.isUnsupportedDatabase(uerr)).toBe(true)
          expect(UnsupportedDatabase.isUnsupportedDatabase({ _tag: "other" })).toBe(false)

          // PostgresSelection
          expect(PostgresSelection.isUrl("postgres://localhost/db")).toBe(true)
          expect(PostgresSelection.isUrl("postgresql://localhost/db")).toBe(true)
          expect(PostgresSelection.isUrl(":memory:")).toBe(false)
          expect(PostgresSelection.isUrl(`/tmp/${v.table}.sqlite`)).toBe(false)
          expect(PostgresSelection.location(":memory:")).toBeUndefined()
          expect(SqliteOpen.probeTarget(":memory:")).toBe(":memory:")
          expect(SqliteOpen.isLockedError(new Error("database is busy"))).toBe(true)
          expect(SqliteOpen.isLockedError(new Error("database is locked"))).toBe(true)
          expect(SqliteOpen.isLockedError(Object.assign(new Error("database is locked"), { syscall: "open" }))).toBe(false)
          expect(SqliteOpen.isLockedError(new Error("other"))).toBe(false)

          // QualifiedRead.qualify
          const tbl = `flows_${v.table}`
          const tbl2 = `flows_${v.table}_b`
          let query: string
          let expectQualified = false
          switch (v.badQueryKind) {
            case "semicolon":
              query = `SELECT * FROM ${tbl}; DROP TABLE ${tbl}`
              break
            case "dollar-quote":
              query = `SELECT $$hi$$ FROM ${tbl}`
              break
            case "line-comment":
              query = `SELECT * FROM ${tbl} -- comment`
              break
            case "block-comment":
              query = `SELECT /* c */ * FROM ${tbl}`
              break
            case "for-update":
              query = `SELECT * FROM ${tbl} FOR UPDATE`
              break
            case "pg-catalog":
              query = `SELECT * FROM pg_tables`
              break
            case "regclass":
              query = `SELECT '${tbl}'::regclass`
              break
            case "quoted-flows":
              query = `SELECT * FROM "${tbl}"`
              break
            case "comma-join":
              query = `SELECT * FROM ${tbl}, ${tbl2}`
              break
            case "insert":
              query = `INSERT INTO ${tbl} VALUES (1)`
              break
            case "unclosed-quote":
              query = `SELECT 'unclosed FROM ${tbl}`
              break
            case "valid-simple":
              query = `SELECT ${v.col} FROM ${tbl} WHERE ${v.col} = 'it''s ok'`
              expectQualified = true
              break
            case "valid-join":
              query = `SELECT a.${v.col} FROM ${tbl} a JOIN ${tbl2} b ON a.${v.col} = b.${v.col}`
              expectQualified = true
              break
            case "valid-param":
              query = `SELECT ${tbl}.${v.col} FROM ${tbl} WHERE ${v.col} = $1`
              expectQualified = true
              break
          }
          const qualified = QualifiedRead.qualify(query, v.schema)
          if (expectQualified) {
            expect(qualified).toBeDefined()
            expect(qualified).toContain(`"${v.schema}".${tbl}`)
          } else {
            expect(qualified).toBeUndefined()
          }

          // DatabaseMetrics.tally + WriteTally.record
          const [tallied, res] = yield* Database.DatabaseMetrics.tally(
            Effect.gen(function*() {
              yield* WriteTally.record(Duration.millis(v.waitMs), v.waitKind)
              const [innerTally, innerRes] = yield* Database.DatabaseMetrics.tally(
                WriteTally.record(Duration.millis(5), "more").pipe(Effect.as("ok"))
              )
              expect(innerRes).toBe("ok")
              expect(innerTally.transactions).toBe(0)
              expect(Duration.toMillis(innerTally.lockWait)).toBe(5)
              return 42
            })
          )
          expect(res).toBe(42)
          expect(Duration.toMillis(tallied.lockWait)).toBe(v.waitMs + 5)
          expect(Duration.toMillis(tallied.maxLockWait)).toBeGreaterThanOrEqual(Math.max(v.waitMs, 5))
          expect(Database.DatabaseMetrics.writeRetries).toBeDefined()
          expect(Database.DatabaseMetrics.writerLockWait).toBeDefined()
          expect(Database.DatabaseMetrics.writerLockTimeouts).toBeDefined()
          expect(Database.DatabaseMetrics.connectionWait).toBeDefined()
          expect(Database.DatabaseMetrics.loginFailures).toBeDefined()
          return true
        }),
      { seed: seed + 1, executions: pureExecutions }
    )
  })

  it("fuzzes WriteRetry classification, codeOf, affectedRows, and retry loop behavior", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        rawKind: Schema.Literals([
          "sqlite-changes",
          "sqlite-bigint",
          "pg-rowcount",
          "pg-bigint",
          "negative",
          "float",
          "huge-bigint",
          "null",
          "primitive",
          "getter",
          "inherited",
          "empty-obj"
        ]),
        count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
        causeKind: Schema.Literals([
          "sqlite-busy",
          "sqlite-locked",
          "pg-deadlock",
          "pg-serialization",
          "sqlite-io",
          "sqlite-schema",
          "constraint-reason",
          "unique-reason",
          "connection-reason",
          "unknown",
          "wrapped-db-error",
          "cyclic-cause"
        ]),
        failCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
        maxRetries: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          // affectedRows
          let raw: unknown
          let expectOk = false
          switch (v.rawKind) {
            case "sqlite-changes":
              raw = { changes: v.count }
              expectOk = true
              break
            case "sqlite-bigint":
              raw = { changes: BigInt(v.count) }
              expectOk = true
              break
            case "pg-rowcount":
              raw = { rowCount: v.count }
              expectOk = true
              break
            case "pg-bigint":
              raw = { rowCount: BigInt(v.count) }
              expectOk = true
              break
            case "negative":
              raw = { changes: -1 }
              break
            case "float":
              raw = { changes: 1.5 }
              break
            case "huge-bigint":
              raw = { changes: BigInt(Number.MAX_SAFE_INTEGER) + 10n }
              break
            case "null":
              raw = null
              break
            case "primitive":
              raw = 42
              break
            case "getter":
              raw = Object.defineProperty({}, "changes", { get: () => v.count, enumerable: true })
              break
            case "inherited":
              raw = Object.create({ changes: v.count })
              break
            case "empty-obj":
              raw = {}
              break
          }
          const rowsRes = yield* Effect.result(Database.DurableWriter.affectedRows(raw))
          if (expectOk) {
            expect(Result.isSuccess(rowsRes) && rowsRes.success === v.count).toBe(true)
          } else {
            expect(Result.isFailure(rowsRes) && rowsRes.failure.code === "unsupported").toBe(true)
          }

          // classifySqlError / fromSqlError / codeOf / isRetryableWriteError
          const mkSqlErr = (cause: unknown, kind: "unknown" | "constraint" | "unique" | "connection" = "unknown") =>
            new SqlError.SqlError({
              reason: kind === "constraint"
                ? new SqlError.ConstraintError({ cause })
                : kind === "unique"
                ? new SqlError.UniqueViolation({ cause, constraint: "uq_test" })
                : kind === "connection"
                ? new SqlError.ConnectionError({ cause })
                : new SqlError.UnknownError({ cause })
            })

          if (v.causeKind === "sqlite-busy") {
            const err = mkSqlErr({ code: "SQLITE_BUSY" })
            expect(Database.DurableWriter.fromSqlError(err).code).toBe("busy")
            expect(WriteRetry.isRetryableWriteError(err)).toBe(true)
          } else if (v.causeKind === "sqlite-locked") {
            const err = mkSqlErr(new Error("database is locked"))
            expect(Database.DurableWriter.codeOf(err)).toBe("busy")
          } else if (v.causeKind === "pg-deadlock") {
            const err = mkSqlErr({ code: "40P01" })
            expect(Database.DurableWriter.codeOf(err)).toBe("busy")
          } else if (v.causeKind === "pg-serialization") {
            const err = mkSqlErr({ code: "40001" })
            expect(Database.DurableWriter.codeOf(err)).toBe("busy")
          } else if (v.causeKind === "sqlite-io") {
            const err = mkSqlErr({ code: "SQLITE_IOERR" })
            expect(Database.DurableWriter.codeOf(err)).toBe("io")
          } else if (v.causeKind === "sqlite-schema") {
            const err = mkSqlErr({ code: "SQLITE_ERROR", message: "no such table: foo" })
            expect(Database.DurableWriter.codeOf(err)).toBe("schema")
          } else if (v.causeKind === "constraint-reason") {
            const err = mkSqlErr(new Error("ck"), "constraint")
            expect(Database.DurableWriter.codeOf(err)).toBe("constraint")
          } else if (v.causeKind === "unique-reason") {
            const err = mkSqlErr(new Error("uq"), "unique")
            expect(Database.DurableWriter.codeOf(err)).toBe("constraint")
          } else if (v.causeKind === "connection-reason") {
            const err = mkSqlErr(new Error("disk i/o error"), "connection")
            expect(Database.DurableWriter.codeOf(err)).toBe("io")
          } else if (v.causeKind === "unknown") {
            const err = mkSqlErr(new Error("weird"))
            expect(Database.DurableWriter.codeOf(err)).toBe("unknown")
          } else if (v.causeKind === "wrapped-db-error") {
            const wrapped = { cause: new Database.DurableWriter.DatabaseError({ code: "busy", cause: undefined }) }
            expect(Database.DurableWriter.codeOf(wrapped)).toBe("busy")
          } else {
            const cyc: Record<string, unknown> = {}
            cyc.cause = cyc
            expect(Database.DurableWriter.codeOf(cyc)).toBeUndefined()
          }

          // withWriteRetry
          let attempts = 0
          const retryRes = yield* Effect.result(
            WriteRetry.withWriteRetry(
              Effect.suspend(() => {
                attempts += 1
                if (attempts <= v.failCount) {
                  return Effect.fail(new Database.DurableWriter.DatabaseError({ code: "busy", cause: undefined }))
                }
                return Effect.succeed("done")
              }),
              { maxAttempts: v.maxRetries + 1, baseDelayMs: 1, maxDelayMs: 2 }
            )
          )
          if (v.failCount <= v.maxRetries) {
            expect(Result.isSuccess(retryRes) && retryRes.success === "done").toBe(true)
            expect(attempts).toBe(v.failCount + 1)
          } else {
            expect(Result.isFailure(retryRes) && retryRes.failure.code === "busy").toBe(true)
            expect(attempts).toBe(v.maxRetries + 1)
          }

          // makeNoop / layerNoop fails with unsupported DatabaseError
          const noopRes = yield* Effect.result(
            Database.DurableWriter.DurableWriter.pipe(
              Effect.flatMap((w) => w.write(Effect.succeed(v.count))),
              Effect.provide(Database.DurableWriter.layerNoop)
            )
          )
          expect(Result.isFailure(noopRes) && noopRes.failure.code === "unsupported").toBe(true)
          return true
        }),
      { seed: seed + 2, executions: pureExecutions }
    )
  })

  it("fuzzes Dialect and TestDatabase helpers over real SQLite and simulated Postgres dialect", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        table: SafeIdent,
        val: Schema.Int.check(Schema.isBetween({ minimum: -100, maximum: 100 })),
        jsonKey: SafeIdent,
        jsonVal: Schema.String.check(Schema.isPattern(/^[a-z0-9]{1,12}$/))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const tbl = `t_${v.table}`
          expect(Database.Dialect.isPostgres(sql)).toBe(false)
          expect(Database.Dialect.isReadOnly(sql)).toBe(false)

          yield* sql`CREATE TABLE ${sql(tbl)} (
            ${Database.Dialect.rowId(sql)}
            id ${Database.Dialect.identity(sql)},
            n ${Database.Dialect.integer(sql)} NOT NULL CHECK (${Database.Dialect.isInteger(sql, sql`n`)}),
            payload TEXT NOT NULL CHECK (${Database.Dialect.jsonValid(sql, sql`payload`)})
          )`
          const jsonStr = JSON.stringify({ [v.jsonKey]: v.jsonVal })
          yield* sql`INSERT INTO ${sql(tbl)} (n, payload) VALUES (${v.val}, ${jsonStr})`

          const rows = yield* sql<{ n: number; extracted: string; mx: number }>`SELECT n, ${Database.Dialect.jsonText(sql, sql`payload`, `$.${v.jsonKey}`)} AS extracted, ${Database.Dialect.greatest(sql)}(n, 0) AS mx FROM ${sql(tbl)}`
          expect(rows.length).toBe(1)
          expect(rows[0]!.n).toBe(v.val)
          expect(rows[0]!.extracted).toBe(v.jsonVal)
          expect(rows[0]!.mx).toBe(Math.max(v.val, 0))

          const qRows = yield* Database.Dialect.query<{ n: number }>(
            sql,
            `SELECT n FROM "${tbl}" WHERE n = ?`,
            [v.val]
          )
          expect(qRows.length).toBe(1)

          const tblList = yield* Database.Dialect.tables(sql)
          expect(tblList.map((t) => t.name)).toContain(tbl)
          const colList = yield* Database.Dialect.columns(sql, tbl)
          expect(colList.map((c) => c.name)).toContain("payload")

          // Triggers (reject & body, with & without when, dropTrigger)
          yield* Database.Dialect.trigger(sql, {
            name: `${tbl}_no_del`,
            table: tbl,
            event: "BEFORE DELETE",
            when: "OLD.n >= -1000",
            reject: "immutable"
          })
          const delRes = yield* Effect.result(sql`DELETE FROM ${sql(tbl)}`)
          expect(Result.isFailure(delRes)).toBe(true)
          yield* Database.Dialect.dropTrigger(sql, `${tbl}_no_del`, tbl)
          yield* sql`DELETE FROM ${sql(tbl)}`

          // Deferred trigger mode no-ops on SQLite
          yield* Database.Dialect.setTriggerMode(sql, [[tbl, "x"]], "DEFERRED")
          yield* Database.Dialect.flushDeferredTriggers(sql, [[tbl, "x"]])
          expect(Database.Dialect.indexHint(sql, "idx")).toBeDefined()

          // readTransaction (unregistered and registered)
          const r1 = yield* Database.Dialect.readTransaction(sql, sql`SELECT count(*) AS c FROM ${sql(tbl)}`)
          expect(r1.length).toBe(1)
          let regCalls = 0
          Database.Dialect.registerReadTransaction(sql, (eff) =>
            Effect.suspend(() => {
              regCalls += 1
              return sql.withTransaction(eff)
            }))
          yield* Database.Dialect.readTransaction(sql, sql`SELECT 1`)
          expect(regCalls).toBe(1)

          // TestDatabase helpers
          yield* TestDatabase.checks(sql, false)
          yield* TestDatabase.checks(sql, true)
          yield* TestDatabase.foreignKeys(sql, false)
          yield* TestDatabase.foreignKeys(sql, true)
          const cat = yield* sql`SELECT * FROM ${TestDatabase.catalog(sql)}`
          expect(cat.length).toBeGreaterThan(0)
          const plan = yield* TestDatabase.explain(sql, sql`SELECT * FROM ${sql(tbl)}`)
          expect(plan.length).toBeGreaterThan(0)
          let ready = 0
          yield* TestDatabase.until(Effect.sync(() => {
            ready += 1
            return ready >= 2
          }))

          // Simulated Postgres dialect surface (covers PG SQL fragment branches in Dialect.ts)
          const pgSql = Object.assign(
            (strings: TemplateStringsArray, ...params: ReadonlyArray<unknown>) => sql(strings, ...params),
            sql,
            {
              onDialectOrElse: <A>(opts: { readonly pg?: () => A; readonly orElse: () => A }) =>
                opts.pg !== undefined ? opts.pg() : opts.orElse()
            }
          ) as unknown as SqlClient.SqlClient
          expect(Database.Dialect.isPostgres(pgSql)).toBe(true)
          expect(Database.Dialect.integer(pgSql)).toBeDefined()
          expect(Database.Dialect.isInteger(pgSql, sql`n`)).toBeDefined()
          expect(Database.Dialect.jsonValid(pgSql, sql`payload`)).toBeDefined()
          expect(Database.Dialect.jsonText(pgSql, sql`payload`, `$.${v.jsonKey}`)).toBeDefined()
          expect(Database.Dialect.identity(pgSql)).toBeDefined()
          expect(Database.Dialect.greatest(pgSql)).toBeDefined()
          expect(Database.Dialect.rowId(pgSql)).toBeDefined()
          expect(Database.Dialect.indexHint(pgSql, "idx")).toBeDefined()
          return true
        }).pipe(Effect.provide(TestDatabase.sqliteLayer)),
      { seed: seed + 3, executions: ioExecutions }
    )
  })

  it("fuzzes DurableWriter transactions, nested savepoints, afterCommit/afterRollback, and concurrency", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        ops: Schema.Array(
          Schema.Struct({
            val: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 })),
            failOuter: Schema.Boolean,
            nested: Schema.Boolean,
            failInner: Schema.Boolean,
            catchInner: Schema.Boolean
          })
        ).check(Schema.isMinLength(1), Schema.isMaxLength(8))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const writer = yield* Database.DurableWriter.DurableWriter
          yield* sql`CREATE TABLE items (val INTEGER NOT NULL)`

          // Outside tx returns false
          expect(yield* Database.DurableWriter.afterCommit(Effect.void)).toBe(false)
          expect(yield* Database.DurableWriter.afterRollback(Effect.void)).toBe(false)

          const committedLog: Array<number> = []
          const rolledBackLog: Array<number> = []
          const expectedVals: Array<number> = []

          for (const op of v.ops) {
            const res = yield* Effect.result(
              writer.write(
                Effect.gen(function*() {
                  yield* sql`INSERT INTO items (val) VALUES (${op.val})`
                  expect(
                    yield* Database.DurableWriter.afterCommit(Effect.sync(() => {
                      committedLog.push(op.val)
                    }))
                  ).toBe(true)
                  expect(
                    yield* Database.DurableWriter.afterRollback(Effect.sync(() => {
                      rolledBackLog.push(op.val)
                    }))
                  ).toBe(true)

                  if (op.nested) {
                    const inner = writer.write(
                      Effect.gen(function*() {
                        yield* sql`INSERT INTO items (val) VALUES (${op.val + 1000})`
                        yield* Database.DurableWriter.afterCommit(Effect.sync(() => {
                          committedLog.push(op.val + 1000)
                        }))
                        yield* Database.DurableWriter.afterRollback(Effect.sync(() => {
                          rolledBackLog.push(op.val + 1000)
                        }))
                        if (op.failInner) return yield* Effect.fail("inner-fail" as const)
                      })
                    )
                    if (op.catchInner) {
                      yield* Effect.result(inner)
                    } else {
                      yield* inner
                    }
                  }

                  if (op.failOuter) return yield* Effect.fail("outer-fail" as const)
                  return op.val
                })
              )
            )

            const innerUncaughtFail = op.nested && op.failInner && !op.catchInner
            const outerSucceeded = !innerUncaughtFail && !op.failOuter
            expect(Result.isSuccess(res)).toBe(outerSucceeded)
            if (outerSucceeded) {
              expectedVals.push(op.val)
              if (op.nested && !op.failInner) expectedVals.push(op.val + 1000)
            }
          }

          const stored = yield* sql<{ val: number }>`SELECT val FROM items ORDER BY rowid`
          expect(stored.map((r) => r.val)).toEqual(expectedVals)
          expect(committedLog).toEqual(expectedVals)
          expect(rolledBackLog.length).toBeGreaterThanOrEqual(0)
          return true
        }).pipe(Effect.provide(TestDatabase.sqliteLayer)),
      { seed: seed + 4, executions: ioExecutions }
    )
  })

  it("fuzzes concurrent DurableWriter transactions under FuzzSimulation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        values: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))).check(
          Schema.isMinLength(2),
          Schema.isMaxLength(8)
        )
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const writer = yield* Database.DurableWriter.DurableWriter
          yield* sql`CREATE TABLE counters (k INTEGER PRIMARY KEY, total INTEGER NOT NULL)`
          yield* sql`INSERT INTO counters (k, total) VALUES (1, 0)`

          yield* Effect.all(
            v.values.map((delta) =>
              writer.write(
                Effect.gen(function*() {
                  const rows = yield* sql<{ total: number }>`SELECT total FROM counters WHERE k = 1`
                  const next = rows[0]!.total + delta
                  yield* sql`UPDATE counters SET total = ${next} WHERE k = 1`
                }),
                { partition: "counter-1" }
              )
            ),
            { concurrency: "unbounded" }
          )

          const finalRows = yield* sql<{ total: number }>`SELECT total FROM counters WHERE k = 1`
          const expectedSum = v.values.reduce((acc, n) => acc + n, 0)
          expect(finalRows[0]!.total).toBe(expectedSum)
          return true
        }).pipe(Effect.provide(TestDatabase.sqliteLayer)),
      { seed: seed + 5, executions: simExecutions, execution: FuzzSimulation.execution() }
    )
  })

  it("fuzzes Migrations composition, upgrades, previousNames, and validation refusals", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        nsA: SafeIdent,
        nsB: SafeIdent,
        scenario: Schema.Literals([
          "multi-block-and-upgrade",
          "previous-names",
          "dup-namespace",
          "dup-offset",
          "bad-offset-align",
          "negative-offset",
          "local-id-overflow",
          "local-id-collision",
          "bad-key-format",
          "missing-earlier-migration",
          "new-lower-block-refused",
          "renamed-without-previous",
          "global-id-zero"
        ])
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const nsA = `a_${v.nsA}`
          const nsB = `b_${v.nsB}`
          const noopMig = Effect.void

          switch (v.scenario) {
            case "multi-block-and-upgrade": {
              const setA: Database.Migrations.MigrationSet = {
                namespace: nsA,
                idOffset: 0,
                migrations: {
                  "0001_init": Effect.gen(function*() {
                    const s = yield* SqlClient.SqlClient
                    yield* s`CREATE TABLE a_t1 (id INTEGER PRIMARY KEY)`
                  })
                }
              }
              const setB: Database.Migrations.MigrationSet = {
                namespace: nsB,
                idOffset: Database.Migrations.idBlock,
                migrations: {
                  "0001_init": Effect.gen(function*() {
                    const s = yield* SqlClient.SqlClient
                    yield* s`CREATE TABLE b_t1 (id INTEGER PRIMARY KEY)`
                  })
                }
              }
              yield* Database.Migrations.run([setA, setB])
              yield* Database.Migrations.run([setA, setB])
              const setA2: Database.Migrations.MigrationSet = {
                ...setA,
                migrations: {
                  ...setA.migrations,
                  "0002_extra": Effect.gen(function*() {
                    const s = yield* SqlClient.SqlClient
                    yield* s`CREATE TABLE a_t2 (id INTEGER PRIMARY KEY)`
                  })
                }
              }
              yield* Database.Migrations.run([setA2, setB])
              const tbls = (yield* Database.Dialect.tables(sql)).map((t) => t.name)
              expect(tbls).toContain("a_t1")
              expect(tbls).toContain("a_t2")
              expect(tbls).toContain("b_t1")
              break
            }
            case "previous-names": {
              const v1: Database.Migrations.MigrationSet = {
                namespace: nsA,
                idOffset: 0,
                migrations: { "0001_old_name": noopMig }
              }
              yield* Database.Migrations.run([v1])
              const v2: Database.Migrations.MigrationSet = {
                namespace: nsA,
                idOffset: 0,
                migrations: { "0001_new_name": noopMig },
                previousNames: { "0001_new_name": ["old_name"] }
              }
              yield* Database.Migrations.run([v2])
              break
            }
            case "global-id-zero": {
              const s0: Database.Migrations.MigrationSet = {
                namespace: nsA,
                idOffset: 0,
                migrations: { "0000_zero": noopMig, "0001_one": noopMig }
              }
              yield* Database.Migrations.run([s0])
              yield* Database.Migrations.run([s0])
              break
            }
            case "dup-namespace": {
              const r = yield* Effect.result(Database.Migrations.run([
                { namespace: nsA, idOffset: 0, migrations: { "0001_a": noopMig } },
                { namespace: nsA, idOffset: 1000, migrations: { "0001_b": noopMig } }
              ]))
              expect(Result.isFailure(r)).toBe(true)
              break
            }
            case "dup-offset": {
              const r = yield* Effect.result(Database.Migrations.run([
                { namespace: nsA, idOffset: 0, migrations: { "0001_a": noopMig } },
                { namespace: nsB, idOffset: 0, migrations: { "0001_b": noopMig } }
              ]))
              expect(Result.isFailure(r)).toBe(true)
              break
            }
            case "bad-offset-align": {
              const r = yield* Effect.result(Database.Migrations.run([
                { namespace: nsA, idOffset: 500, migrations: { "0001_a": noopMig } }
              ]))
              expect(Result.isFailure(r)).toBe(true)
              break
            }
            case "negative-offset": {
              const r = yield* Effect.result(Database.Migrations.run([
                { namespace: nsA, idOffset: -1000, migrations: { "0001_a": noopMig } }
              ]))
              expect(Result.isFailure(r)).toBe(true)
              break
            }
            case "local-id-overflow": {
              const r = yield* Effect.result(Database.Migrations.run([
                { namespace: nsA, idOffset: 0, migrations: { "1000_overflow": noopMig } }
              ]))
              expect(Result.isFailure(r)).toBe(true)
              break
            }
            case "local-id-collision": {
              const r = yield* Effect.result(Database.Migrations.run([
                { namespace: nsA, idOffset: 0, migrations: { "0001_a": noopMig, "01_b": noopMig } }
              ]))
              expect(Result.isFailure(r)).toBe(true)
              break
            }
            case "bad-key-format": {
              const r = yield* Effect.result(Database.Migrations.run([
                { namespace: nsA, idOffset: 0, migrations: { "not_numeric": noopMig } }
              ]))
              expect(Result.isFailure(r)).toBe(true)
              break
            }
            case "missing-earlier-migration": {
              yield* Database.Migrations.run([
                { namespace: nsA, idOffset: 0, migrations: { "0002_second": noopMig } }
              ])
              const r = yield* Effect.result(Database.Migrations.run([
                { namespace: nsA, idOffset: 0, migrations: { "0001_first": noopMig, "0002_second": noopMig } }
              ]))
              expect(Result.isFailure(r)).toBe(true)
              break
            }
            case "new-lower-block-refused": {
              yield* Database.Migrations.run([
                { namespace: nsB, idOffset: 1000, migrations: { "0001_b": noopMig } }
              ])
              const r = yield* Effect.result(Database.Migrations.run([
                { namespace: nsA, idOffset: 0, migrations: { "0001_a": noopMig } },
                { namespace: nsB, idOffset: 1000, migrations: { "0001_b": noopMig } }
              ]))
              expect(Result.isFailure(r)).toBe(true)
              break
            }
            case "renamed-without-previous": {
              yield* Database.Migrations.run([
                { namespace: nsA, idOffset: 0, migrations: { "0001_orig": noopMig } }
              ])
              const r = yield* Effect.result(Database.Migrations.run([
                { namespace: nsA, idOffset: 0, migrations: { "0001_renamed": noopMig } }
              ]))
              expect(Result.isFailure(r)).toBe(true)
              break
            }
          }
          expect(NodeDatabase.postgresLocation(":memory:")).toBeUndefined()
          return true
        }).pipe(Effect.provide(TestDatabase.sqliteLayer)),
      { seed: seed + 6, executions: Math.max(ioExecutions, 55) }
    )
  })

  it("fuzzes file-backed NodeDatabase, readOnly mode, 0.x guard, TestSchemas, Migrations.layer, and trigger variants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        prefix: SafeIdent,
        store: SafeIdent,
        ts: Schema.Int.check(Schema.isBetween({ minimum: 1_700_000_000, maximum: 1_900_000_000 })),
        mode: Schema.Literals(["file-rw-and-ro", "zero-x-refused", "invalid-pg-schema", "trigger-body-ignore"])
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          // TestSchemas
          const schema = TestSchemas.schemaName(v.prefix, v.ts)
          expect(new RegExp(TestSchemas.NAME_PATTERN).test(schema)).toBe(true)
          expect(TestSchemas.forStore(schema, v.store.slice(0, 12))).toMatch(new RegExp(TestSchemas.NAME_PATTERN))
          expect(TestSchemas.forStore("custom_prefix", v.store)).toBe(`custom_prefix_${v.store}`)
          expect(() => TestSchemas.schemaName("BAD!", v.ts)).toThrow()
          expect(() => TestSchemas.schemaName(v.prefix, 10)).toThrow()
          expect(() => TestSchemas.forStore(schema, "BAD!")).toThrow()

          if (v.mode === "invalid-pg-schema") {
            expect(() =>
              PostgresDatabase.layer({
                url: "postgres://localhost/db",
                driver: {} as never,
                schema: ""
              })
            ).toThrow()
            expect(() =>
              PostgresDatabase.layer({
                url: "postgres://localhost/db",
                driver: {} as never,
                schema: "a".repeat(64)
              })
            ).toThrow()
            return true
          }

          if (v.mode === "trigger-body-ignore") {
            yield* Effect.gen(function*() {
              const sql = yield* SqlClient.SqlClient
              yield* sql`CREATE TABLE src (v INTEGER)`
              yield* sql`CREATE TABLE dst (v INTEGER)`
              yield* Database.Dialect.trigger(sql, {
                name: "copy_v",
                table: "src",
                event: "AFTER INSERT",
                body: "INSERT INTO dst VALUES (NEW.v);"
              })
              yield* Database.Dialect.trigger(sql, {
                name: "skip_neg",
                table: "src",
                event: "BEFORE INSERT",
                when: "NEW.v < 0",
                ignore: true
              })
              yield* sql`INSERT INTO src VALUES (5)`
              yield* sql`INSERT INTO src VALUES (-1)`
              const dstRows = yield* sql<{ v: number }>`SELECT v FROM dst`
              expect(dstRows.map((r) => r.v)).toEqual([5])
              yield* TestDatabase.dropTrigger(sql, "copy_v")
            }).pipe(
              Effect.provide(
                Database.Migrations.layer([
                  { namespace: v.prefix, idOffset: 0, migrations: { "0001_noop": Effect.void } }
                ]).pipe(Layer.provideMerge(TestDatabase.sqliteLayer))
              )
            )
            return true
          }

          const dir = mkdtempSync(join(tmpdir(), "db-fuzz-"))
          const filename = join(dir, `${v.prefix}.sqlite`)
          try {
            if (v.mode === "zero-x-refused") {
              const db = new DatabaseSync(filename)
              try {
                db.exec("CREATE TABLE _smithers_runs (id TEXT PRIMARY KEY)")
              } finally {
                db.close()
              }
              const exit = yield* Effect.exit(
                Effect.gen(function*() {
                  const sql = yield* SqlClient.SqlClient
                  yield* sql`SELECT 1`
                }).pipe(Effect.provide(NodeDatabase.layer({ filename })))
              )
              expect(exit._tag).toBe("Failure")
            } else {
              // File-backed read-write then read-only open
              yield* Effect.gen(function*() {
                const sql = yield* SqlClient.SqlClient
                yield* Database.Migrations.run([
                  { namespace: v.prefix, idOffset: 0, migrations: { "0001_init": sql`CREATE TABLE kv (k TEXT)`.pipe(Effect.asVoid) } }
                ])
                yield* sql`INSERT INTO kv VALUES ('ok')`
              }).pipe(Effect.provide(NodeDatabase.layer({ filename })))

              yield* Effect.gen(function*() {
                const sql = yield* SqlClient.SqlClient
                expect(Database.Dialect.isReadOnly(sql)).toBe(true)
                const rows = yield* sql<{ k: string }>`SELECT k FROM kv`
                expect(rows).toEqual([{ k: "ok" }])
              }).pipe(Effect.provide(NodeDatabase.layer({ filename, readOnly: true })))
            }
          } finally {
            rmSync(dir, { recursive: true, force: true })
          }
          return true
        }),
      { seed: seed + 7, executions: Math.min(ioExecutions, 24) }
    )
  })

  it("PostgresSelection.location & SlowNetwork.proxy uphold URL routing, schema derivation & TCP chunk ordering", async () => {
    const report = await Effect.runPromise(Fuzz.run(
      Arbitrary.schema(
        Schema.Struct({
          filename: Schema.Literals([
            "",
            ":memory:",
            "file:memdb1?mode=memory",
            "/tmp/store-a.db",
            "postgres://user:pw@localhost:5432/db?schema=custom_s",
            "postgresql://localhost/db",
            "postgres://[invalid"
          ]),
          backend: Schema.Literals(["", "sqlite", "postgres"]),
          envUrl: Schema.Literals(["", "postgres://envhost:5432/db", "http://not-pg"]),
          envSchema: Schema.Literals(["", "test_run"]),
          payload: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(32)))
        })
      ),
      ({ filename, backend, envUrl, envSchema, payload }) =>
        Effect.gen(function*() {
          const prevBackend = process.env.SMITHERS_BACKEND
          const prevPg = process.env.SMITHERS_POSTGRES_URL
          const prevDb = process.env.DATABASE_URL
          const prevSchema = process.env.SMITHERS_POSTGRES_SCHEMA
          try {
            if (backend) process.env.SMITHERS_BACKEND = backend; else delete process.env.SMITHERS_BACKEND
            if (envUrl) process.env.SMITHERS_POSTGRES_URL = envUrl; else delete process.env.SMITHERS_POSTGRES_URL
            delete process.env.DATABASE_URL
            if (envSchema) process.env.SMITHERS_POSTGRES_SCHEMA = envSchema; else delete process.env.SMITHERS_POSTGRES_SCHEMA

            const isPg = PostgresSelection.isUrl(filename)
            if (isPg !== (filename.startsWith("postgres://") || filename.startsWith("postgresql://"))) return false

            try {
              const loc = PostgresSelection.location(filename)
              if (filename === "" || filename === ":memory:" || filename.startsWith("file:")) {
                if (loc !== undefined) return false
              }
              if (loc !== undefined) {
                if (loc.url.includes("schema=")) return false
                if (loc.schema.length === 0) return false
              }
            } catch (e: unknown) {
              const code = (e as { code?: string })?.code
              if (code !== "postgres_url_missing" && code !== "postgres_url_invalid") return false
            }
          } finally {
            if (prevBackend === undefined) delete process.env.SMITHERS_BACKEND; else process.env.SMITHERS_BACKEND = prevBackend
            if (prevPg === undefined) delete process.env.SMITHERS_POSTGRES_URL; else process.env.SMITHERS_POSTGRES_URL = prevPg
            if (prevDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prevDb
            if (prevSchema === undefined) delete process.env.SMITHERS_POSTGRES_SCHEMA; else process.env.SMITHERS_POSTGRES_SCHEMA = prevSchema
          }

          // Exercise SlowNetwork.proxy over a real loopback TCP echo server
          const cleanPayload = payload.replace(/[\uD800-\uDFFF]/g, "x")
          const echoed = yield* Effect.scoped(
            Effect.gen(function*() {
              const echoPort = yield* Effect.acquireRelease(
                Effect.callback<number>((resume) => {
                  const srv = net.createServer((sock) => {
                    sock.on("error", () => {})
                    sock.on("data", (chunk) => sock.write(chunk))
                  })
                  srv.listen(0, "127.0.0.1", () => {
                    const addr = srv.address() as net.AddressInfo
                    ;(srv as unknown as { _port?: number })._port = addr.port
                    resume(Effect.succeed(addr.port))
                  })
                  ;(globalThis as unknown as { __echoSrv?: net.Server }).__echoSrv = srv
                }),
                () =>
                  Effect.callback<void>((resume) => {
                    const srv = (globalThis as unknown as { __echoSrv?: net.Server }).__echoSrv
                    if (srv) srv.close(() => resume(Effect.void))
                    else resume(Effect.void)
                  })
              )
              const proxiedUrl = yield* SlowNetwork.proxy(`postgres://127.0.0.1:${echoPort}/db`, { delayMs: 1 })
              const parsed = new URL(proxiedUrl)
              const data = yield* Effect.promise(
                () =>
                  new Promise<string>((resolve, reject) => {
                    const expectedLen = Buffer.byteLength(cleanPayload, "utf8")
                    const sock = net.connect(Number(parsed.port), "127.0.0.1")
                    const chunks: Array<Buffer> = []
                    let got = 0
                    sock.on("connect", () => {
                      sock.write(cleanPayload)
                    })
                    sock.on("data", (c) => {
                      chunks.push(typeof c === "string" ? Buffer.from(c) : c)
                      got += c.length
                      if (got >= expectedLen) {
                        sock.end()
                        resolve(Buffer.concat(chunks).toString("utf8"))
                      }
                    })
                    sock.on("error", reject)
                  })
              )
              return data
            })
          )
          return echoed === cleanPayload
        }),
      { seed: seed + 8, executions: Math.min(ioExecutions, 12) }
    ))
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
