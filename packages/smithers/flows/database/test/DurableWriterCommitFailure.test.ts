import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Result } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as SqlError from "effect/sql/SqlError"
import { expectTypeOf } from "vitest"
import * as DurableWriter from "../src/DurableWriter.ts"
import * as NodeDatabase from "../src/node/NodeDatabase.ts"

const deferredCommit = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const writer = DurableWriter.make(sql)
  let published = false
  yield* sql`PRAGMA foreign_keys = ON`
  yield* sql`CREATE TABLE parent (id INTEGER PRIMARY KEY)`
  yield* sql`CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)`
  const failed = yield* Effect.exit(writer.write(Effect.gen(function*() {
    yield* sql`INSERT INTO child VALUES (999)`
    yield* DurableWriter.afterCommit(
      Effect.sync(() => {
        published = true
      }),
      sql
    )
  })))
  const rows = yield* sql`SELECT * FROM child`
  const next = yield* Effect.exit(writer.write(sql`INSERT INTO parent VALUES (1)`))
  const parents = yield* sql`SELECT * FROM parent`
  return { failed, rows, next, parents, published }
}).pipe(Effect.provide(NodeDatabase.layer({ filename: ":memory:" })))

/**
 * A deferred foreign key that rejects the next COMMIT of a `child` row, on a
 * connection whose ROLLBACK fails for as long as `failing` stays set.
 */
const rejectedCommitWithFailingRollback = (sql: SqlClient.SqlClient) =>
  Effect.gen(function*() {
    yield* sql`PRAGMA foreign_keys = ON`
    yield* sql`CREATE TABLE parent (id INTEGER PRIMARY KEY)`
    yield* sql`CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)`
    const rollbackError = new SqlError.SqlError({
      reason: SqlError.classifySqliteError(Object.assign(new Error("rollback failed"), { code: "SQLITE_IOERR" }))
    })
    const rollback = { attempts: 0, failing: true }
    yield* Effect.scoped(Effect.map(sql.reserve, (conn) => {
      const execute = conn.executeUnprepared.bind(conn)
      Object.assign(conn, {
        executeUnprepared: (...args: Parameters<typeof execute>) => {
          if (args[0] === "ROLLBACK" && rollback.failing) {
            rollback.attempts += 1
            return Effect.fail(rollbackError)
          }
          return execute(...args)
        }
      })
    }))
    return rollback
  })

