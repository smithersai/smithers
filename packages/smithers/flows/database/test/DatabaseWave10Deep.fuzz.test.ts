import * as Pg from "@effect/sql-pg"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Deferred, Duration, Effect, Exit, Fiber, Logger, Schema, Stream } from "effect"
import * as Reactivity from "effect/reactivity/Reactivity"
import * as SqlClient from "effect/sql/SqlClient"
import type { Connection } from "effect/sql/SqlConnection"
import { LockTimeoutError, SqlError, UnknownError } from "effect/sql/SqlError"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import * as Net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import * as Dialect from "../src/Dialect.ts"
import * as DurableWriter from "../src/DurableWriter.ts"
import * as SlowNetworkTarget from "../src/internal/SlowNetworkTarget.ts"
import * as SqliteOpen from "../src/internal/SqliteOpen.ts"
import * as WriteLock from "../src/internal/WriteLock.ts"
import * as WriteRetry from "../src/internal/WriteRetry.ts"
import * as Migrations from "../src/Migrations.ts"
import * as NodeDatabase from "../src/node/NodeDatabase.ts"
import * as PostgresDatabase from "../src/postgres/PostgresDatabase.ts"
import * as QualifiedRead from "../src/postgres/QualifiedRead.ts"
import * as SlowNetwork from "../src/test/SlowNetwork.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"

const PG_URL = process.env.SMITHERS_TEST_PG_URL
const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")
const silentLogger = Logger.layer([])

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const tempSchema = (prefix: string) => `w10_${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`

const withPgSchema = async <A>(
  prefix: string,
  fn: (schema: string, sql: SqlClient.SqlClient) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
  options?: { readonly readOnly?: boolean }
): Promise<A> => {
  const schema = tempSchema(prefix)
  const layer = PostgresDatabase.layer({
    url: PG_URL!,
    driver: Pg,
    schema,
    ...(options?.readOnly !== undefined ? { readOnly: options.readOnly } : {})
  })
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        return yield* Effect.ensuring(
          fn(schema, sql),
          TestDatabase.dropSchema(sql, schema).pipe(Effect.ignore)
        )
      }).pipe(Effect.provide(layer), Effect.provide(silentLogger))
    )
  )
}

const makeFakePgDriver = (opts: {
  lockFailure?: "none" | "timeout" | "unknown"
  lockTimeoutTimes?: number
  failSelect?: boolean
  failRegclass?: boolean
  returnBigintMigration?: boolean
}) => {
  let remainingTimeouts = opts.lockTimeoutTimes ?? 0
  const makeConn = (): Connection => {
    const run = (sql: string): Effect.Effect<ReadonlyArray<any>, SqlError> =>
      Effect.suspend((): Effect.Effect<ReadonlyArray<any>, SqlError> => {
        if (sql.includes("pg_advisory_xact_lock")) {
          if (opts.lockFailure === "unknown") {
            return Effect.fail(
              new SqlError({
                reason: new UnknownError({
                  cause: new Error("fatal lock error"),
                  message: "fatal lock error",
                  operation: "execute"
                })
              })
            )
          }
          if (opts.lockFailure === "timeout" || remainingTimeouts > 0) {
            if (remainingTimeouts > 0) remainingTimeouts -= 1
            return Effect.fail(
              new SqlError({
                reason: new LockTimeoutError({
                  cause: Object.assign(new Error("lock timeout"), { code: "55P03" }),
                  message: "lock timeout",
                  operation: "execute"
                })
              })
            )
          }
        }
        if (opts.failRegclass && sql.includes("to_regclass")) {
          return Effect.fail(
            new SqlError({
              reason: new UnknownError({
                cause: new Error("regclass failed"),
                message: "regclass failed",
                operation: "execute"
              })
            })
          )
        }
        if (opts.failSelect && sql.includes("flows_migrations")) {
          return Effect.fail(
            new SqlError({
              reason: new UnknownError({
                cause: new Error("ledger unreadable"),
                message: "ledger unreadable",
                operation: "execute"
              })
            })
          )
        }
        if (opts.returnBigintMigration && sql.includes("SELECT migration_id, name")) {
          return Effect.succeed([{ migration_id: 1n, name: "ns_init" }])
        }
        if (sql.includes("to_regclass")) {
          return Effect.succeed([{ found: true }])
        }
        if (sql.includes("pg_namespace")) {
          return Effect.succeed([{ exists: true }])
        }
        return Effect.succeed([{ ok: 1 }])
      })
    return {
      execute: (sql) => run(sql),
      executeRaw: (sql) => run(sql),
      executeValues: (sql) => run(sql).pipe(Effect.map(() => [[1]])),
      executeValuesUnprepared: (sql) => run(sql).pipe(Effect.map(() => [[1]])),
      executeUnprepared: (sql) => run(sql),
      executeStream: (sql) => Stream.unwrap(run(sql).pipe(Effect.map((rows) => Stream.fromIterable(rows))))
    }
  }
  const driver: PostgresDatabase.Driver = {
    PgTypes: Pg.PgTypes,
    PgClient: {
      ...Pg.PgClient,
      make: () =>
        Effect.gen(function*() {
          const conn = makeConn()
          const client = yield* SqlClient.make({
            acquirer: Effect.succeed(conn),
            compiler: Pg.PgClient.makeCompiler(),
            spanAttributes: [],
            transformRows: undefined,
            driver: "pg"
          })
          return Object.assign(client, {
            config: {} as any,
            listen: () => Stream.empty,
            notify: () => Effect.void,
            registerTypes: () => Effect.void
          }) as any
        })
    }
  }
  return driver
}

