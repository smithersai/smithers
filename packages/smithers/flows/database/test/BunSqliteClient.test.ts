import { describe, expect, it } from "@effect/vitest"
import { Cause, Duration, Effect, Exit, Result, Stream } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import type * as SqlError from "effect/sql/SqlError"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { vi } from "vitest"

// Measures the vendored Bun client in the Node coverage lane. Only `bun:sqlite`
// is replaced, by a shim that keeps Bun's statement contract over node:sqlite:
// `.all()` returns `[]` for a column-less statement and `.values()` returns
// `null` (checked against Bun 1.3). Real Bun runs the same client in
// NativeBunSqliteClient.test.ts and agent/memory NativeBunAffectedRows.test.ts.
const opened = vi.hoisted(() => [] as Array<unknown>)
// What the next open, or the next statements `run` is given, throw.
const faults = vi.hoisted(() => ({
  open: undefined as unknown,
  run: undefined as { readonly match: string; readonly error: unknown; times: number } | undefined
}))
vi.mock("bun:sqlite", async () => {
  const { DatabaseSync } = await import("node:sqlite")
  const constants = {
    SQLITE_OPEN_READONLY: 0x01,
    SQLITE_OPEN_READWRITE: 0x02,
    SQLITE_OPEN_CREATE: 0x04,
    SQLITE_OPEN_URI: 0x40
  }
  return {
    constants,
    Database: class {
      private readonly database: InstanceType<typeof DatabaseSync>
      constructor(filename: string, options: number | { readonly readonly: boolean }) {
        opened.push(options)
        if (faults.open !== undefined) {
          const failure = faults.open
          faults.open = undefined
          throw failure
        }
        this.database = new DatabaseSync(filename, {
          readOnly: typeof options === "number" ? (options & constants.SQLITE_OPEN_READONLY) !== 0 : options.readonly
        })
      }
      get inTransaction() {
        return this.database.isTransaction
      }
      run(sql: string) {
        if (faults.run !== undefined && sql.includes(faults.run.match) && faults.run.times > 0) {
          faults.run.times -= 1
          throw faults.run.error
        }
        this.database.exec(sql)
      }
      query(sql: string) {
        const statement = this.database.prepare(sql)
        const columnNames = statement.columns().map((column) => column.name)
        return {
          columnNames,
          safeIntegers: (enabled: boolean) => statement.setReadBigInts(enabled),
          all: (...params: Array<any>) => {
            statement.setReturnArrays(false)
            return statement.all(...params)
          },
          values: (...params: Array<any>) => {
            if (columnNames.length === 0) {
              statement.run(...params)
              return null
            }
            statement.setReturnArrays(true)
            return statement.all(...params)
          },
          run: (...params: Array<any>) => statement.run(...params)
        }
      }
      close() {
        this.database.close()
      }
    }
  }
})

import type { SqliteClientConfig } from "@effect/sql-sqlite-bun/SqliteClient"
import * as BunSqliteClient from "../src/internal/BunSqliteClient.vibe"

const withClient = <A, E>(
  config: SqliteClientConfig,
  program: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>
) =>
  Effect.runPromiseExit(
    Effect.scoped(Effect.flatMap(SqlClient.SqlClient, program)).pipe(
      Effect.provide(BunSqliteClient.layer(config))
    )
  )

/** The classified reason a client, or one of its statements, failed with. */
const reasonOf = (exit: Exit.Exit<unknown, unknown>): SqlError.SqlError["reason"] | undefined =>
  Exit.isFailure(exit)
    ? (Result.getOrUndefined(Cause.findError(exit.cause)) as SqlError.SqlError | undefined)?.reason
    : undefined