describe("DurableWriter COMMIT failures", () => {
  it.effect("rolls back rejected rows before reusing the connection", () =>
    Effect.gen(function*() {
      const result = yield* deferredCommit
      expect(result.rows).toEqual([])
      expect(Exit.isSuccess(result.next)).toBe(true)
      expect(result.parents).toEqual([{ id: 1 }])
      expect(result.published).toBe(false)
    }))

  it.effect("normalizes a deferred foreign-key COMMIT failure into a typed DatabaseError", () =>
    Effect.gen(function*() {
      const { failed } = yield* deferredCommit
      expect(Exit.isFailure(failed)).toBe(true)
      if (!Exit.isFailure(failed)) return
      expect(Result.isFailure(Cause.findDefect(failed.cause))).toBe(true)
      const error = Result.getOrUndefined(Cause.findError(failed.cause))
      expect(error).toBeInstanceOf(DurableWriter.DatabaseError)
      expect(error).toMatchObject({ code: "constraint" })
    }))

  it.effect("refuses the connection until a rollback succeeds when COMMIT recovery cannot roll back", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writer = DurableWriter.make(sql)
      const rollback = yield* rejectedCommitWithFailingRollback(sql)
      const failed = yield* Effect.exit(writer.write(sql`INSERT INTO child VALUES (999)`))
      expect(Exit.isFailure(failed)).toBe(true)
      if (!Exit.isFailure(failed)) return
      const errors = failed.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
      expect(errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "constraint" }),
        expect.objectContaining({ code: "io" })
      ]))
      expect(rollback.attempts).toBe(1)
      // A fresh statement must fail rather than expose the rejected
      // transaction or wait on a leaked lease. It asks for the rollback first.
      const read = yield* Effect.exit(sql`SELECT * FROM child`)
      expect(Exit.isFailure(read)).toBe(true)
      if (Exit.isFailure(read)) {
        expect(Cause.pretty(read.cause)).toContain("SQLite connection cannot be reused after failed COMMIT cleanup")
      }
      let ran = false
      const next = yield* Effect.exit(writer.write(Effect.sync(() => {
        ran = true
      })))
      expect(Exit.isFailure(next)).toBe(true)
      expect(ran).toBe(false)
      // One attempt per refused acquisition, and none of them replayed.
      expect(rollback.attempts).toBe(3)
      // The first rollback that goes through returns the connection, without
      // the rejected row.
      rollback.failing = false
      expect(yield* sql`SELECT * FROM child`).toEqual([])
      yield* writer.write(sql`INSERT INTO parent VALUES (1)`)
      expect(yield* sql`SELECT * FROM parent`).toEqual([{ id: 1 }])
    }).pipe(Effect.provide(NodeDatabase.layer({ filename: ":memory:" }))))

  it.effect("rolls back a defective COMMIT while preserving its defect", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writer = DurableWriter.make(sql)
      const defect = new Error("driver COMMIT defect")
      yield* sql`CREATE TABLE values_table (value INTEGER)`
      let commits = 0
      yield* Effect.scoped(Effect.map(sql.reserve, (conn) => {
        const execute = conn.executeUnprepared.bind(conn)
        Object.assign(conn, {
          executeUnprepared: (...args: Parameters<typeof execute>) =>
            args[0] === "COMMIT" && commits++ === 0 ? Effect.die(defect) : execute(...args)
        })
      }))
      const failed = yield* Effect.exit(writer.write(sql`INSERT INTO values_table VALUES (1)`))
      expect(Exit.isFailure(failed)).toBe(true)
      if (!Exit.isFailure(failed)) return
      expect(Result.getOrUndefined(Cause.findDefect(failed.cause))).toBe(defect)
      expect(yield* sql`SELECT * FROM values_table`).toEqual([])
      yield* writer.write(sql`INSERT INTO values_table VALUES (2)`)
      expect(yield* sql`SELECT * FROM values_table`).toEqual([{ value: 2 }])
    }).pipe(Effect.provide(NodeDatabase.layer({ filename: ":memory:" }))))

  it.effect("releases a failed connection acquisition before returning its error", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writer = DurableWriter.make(sql)
      const rollback = yield* rejectedCommitWithFailingRollback(sql)
      yield* Effect.exit(writer.write(sql`INSERT INTO child VALUES (999)`))
      // Every acquisition is now refused. One that kept the connection's
      // permit would leave the next waiting on it forever.
      for (let attempt = 0; attempt < 5; attempt++) {
        const error = yield* Effect.flip(writer.write(Effect.void))
        expect(error).toBeInstanceOf(DurableWriter.DatabaseError)
        expect(SqlError.isSqlError(error.cause) && error.cause.reason._tag).toBe("ConnectionError")
      }
      rollback.failing = false
      yield* writer.write(Effect.void)
    }).pipe(Effect.provide(NodeDatabase.layer({ filename: ":memory:" }))))

  it.effect("returns a typed storage error when BEGIN fails before entering the body", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writer = DurableWriter.make(sql)
      const failure = new SqlError.SqlError({
        reason: SqlError.classifySqliteError(Object.assign(new Error("BEGIN unavailable"), { code: "SQLITE_IOERR" }))
      })
      let refused = true
      yield* Effect.scoped(Effect.map(sql.reserve, (conn) => {
        const execute = conn.executeUnprepared.bind(conn)
        Object.assign(conn, {
          executeUnprepared: (...args: Parameters<typeof execute>) =>
            args[0].startsWith("BEGIN") && refused
              ? Effect.fail(failure)
              : execute(...args)
        })
      }))
      let entered = false
      const failed = yield* Effect.exit(writer.write(Effect.sync(() => {
        entered = true
      })))
      expect(entered).toBe(false)
      expect(Exit.isFailure(failed)).toBe(true)
      if (!Exit.isFailure(failed)) return
      expect(Result.isFailure(Cause.findDefect(failed.cause))).toBe(true)
      expect(Result.getOrUndefined(Cause.findError(failed.cause))).toMatchObject({ code: "io", cause: failure })
      refused = false
      // A refused BEGIN releases the real connection for the next transaction.
      yield* writer.write(sql`CREATE TABLE usable_after_begin_failure (id INTEGER)`)
      yield* writer.write(sql`INSERT INTO usable_after_begin_failure VALUES (1)`)
      expect(yield* sql`SELECT * FROM usable_after_begin_failure`).toEqual([{ id: 1 }])
    }).pipe(Effect.provide(NodeDatabase.layer({ filename: ":memory:" }))))

  it.effect("preserves intentional SqlError defects in the write body", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const defect = new SqlError.SqlError({ reason: new SqlError.UnknownError({ cause: "body defect" }) })
      const exit = yield* Effect.exit(DurableWriter.make(sql).write(Effect.die(defect)))
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      expect(Result.getOrUndefined(Cause.findDefect(exit.cause))).toBe(defect)
      expect(Result.isFailure(Cause.findError(exit.cause))).toBe(true)
    }).pipe(Effect.provide(NodeDatabase.layer({ filename: ":memory:" }))))

  it.effect("removes SqlError from the typed channel and preserves application failures", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writer = DurableWriter.make(sql)
      const sqlError = new SqlError.SqlError({
        reason: SqlError.classifySqliteError(Object.assign(new Error("constraint"), { code: "SQLITE_CONSTRAINT" }))
      })
      const applicationError = { _tag: "ApplicationError" } as const
      const body: Effect.Effect<number, SqlError.SqlError | typeof applicationError> = Effect.fail(sqlError)
      const written = writer.write(body)
      expectTypeOf<Effect.Error<typeof written>>()
        .toEqualTypeOf<DurableWriter.DatabaseError | typeof applicationError>()
      expect(yield* Effect.flip(written)).toBeInstanceOf(DurableWriter.DatabaseError)
      expect(yield* Effect.flip(writer.write(Effect.fail(applicationError)))).toBe(applicationError)
    }).pipe(Effect.provide(NodeDatabase.layer({ filename: ":memory:" }))))
})