describe("Database Wave10 Deep Fuzzing", () => {
  it(
    "fuzzes QualifiedRead edge cases: escape strings, doubled quotes, commas, parens, subqueries, stray tables",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          schema: Schema.Literals(["s1", "smithers_flows", "app_tenant_9"]),
          variant: Schema.Literals([
            "escape_string",
            "doubled_quote",
            "from_comma",
            "unmatched_rparen",
            "nested_parens",
            "subquery_select",
            "subquery_non_select",
            "non_flows_table",
            "stray_flows_ref",
            "valid_join"
          ])
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ schema, variant }) =>
            Effect.sync(() => {
              switch (variant) {
                case "escape_string":
                  expect(QualifiedRead.qualify("SELECT E'foo\\'bar' FROM flows_runs", schema)).toBeUndefined()
                  break
                case "doubled_quote":
                  expect(QualifiedRead.qualify("SELECT 'it''s' FROM flows_runs", schema)).toContain(
                    `"${schema}".flows_runs`
                  )
                  break
                case "from_comma":
                  expect(QualifiedRead.qualify("SELECT * FROM flows_a, flows_b", schema)).toBeUndefined()
                  break
                case "unmatched_rparen":
                  expect(QualifiedRead.qualify("SELECT 1) FROM flows_runs", schema)).toBeUndefined()
                  break
                case "nested_parens":
                  expect(
                    QualifiedRead.qualify("SELECT count(id) FROM flows_runs WHERE (id IN (1, 2))", schema)
                  ).toContain(`"${schema}".flows_runs`)
                  break
                case "subquery_select":
                  expect(
                    QualifiedRead.qualify("SELECT * FROM (SELECT id FROM flows_runs) sub", schema)
                  ).toContain(`"${schema}".flows_runs`)
                  break
                case "subquery_non_select":
                  expect(
                    QualifiedRead.qualify("SELECT * FROM (flows_runs) sub", schema)
                  ).toBeUndefined()
                  break
                case "non_flows_table":
                  expect(
                    QualifiedRead.qualify("SELECT * FROM other_table", schema)
                  ).toBeUndefined()
                  break
                case "stray_flows_ref":
                  expect(
                    QualifiedRead.qualify("SELECT flows_runs FROM flows_runs", schema)
                  ).toBeUndefined()
                  break
                case "valid_join":
                  expect(
                    QualifiedRead.qualify(
                      "SELECT flows_a.id FROM flows_a JOIN flows_b ON flows_a.id = flows_b.id",
                      schema
                    )
                  ).toContain(`"${schema}".flows_b`)
                  break
              }
              return true
            }),
          { executions: Math.min(executions, 80), seed }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it("fuzzes WriteRetry classification, uninspectable getters, SQLite errcodes, and IO defects", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        errcode: Schema.Literals([19, 2067, 5, 261, 10]),
        dbCode: Schema.Literals(["busy", "io", "constraint", "schema", "unsupported", "unknown"]),
        badAttempts: Schema.Literals([0, -1, 1.5, -10])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ errcode, dbCode, badAttempts }) =>
          Effect.gen(function*() {
            const throwingProp = (prop: string) =>
              new Proxy({}, {
                get(_t, p) {
                  if (p === prop) throw new Error(`boom ${prop}`)
                  if (p === "code" && prop === "errcode") return "ERR_SQLITE_ERROR"
                  return undefined
                }
              })

            expect(WriteRetry.isBusyCause(throwingProp("code"))).toBe(false)
            expect(WriteRetry.isBusyCause(throwingProp("errcode"))).toBe(false)
            expect(WriteRetry.isBusyCause(throwingProp("message"))).toBe(false)
            expect(WriteRetry.isBusyCause(throwingProp("cause"))).toBe(false)
            expect(WriteRetry.findFailureCode(throwingProp("cause"))).toBeUndefined()

            const throwingSqlCheck = new Proxy({}, {
              get() {
                throw new Error("no inspect")
              },
              has() {
                throw new Error("no has")
              }
            })
            expect(WriteRetry.isBusyCause(throwingSqlCheck)).toBe(false)

            const sqliteErr = new SqlError({
              reason: new UnknownError({
                cause: { code: "ERR_SQLITE_ERROR", errcode, message: "sqlite err" },
                message: "sqlite err",
                operation: "execute"
              })
            })
            const classified = WriteRetry.classifySqlError(sqliteErr)
            if ((errcode & 0xff) === 19) {
              expect(classified).toBe("constraint")
            }

            const lockErr = new SqlError({
              reason: new LockTimeoutError({
                cause: Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
                message: "timeout",
                operation: "execute"
              })
            })
            expect(WriteRetry.classifySqlError(lockErr)).toBe("busy")

            const nestedSql = { cause: lockErr }
            expect(WriteRetry.isBusyCause(nestedSql)).toBe(true)

            const dbErr = new DurableWriter.DatabaseError({ code: dbCode, cause: "x" })
            expect(WriteRetry.findFailureCode(dbErr)).toBe(dbCode)

            let tries = 0
            const ioFail = yield* Effect.exit(
              WriteRetry.withWriteRetry(
                Effect.suspend(() => {
                  tries += 1
                  return Effect.fail(new DurableWriter.DatabaseError({ code: "io", cause: "disk" }))
                }),
                { maxAttempts: badAttempts }
              )
            )
            expect(Exit.isFailure(ioFail)).toBe(true)
            expect(tries).toBe(1)

            let dieTries = 0
            const ioDie = yield* Effect.exit(
              WriteRetry.withWriteRetry(
                Effect.suspend(() => {
                  dieTries += 1
                  return Effect.die(Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" }))
                }),
                { maxAttempts: 3 }
              )
            )
            expect(Exit.isFailure(ioDie)).toBe(true)
            expect(dieTries).toBe(1)
            return true
          }),
        { executions: Math.min(executions, 60), seed }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("fuzzes DurableWriter affectedRows edge cases, defect unwrapping, and interrupt undo semantics", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        rawKind: Schema.Literals([
          "null",
          "string",
          "array",
          "plain_object",
          "bad_changes_type",
          "throwing_descriptor"
        ]),
        mode: Schema.Literals(["begin_die_sql", "commit_die_sql", "interrupt_nested", "interrupt_before_body"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ rawKind, mode }) =>
          Effect.gen(function*() {
            const ro = yield* WriteLock.ReadOnlyBody
            expect(ro).toBe(false)

            const rawVal: unknown = rawKind === "null"
              ? null
              : rawKind === "string"
              ? "bad"
              : rawKind === "array"
              ? [1, 2]
              : rawKind === "plain_object"
              ? { foo: "bar" }
              : rawKind === "bad_changes_type"
              ? { changes: "not-a-number" }
              : new Proxy({}, {
                getOwnPropertyDescriptor() {
                  throw new Error("descriptor exploded")
                }
              })
            const affectedExit = yield* Effect.exit(DurableWriter.affectedRows(rawVal))
            expect(Exit.isFailure(affectedExit)).toBe(true)

            if (mode === "begin_die_sql" || mode === "commit_die_sql") {
              const sqlErr = new SqlError({
                reason: new UnknownError({
                  cause: Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
                  message: "locked",
                  operation: "execute"
                })
              })
              const fakeSql = yield* SqlClient.make({
                acquirer: Effect.succeed({
                  execute: (q: string) =>
                    (mode === "begin_die_sql" && q.startsWith("BEGIN")) ||
                      (mode === "commit_die_sql" && q.startsWith("COMMIT"))
                      ? Effect.die(sqlErr)
                      : Effect.succeed([]),
                  executeRaw: () => Effect.succeed([]),
                  executeValues: () => Effect.succeed([]),
                  executeValuesUnprepared: () => Effect.succeed([]),
                  executeUnprepared: (q: string) =>
                    (mode === "begin_die_sql" && q.startsWith("BEGIN")) ||
                      (mode === "commit_die_sql" && q.startsWith("COMMIT"))
                      ? Effect.die(sqlErr)
                      : Effect.succeed([]),
                  executeStream: () => Stream.empty
                }),
                compiler: Pg.PgClient.makeCompiler(),
                spanAttributes: [],
                transformRows: undefined,
                driver: "pg"
              }).pipe(Effect.provide(Reactivity.layer))
              const writer = DurableWriter.make(fakeSql, { maxAttempts: 1 })
              const exit = yield* Effect.exit(writer.write(Effect.succeed("ok")))
              expect(Exit.isFailure(exit)).toBe(true)
            } else {
              yield* Effect.scoped(
                Effect.gen(function*() {
                  const writer = yield* DurableWriter.DurableWriter
                  const undos: Array<string> = []
                  if (mode === "interrupt_nested") {
                    const gate = yield* Deferred.make<void>()
                    const fiber = yield* Effect.forkChild(
                      writer.write(
                        Effect.gen(function*() {
                          yield* writer.write(
                            Effect.gen(function*() {
                              yield* DurableWriter.afterRollback(Effect.sync(() => {
                                undos.push("nested")
                              }))
                              return "inner"
                            })
                          )
                          yield* Deferred.succeed(gate, undefined)
                          return yield* Effect.never
                        })
                      )
                    )
                    yield* Deferred.await(gate)
                    yield* Fiber.interrupt(fiber)
                    expect(undos).toContain("nested")
                  } else {
                    const gate = yield* Deferred.make<void>()
                    const fiber = yield* Effect.forkChild(
                      writer.write(
                        Effect.gen(function*() {
                          yield* DurableWriter.afterRollback(Effect.sync(() => {
                            undos.push("outer")
                          }))
                          yield* Deferred.succeed(gate, undefined)
                          return yield* Effect.never
                        })
                      )
                    )
                    yield* Deferred.await(gate)
                    yield* Fiber.interrupt(fiber)
                    expect(undos).toContain("outer")
                  }
                }).pipe(Effect.provide(TestDatabase.sqliteLayer))
              )
            }
            return true
          }),
        { executions: Math.min(executions, 30), seed }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("fuzzes SqliteOpen + NodeDatabase edge paths: symlinks, URIs, corrupt/locked files", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        variant: Schema.Literals([
          "symlink_create",
          "missing_parent_dir",
          "memory_uri",
          "file_uri_no_query",
          "file_uri_with_query",
          "corrupt_file",
          "null_byte_path"
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ variant }) =>
          Effect.promise(async () => {
            const dir = mkdtempSync(join(tmpdir(), "wave10b-db-"))
            try {
              switch (variant) {
                case "symlink_create": {
                  const target = join(dir, "real.sqlite")
                  const link = join(dir, "link.sqlite")
                  symlinkSync(target, link)
                  SqliteOpen.createDatabaseFile(link, true)
                  expect(SqliteOpen.probeTarget(`file:${link}?mode=rwc#frag`)).toBe(`file:${link}`)
                  expect(SqliteOpen.probeTarget(`file:${link}`)).toBe(`file:${link}`)
                  break
                }
                case "missing_parent_dir": {
                  expect(() => SqliteOpen.createDatabaseFile(join(dir, "no-such-dir", "db.sqlite"), true)).toThrow()
                  break
                }
                case "memory_uri": {
                  const uri = `file:w10mem_${randomUUID().slice(0, 8)}?mode=memory&cache=shared`
                  await Effect.runPromise(
                    Effect.scoped(
                      Effect.gen(function*() {
                        const sql = yield* SqlClient.SqlClient
                        const rows = yield* sql`SELECT 1 AS n`
                        expect(rows.length).toBe(1)
                      }).pipe(Effect.provide(NodeDatabase.layer({ filename: uri })))
                    )
                  )
                  break
                }
                case "file_uri_no_query": {
                  const uri = `file:${join(dir, "plain.sqlite")}`
                  await Effect.runPromise(
                    Effect.scoped(
                      Effect.gen(function*() {
                        const sql = yield* SqlClient.SqlClient
                        yield* sql`CREATE TABLE t (id INTEGER)`
                      }).pipe(Effect.provide(NodeDatabase.layer({ filename: uri })))
                    )
                  )
                  break
                }
                case "file_uri_with_query": {
                  const uri = `file:${join(dir, "rwc.sqlite")}?mode=rwc`
                  await Effect.runPromise(
                    Effect.scoped(
                      Effect.gen(function*() {
                        const sql = yield* SqlClient.SqlClient
                        yield* sql`CREATE TABLE t (id INTEGER)`
                      }).pipe(Effect.provide(NodeDatabase.layer({ filename: uri })))
                    )
                  )
                  break
                }
                case "corrupt_file": {
                  const bad = join(dir, "corrupt.sqlite")
                  writeFileSync(bad, "not a sqlite database at all!!!")
                  const exit = await Effect.runPromiseExit(
                    Effect.scoped(
                      Effect.gen(function*() {
                        const sql = yield* SqlClient.SqlClient
                        return yield* sql`SELECT 1`
                      }).pipe(Effect.provide(NodeDatabase.layer({ filename: bad })))
                    )
                  )
                  expect(Exit.isFailure(exit)).toBe(true)
                  break
                }
                case "null_byte_path": {
                  const exit = await Effect.runPromiseExit(
                    Effect.scoped(
                      Effect.gen(function*() {
                        const sql = yield* SqlClient.SqlClient
                        return yield* sql`SELECT 1`
                      }).pipe(Effect.provide(NodeDatabase.layer({ filename: join(dir, "bad\0.sqlite") })))
                    )
                  )
                  expect(Exit.isFailure(exit)).toBe(true)
                  break
                }
              }
            } finally {
              rmSync(dir, { recursive: true, force: true })
            }
            return true
          }),
        { executions: Math.min(executions, 16), seed }
      )
    )
    assertPassed(report)

    const lockDir = mkdtempSync(join(tmpdir(), "wave10b-lock-"))
    try {
      const lockedPath = join(lockDir, "locked.sqlite")
      const holder = new DatabaseSync(lockedPath)
      try {
        holder.exec("CREATE TABLE t (id INTEGER)")
        holder.exec("BEGIN EXCLUSIVE")
        const exit = await Effect.runPromiseExit(
          Effect.scoped(
            Effect.gen(function*() {
              const sql = yield* SqlClient.SqlClient
              return yield* sql`SELECT 1`
            }).pipe(Effect.provide(NodeDatabase.layer({ filename: lockedPath, busyTimeout: Duration.millis(10) })))
          )
        )
        expect(Exit.isFailure(exit)).toBe(true)
      } finally {
        try {
          holder.exec("ROLLBACK")
        } catch {
          // ignore
        }
        holder.close()
      }
    } finally {
      rmSync(lockDir, { recursive: true, force: true })
    }
  }, 60_000)

  it(
    "exercises Dialect, Migrations, TestDatabase, PostgresDatabase savepoints/partitions, and PostgresSelection against real Postgres 18",
    async () => {
      if (!PG_URL) return
      await withPgSchema("dialect", (schema, sql) =>
        Effect.gen(function*() {
          expect(Dialect.isPostgres(sql)).toBe(true)
          yield* sql`CREATE TABLE items (id INTEGER PRIMARY KEY, val TEXT)`
          const tbls = yield* Dialect.tables(sql)
          expect(tbls.some((t) => t.name === "items")).toBe(true)
          const cols = yield* Dialect.columns(sql, "items")
          expect(cols.map((c) => c.name)).toContain("val")

          yield* Dialect.trigger(sql, {
            name: "trg_reject",
            event: "BEFORE INSERT",
            table: "items",
            when: "NEW.val = 'forbidden'",
            reject: "forbidden value"
          })
          const rejExit = yield* Effect.exit(sql`INSERT INTO items VALUES (1, 'forbidden')`)
          expect(Exit.isFailure(rejExit)).toBe(true)
          yield* Dialect.dropTrigger(sql, "trg_reject", "items")

          yield* Dialect.trigger(sql, {
            name: "trg_ignore",
            event: "BEFORE INSERT",
            table: "items",
            when: "NEW.val = 'skip'",
            ignore: true
          })
          yield* sql`INSERT INTO items VALUES (2, 'skip')`
          yield* Dialect.dropTrigger(sql, "trg_ignore", "items")

          yield* Dialect.trigger(sql, {
            name: "trg_del",
            event: "AFTER DELETE",
            table: "items",
            body: "PERFORM 1;"
          })
          yield* sql`INSERT INTO items VALUES (3, 'keep')`
          yield* sql`DELETE FROM items WHERE id = 3`
          yield* Dialect.dropTrigger(sql, "trg_del", "items")

          yield* Dialect.setTriggerMode(sql, [], "IMMEDIATE")
          yield* Dialect.flushDeferredTriggers(sql, [])
          yield* sql.withTransaction(
            Effect.gen(function*() {
              yield* Dialect.setTriggerMode(sql, [["items", "no_such_trg"]], "IMMEDIATE")
              yield* Dialect.flushDeferredTriggers(sql, [["items", "no_such_trg"]])
            })
          )

          yield* sql`INSERT INTO items VALUES (10, 'hello')`
          const qRows = yield* Dialect.query<{ readonly val: string }>(
            sql,
            "SELECT val FROM items WHERE id = ?",
            [10]
          )
          expect(qRows[0]?.val).toBe("hello")

          const rtOk = yield* Dialect.readTransaction(sql, sql`SELECT val FROM items WHERE id = 10`)
          expect(rtOk.length).toBe(1)
          const rtFail = yield* Effect.exit(
            Dialect.readTransaction(sql, Effect.fail("boom-rt"))
          )
          expect(Exit.isFailure(rtFail)).toBe(true)
          const nestedRt = yield* sql.withTransaction(
            Dialect.readTransaction(sql, sql`SELECT val FROM items WHERE id = 10`)
          )
          expect(nestedRt.length).toBe(1)

          yield* sql`CREATE TABLE p_parent (id INTEGER PRIMARY KEY CHECK (id > 0))`
          yield* sql`CREATE TABLE p_child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p_parent(id))`
          yield* TestDatabase.checks(sql, false)
          yield* TestDatabase.checks(sql, true)
          yield* TestDatabase.foreignKeys(sql, false)
          yield* TestDatabase.foreignKeys(sql, true)

          yield* Effect.scoped(
            Effect.gen(function*() {
              const conn = yield* sql.reserve
              yield* conn.executeValuesUnprepared("SELECT 1", [])
              yield* conn.executeUnprepared("SELECT 1", [], undefined)
            })
          )
          yield* sql.withTransaction(
            Effect.gen(function*() {
              const [conn] = (yield* Effect.serviceOption(sql.transactionService)).pipe(
                (o) => (o._tag === "Some" ? o.value : (() => {
                  throw new Error("no tx")
                })())
              )
              yield* conn.executeValues("SELECT 1", [])
              yield* conn.executeValuesUnprepared("SELECT 1", [])
              const streamed = yield* Stream.runCollect(conn.executeStream("SELECT 1 AS n", [], undefined))
              expect(streamed.length).toBe(1)
            })
          )

          // Nested partition join + widen + savepoint rollback releasing schema and partition locks
          const writer = DurableWriter.make(sql)
          yield* writer.write(
            Effect.gen(function*() {
              // Join second partition inside p1, then roll back savepoint
              yield* Effect.exit(
                writer.write(
                  Effect.andThen(sql`SELECT 1`, Effect.fail("rollback-p2")),
                  { partition: "p2" }
                )
              )
              // Widen to whole schema lock, then roll back savepoint
              yield* Effect.exit(
                writer.write(
                  Effect.andThen(sql`SELECT 1`, Effect.fail("rollback-wide"))
                )
              )
            }),
            { partition: "p1" }
          )
          expect(schema.length).toBeGreaterThan(0)
        }))

      await withPgSchema("mig", (_schema, sql) =>
        Effect.gen(function*() {
          const set1: Migrations.MigrationSet = {
            namespace: "w10",
            idOffset: 0,
            immediateTriggers: [["w10_tbl", "w10_trg"]],
            migrations: {
              "0001_init": Effect.gen(function*() {
                const s = yield* SqlClient.SqlClient
                yield* s`CREATE TABLE w10_tbl (id INTEGER PRIMARY KEY)`
              })
            }
          }
          const setHigh: Migrations.MigrationSet = {
            namespace: "w10b",
            idOffset: 1000,
            migrations: {
              "0001_hi": Effect.void
            }
          }
          const first = yield* Migrations.run([set1, setHigh])
          expect(first.length).toBe(2)

          // Forward addition in earlier block via Migrations.loader (exercises loader's onLoaderApplied callback & block upgrade)
          const set1Extended: Migrations.MigrationSet = {
            namespace: "w10",
            idOffset: 0,
            migrations: {
              "0001_init": Effect.void,
              "0002_extra": Effect.void
            }
          }
          const loadedExtended = yield* Migrations.loader([set1Extended, setHigh])
          expect(loadedExtended.length).toBe(3)

          // Forward addition in earlier block that FAILS (exercises Migrations.ts line 307)
          const set1Fail: Migrations.MigrationSet = {
            namespace: "w10",
            idOffset: 0,
            migrations: {
              "0001_init": Effect.void,
              "0002_extra": Effect.void,
              "0003_boom": Effect.fail(new Error("block-upgrade-boom"))
            }
          }
          const failUpgrade = yield* Effect.exit(Migrations.loader([set1Fail, setHigh]))
          expect(Exit.isFailure(failUpgrade)).toBe(true)

          const second = yield* Migrations.run([set1Extended, setHigh])
          expect(second).toEqual([])

          const setRenamed: Migrations.MigrationSet = {
            namespace: "w10",
            idOffset: 0,
            previousNames: { "0001_init_v2": ["init"] },
            migrations: {
              "0001_init_v2": Effect.void,
              "0002_extra": Effect.void
            }
          }
          const third = yield* Migrations.run([setRenamed, setHigh])
          expect(third).toEqual([])

          const fourth = yield* sql.withTransaction(Migrations.run([set1Extended, setHigh]))
          expect(fourth).toEqual([])

          const badOffset = yield* Effect.exit(
            Migrations.run([{ namespace: "bad", idOffset: 1.5, migrations: { "0001_a": Effect.void } }])
          )
          expect(Exit.isFailure(badOffset)).toBe(true)
        }))

      // Invalid URL syntax in PostgresSelection
      const invalidUrlExit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function*() {
            return yield* SqlClient.SqlClient
          }).pipe(
            Effect.provide(
              NodeDatabase.layer({
                filename: "/tmp/x.sqlite",
                settings: { SMITHERS_POSTGRES_URL: "postgres://[::1" }
              })
            )
          )
        )
      )
      expect(Exit.isFailure(invalidUrlExit)).toBe(true)

      const selSchema = tempSchema("sel")
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const sql = yield* SqlClient.SqlClient
              const rows = yield* sql`SELECT basename FROM flows_store_owner WHERE id = 1`
              expect(rows).toEqual([{ basename: "store-1.sqlite" }])
            }).pipe(
              Effect.provide(
                NodeDatabase.layer({
                  filename: "/tmp/dir1/store-1.sqlite",
                  settings: {
                    SMITHERS_POSTGRES_URL: PG_URL,
                    SMITHERS_POSTGRES_SCHEMA: selSchema
                  }
                })
              )
            )
          )
        )
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const sql = yield* SqlClient.SqlClient
              const rows = yield* sql`SELECT 1 AS ok`
              expect(rows.length).toBe(1)
            }).pipe(
              Effect.provide(
                NodeDatabase.layer({
                  filename: "/tmp/dir2/store-1.sqlite",
                  readOnly: true,
                  settings: {
                    SMITHERS_POSTGRES_URL: PG_URL,
                    SMITHERS_POSTGRES_SCHEMA: selSchema
                  }
                })
              )
            )
          )
        )
        const collisionExit = await Effect.runPromiseExit(
          Effect.scoped(
            Effect.gen(function*() {
              return yield* SqlClient.SqlClient
            }).pipe(
              Effect.provide(
                NodeDatabase.layer({
                  filename: "/tmp/dir2/store_1.sqlite",
                  settings: {
                    SMITHERS_POSTGRES_URL: PG_URL,
                    SMITHERS_POSTGRES_SCHEMA: selSchema
                  }
                })
              )
            )
          )
        )
        expect(Exit.isFailure(collisionExit)).toBe(true)

        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const sql = yield* SqlClient.SqlClient
              const rows = yield* sql`SELECT 1 AS ok`
              expect(rows.length).toBe(1)
            }).pipe(
              Effect.provide(
                NodeDatabase.layer({
                  filename: PG_URL,
                  settings: { SMITHERS_POSTGRES_SCHEMA: selSchema }
                })
              )
            )
          )
        )
      } finally {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const sql = yield* SqlClient.SqlClient
              yield* TestDatabase.dropSchema(sql, selSchema)
              yield* TestDatabase.dropSchema(sql, `${selSchema}_store_1_sqlite`)
            }).pipe(Effect.provide(PostgresDatabase.layer({ url: PG_URL, driver: Pg, schema: selSchema })))
          )
        )
      }

      const prevPgUrl = process.env.SMITHERS_TEST_PG_URL
      try {
        delete process.env.SMITHERS_TEST_PG_URL
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const sql = yield* SqlClient.SqlClient
              expect(Dialect.isPostgres(sql)).toBe(false)
            }).pipe(Effect.provide(TestDatabase.layer))
          )
        )
        process.env.SMITHERS_TEST_PG_URL = PG_URL
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const sql = yield* SqlClient.SqlClient
              expect(Dialect.isPostgres(sql)).toBe(true)
            }).pipe(Effect.provide(TestDatabase.layer))
          )
        )
      } finally {
        if (prevPgUrl === undefined) delete process.env.SMITHERS_TEST_PG_URL
        else process.env.SMITHERS_TEST_PG_URL = prevPgUrl
      }
    },
    60_000
  )

  it(
    "fuzzes Migrations validation errors, failing body, bigint ids, PostgresDatabase lock errors, and SlowNetwork flush",
    async () => {
      const invalidSets: ReadonlyArray<Migrations.MigrationSet> = [
        { namespace: "n", idOffset: 1.5, migrations: { "0001_a": Effect.void } },
        { namespace: "n", idOffset: Number.MAX_SAFE_INTEGER + 2, migrations: { "0001_a": Effect.void } },
        { namespace: "n", idOffset: 2_147_484_000, migrations: { "0001_a": Effect.void } },
        {
          namespace: "n",
          idOffset: 0,
          previousNames: { "0002_missing": ["old"] },
          migrations: { "0001_a": Effect.void }
        },
        {
          namespace: "n",
          idOffset: 0,
          previousNames: { "0001_a": [" untrimmed "] },
          migrations: { "0001_a": Effect.void }
        },
        { namespace: "n", idOffset: 2_147_483_000, migrations: { "0999_overflow": Effect.void } }
      ]
      for (const set of invalidSets) {
        const exit = await Effect.runPromiseExit(
          Effect.scoped(
            Migrations.run([set]).pipe(Effect.provide(TestDatabase.sqliteLayer), Effect.provide(silentLogger))
          )
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }

      const failBodyExit = await Effect.runPromiseExit(
        Effect.scoped(
          Migrations.run([
            {
              namespace: "failns",
              idOffset: 0,
              migrations: { "0001_boom": Effect.fail(new Error("migration exploded")) }
            }
          ]).pipe(Effect.provide(TestDatabase.sqliteLayer), Effect.provide(silentLogger))
        )
      )
      expect(Exit.isFailure(failBodyExit)).toBe(true)

      const bigintExit = await Effect.runPromiseExit(
        Effect.scoped(
          Migrations.run([
            { namespace: "ns", idOffset: 0, migrations: { "0001_init": Effect.void } }
          ]).pipe(
            Effect.provide(
              PostgresDatabase.layer({
                url: PG_URL,
                driver: makeFakePgDriver({ returnBigintMigration: true }),
                writerLockTimeout: Duration.infinity,
                writerLockAttempts: 0
              })
            ),
            Effect.provide(silentLogger)
          )
        )
      )
      expect(Exit.isSuccess(bigintExit)).toBe(true)

      // to_regclass failing in installed()
      const regclassFailExit = await Effect.runPromiseExit(
        Effect.scoped(
          Migrations.run([
            { namespace: "ns", idOffset: 0, migrations: { "0001_init": Effect.void } }
          ]).pipe(
            Effect.provide(
              PostgresDatabase.layer({
                url: PG_URL,
                driver: makeFakePgDriver({ failRegclass: true, failSelect: true })
              })
            ),
            Effect.provide(silentLogger)
          )
        )
      )
      expect(Exit.isFailure(regclassFailExit)).toBe(true)

      const badStateExit = await Effect.runPromiseExit(
        Effect.scoped(
          Migrations.run([
            { namespace: "ns", idOffset: 0, migrations: { "0001_init": Effect.void } }
          ]).pipe(
            Effect.provide(
              PostgresDatabase.layer({
                url: PG_URL,
                driver: makeFakePgDriver({ failSelect: true })
              })
            ),
            Effect.provide(silentLogger)
          )
        )
      )
      expect(Exit.isFailure(badStateExit)).toBe(true)

      const unknownLockExit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            yield* sql.withTransaction(sql`SELECT 1`)
          }).pipe(
            Effect.provide(
              PostgresDatabase.layer({
                url: PG_URL,
                driver: makeFakePgDriver({ lockFailure: "unknown" }),
                writerLockTimeout: Duration.millis(5),
                writerLockAttempts: 2
              })
            ),
            Effect.provide(silentLogger)
          )
        )
      )
      expect(Exit.isFailure(unknownLockExit)).toBe(true)

      const timeoutExhaustExit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            yield* sql.withTransaction(sql`SELECT 1`)
          }).pipe(
            Effect.provide(
              PostgresDatabase.layer({
                url: PG_URL,
                driver: makeFakePgDriver({ lockFailure: "timeout" }),
                writerLockTimeout: Duration.millis(1),
                writerLockAttempts: 1
              })
            ),
            Effect.provide(silentLogger)
          )
        )
      )
      expect(Exit.isFailure(timeoutExhaustExit)).toBe(true)

      expect(SlowNetworkTarget.endpoint("postgres://user:pass@127.0.0.1/db")).toEqual({
        host: "127.0.0.1",
        port: 5432
      })
      expect(SlowNetworkTarget.endpoint("postgres://user:pass@127.0.0.1:54321/db")).toEqual({
        host: "127.0.0.1",
        port: 54321
      })

      const echoServer = Net.createServer((socket) => {
        socket.on("data", (chunk) => socket.write(chunk))
        socket.on("end", () => socket.end())
      })
      await new Promise<void>((resolve) => echoServer.listen(0, "127.0.0.1", resolve))
      try {
        const addr = echoServer.address() as Net.AddressInfo
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const proxyUrl = yield* SlowNetwork.proxy(`postgres://u:p@127.0.0.1:${addr.port}/db`, {
                delayMs: 5
              })
              const ep = SlowNetworkTarget.endpoint(proxyUrl)
              const reply = yield* Effect.promise(
                () =>
                  new Promise<string>((resolve, reject) => {
                    const client = Net.connect(ep.port, ep.host, () => {
                      client.write("ping")
                    })
                    const chunks: Array<Uint8Array> = []
                    client.on("data", (c) => {
                      chunks.push(typeof c === "string" ? Buffer.from(c) : c)
                      client.end()
                    })
                    client.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")))
                    client.on("error", reject)
                  })
              )
              expect(reply).toBe("ping")
            })
          )
        )
      } finally {
        await new Promise<void>((resolve) => echoServer.close(() => resolve()))
      }
    },
    60_000
  )
})