const withRoot = async (run: (root: string) => Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), "flows-bun-client-"))
  try {
    await run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("Bun SQLite client", () => {
  it("returns affected rows from raw writes and rows from raw reads", async () => {
    opened.length = 0
    const exit = await withClient({ filename: ":memory:" }, (sql) =>
      Effect.gen(function*() {
        yield* sql`CREATE TABLE t (id INTEGER PRIMARY KEY, first_name TEXT)`
        const insert = yield* sql`INSERT INTO t (id, first_name) VALUES (1, 'a'), (2, 'b')`.raw
        const deleteMatch = yield* sql`DELETE FROM t WHERE id = 1`.raw
        const deleteMiss = yield* sql`DELETE FROM t WHERE id = 1`.raw
        const returning = yield* sql`INSERT INTO t (id, first_name) VALUES (3, 'c') RETURNING id`.raw
        const transaction = yield* sql.withTransaction(sql`DELETE FROM t WHERE id = 3`.raw)
        const rows = yield* sql`SELECT id, first_name FROM t`
        const values = yield* sql`SELECT id FROM t`.values
        const writeValues = yield* sql`UPDATE t SET first_name = 'z'`.values
        const unprepared = yield* sql`SELECT count(*) AS n FROM t`.unprepared
        const wide = yield* Effect.provideService(sql`SELECT 9007199254740993 AS n`, SqlClient.SafeIntegers, true)
        return { insert, deleteMatch, deleteMiss, returning, transaction, rows, values, writeValues, unprepared, wide }
      }))
    expect(exit).toEqual(Exit.succeed({
      insert: { changes: 2, lastInsertRowid: 2 },
      deleteMatch: { changes: 1, lastInsertRowid: 2 },
      deleteMiss: { changes: 0, lastInsertRowid: 2 },
      returning: [{ id: 3 }],
      transaction: { changes: 1, lastInsertRowid: 3 },
      rows: [{ id: 2, first_name: "b" }],
      values: [[2]],
      writeValues: [],
      unprepared: [{ n: 1 }],
      wide: [{ n: 9007199254740993n }]
    }))
    expect(opened).toEqual([{ readonly: false, readwrite: true, create: true }])
  })

  it("fails statements as SqlError and rejects streaming", async () => {
    const failed = await withClient({ filename: ":memory:" }, (sql) => sql`SELECT * FROM missing`)
    expect(Exit.isFailure(failed) && String(failed.cause)).toMatch(/SqlError/)
    const streamed = await withClient({ filename: ":memory:" }, (sql) => Stream.runCollect(sql`SELECT 1`.stream))
    expect(Exit.isFailure(streamed) && String(streamed.cause)).toMatch(/executeStream not implemented/)
  })

  it("applies configured options: transforms, span attributes, busy timeout, WAL, readonly", () =>
    withRoot(async (root) => {
      const filename = join(root, "db.sqlite")
      opened.length = 0
      const written = await withClient({
        filename,
        readwrite: true,
        create: true,
        busyTimeout: Duration.millis(250),
        spanAttributes: { service: "test" },
        transformResultNames: (name) => name.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())
      }, (sql) =>
        Effect.gen(function*() {
          yield* sql`CREATE TABLE t (first_name TEXT)`
          yield* sql`INSERT INTO t VALUES ('a')`
          return {
            rows: yield* sql`SELECT first_name FROM t`,
            journal: yield* sql`PRAGMA journal_mode`,
            timeout: yield* sql`PRAGMA busy_timeout`
          }
        }))
      expect(written).toEqual(Exit.succeed({
        rows: [{ firstName: "a" }],
        journal: [{ journalMode: "wal" }],
        timeout: [{ timeout: 250 }]
      }))

      const unjournaled = await withClient(
        { filename: join(root, "plain.sqlite"), disableWAL: true },
        (sql) => sql`PRAGMA journal_mode`
      )
      expect(unjournaled).toEqual(Exit.succeed([{ journal_mode: "delete" }]))

      const readonly = await withClient({ filename, readonly: true }, (sql) =>
        Effect.gen(function*() {
          const rows = yield* sql.withTransaction(sql`SELECT first_name FROM t`)
          const write = yield* Effect.exit(sql`INSERT INTO t VALUES ('b')`)
          return { rows, writeFailed: Exit.isFailure(write) }
        }))
      expect(readonly).toEqual(Exit.succeed({ rows: [{ first_name: "a" }], writeFailed: true }))
      expect(opened).toEqual([
        { readonly: false, readwrite: true, create: true },
        { readonly: false, readwrite: true, create: true },
        { readonly: true, readwrite: false, create: false }
      ])
    }))

  it("opens a `file:` name as a URI, with the access its options ask for", () =>
    withRoot(async (root) => {
      const uri = `file:${join(root, "uri.sqlite")}`
      opened.length = 0
      const written = await withClient({ filename: uri }, (sql) =>
        Effect.andThen(sql`CREATE TABLE t (id INTEGER)`, sql`INSERT INTO t VALUES (1)`.raw))
      expect(written).toEqual(Exit.succeed({ changes: 1, lastInsertRowid: 1 }))
      const read = await withClient({ filename: uri, readonly: true }, (sql) =>
        Effect.gen(function*() {
          const rows = yield* sql`SELECT id FROM t`
          const write = yield* Effect.exit(sql`INSERT INTO t VALUES (2)`)
          return { rows, writeFailed: Exit.isFailure(write) }
        }))
      expect(read).toEqual(Exit.succeed({ rows: [{ id: 1 }], writeFailed: true }))
      // URI with READWRITE and CREATE, then URI with READONLY.
      expect(opened).toEqual([0x46, 0x41])
    }))

  it("fails an open or a PRAGMA as a typed SqlError", async () => {
    faults.open = new Error("unable to open database file")
    expect(reasonOf(await withClient({ filename: ":memory:" }, () => Effect.void))).toMatchObject({
      _tag: "UnknownError",
      message: "Failed to open database",
      operation: "connect"
    })
    faults.run = { match: "busy_timeout", error: new Error("disk I/O error"), times: 1 }
    expect(reasonOf(await withClient({ filename: ":memory:" }, () => Effect.void))).toMatchObject({
      _tag: "UnknownError",
      message: "Failed to configure database",
      operation: "connect"
    })
    expect(faults.run.times).toBe(0)
  })

  it("retries a busy WAL switch until the busy timeout has elapsed, and nothing else", () =>
    withRoot(async (root) => {
      const busy = () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
      faults.run = { match: "journal_mode", error: busy(), times: 2 }
      const switched = await withClient(
        { filename: join(root, "wal.sqlite"), busyTimeout: Duration.seconds(5) },
        (sql) => Effect.all([sql`PRAGMA journal_mode`, sql`PRAGMA busy_timeout`])
      )
      expect(switched).toEqual(Exit.succeed([[{ journal_mode: "wal" }], [{ timeout: 5000 }]]))
      expect(faults.run.times).toBe(0)

      // No time left: one attempt, and the lock is the answer.
      faults.run = { match: "journal_mode", error: busy(), times: 5 }
      const exhausted = await withClient(
        { filename: join(root, "busy.sqlite"), busyTimeout: Duration.zero },
        () => Effect.void
      )
      expect(reasonOf(exhausted)).toMatchObject({ _tag: "LockTimeoutError", message: "Failed to configure database" })
      expect(faults.run.times).toBe(4)

      // Time left, but not a lock: one attempt.
      faults.run = { match: "journal_mode", error: new Error("disk I/O error"), times: 5 }
      const broken = await withClient(
        { filename: join(root, "broken.sqlite"), busyTimeout: Duration.seconds(5) },
        () => Effect.void
      )
      expect(reasonOf(broken)).toMatchObject({ _tag: "UnknownError", message: "Failed to configure database" })
      expect(faults.run.times).toBe(4)
      faults.run = undefined
    }))

  it("rolls a rejected COMMIT back before the connection is lent again, and releases its savepoints", async () => {
    const exit = await withClient({ filename: ":memory:" }, (sql) =>
      Effect.gen(function*() {
        yield* sql`PRAGMA foreign_keys = ON`
        yield* sql`CREATE TABLE parent (id INTEGER PRIMARY KEY)`
        yield* sql`CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)`
        const rejected = yield* Effect.exit(sql.withTransaction(sql`INSERT INTO child VALUES (999)`))
        const rows = yield* sql`SELECT * FROM child`
        const nested = yield* sql.withTransaction(sql.withTransaction(sql`INSERT INTO parent VALUES (1)`.raw))
        // The shim raises node:sqlite's error, whose code Bun's classifier does
        // not read; NativeBunSqliteClient.test.ts asserts the category.
        const typed = reasonOf(rejected) !== undefined
        return { typed, rows, nested, parents: yield* sql`SELECT * FROM parent` }
      }))
    expect(exit).toEqual(Exit.succeed({
      typed: true,
      rows: [],
      nested: { changes: 1, lastInsertRowid: 1 },
      parents: [{ id: 1 }]
    }))
  })
})
