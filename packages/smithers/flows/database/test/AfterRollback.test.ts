import { describe, expect, it } from "@effect/vitest"
import { Context, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as SqlError from "effect/sql/SqlError"
import { TestClock } from "effect/testing"
import * as DurableWriter from "../src/DurableWriter.ts"
import * as NodeDatabase from "../src/node/NodeDatabase.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"

const busy = new SqlError.SqlError({
  reason: SqlError.classifySqliteError(Object.assign(new Error("busy"), { code: "SQLITE_BUSY" }))
})

// Process-local state beside the database: each change registers the undo
// that restores the value it replaced, as an in-memory lease does.
const cell = () => {
  const state = { value: "initial", undone: [] as Array<string> }
  const set = (value: string, client?: SqlClient.SqlClient) =>
    Effect.suspend(() => {
      const previous = state.value
      state.value = value
      return DurableWriter.afterRollback(
        Effect.sync(() => {
          state.undone.push(value)
          state.value = previous
        }),
        client
      )
    })
  return { state, set }
}

describe("DurableWriter.afterRollback", () => {
  it.effect("restores state when the body fails, newest change first, and drops undos on commit", () =>
    Effect.gen(function*() {
      const writer = yield* DurableWriter.DurableWriter
      const { set, state } = cell()
      const failed = yield* Effect.exit(writer.write(Effect.gen(function*() {
        expect(yield* set("first")).toBe(true)
        expect(yield* set("second")).toBe(true)
        return yield* Effect.fail("rollback")
      })))
      expect(Exit.isFailure(failed)).toBe(true)
      expect(state).toEqual({ value: "initial", undone: ["second", "first"] })
      yield* writer.write(set("committed"))
      expect(state).toEqual({ value: "committed", undone: ["second", "first"] })
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("undoes only a caught savepoint, and a released savepoint with its parent", () =>
    Effect.gen(function*() {
      const writer = yield* DurableWriter.DurableWriter
      const { set, state } = cell()
      yield* writer.write(Effect.gen(function*() {
        yield* set("parent")
        const caught = yield* Effect.exit(writer.write(Effect.gen(function*() {
          yield* set("savepoint")
          yield* writer.write(set("grandchild"))
          return yield* Effect.fail("reject")
        })))
        expect(Exit.isFailure(caught)).toBe(true)
        expect(state).toEqual({ value: "parent", undone: ["grandchild", "savepoint"] })
      }))
      expect(state.value).toBe("parent")

      state.undone.length = 0
      yield* Effect.exit(writer.write(Effect.gen(function*() {
        yield* writer.write(set("released"))
        yield* set("outer")
        return yield* Effect.fail("outer rollback")
      })))
      expect(state).toEqual({ value: "parent", undone: ["outer", "released"] })
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("undoes a retried attempt before the writer replays the body", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writer = DurableWriter.make(sql, { baseDelayMs: 1, maxDelayMs: 1 })
      const { set, state } = cell()
      const seen: Array<string> = []
      let attempts = 0
      const fiber = yield* writer.write(Effect.gen(function*() {
        const attempt = ++attempts
        // Each replay starts from the state before the write, never from the
        // failed attempt's change.
        seen.push(state.value)
        yield* set(`attempt ${attempt}`)
        if (attempt < 3) return yield* Effect.fail(busy)
      })).pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestDatabase.until(TestClock.adjust("1 second").pipe(Effect.map(() => fiber.pollUnsafe() !== undefined)))
      yield* Fiber.join(fiber)
      expect(seen).toEqual(["initial", "initial", "initial"])
      expect(state).toEqual({ value: "attempt 3", undone: ["attempt 1", "attempt 2"] })
    }).pipe(Effect.provide(TestDatabase.layer), Effect.provide(TestClock.layer())))

  it.effect("undoes a body whose COMMIT the database rejects", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writer = DurableWriter.make(sql)
      const { set, state } = cell()
      yield* sql`PRAGMA foreign_keys = ON`
      yield* sql`CREATE TABLE parent (id INTEGER PRIMARY KEY)`
      yield* sql`CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)`
      const failed = yield* Effect.exit(writer.write(Effect.gen(function*() {
        yield* sql`INSERT INTO child VALUES (999)`
        yield* set("uncommitted", sql)
      })))
      expect(Exit.isFailure(failed)).toBe(true)
      expect(state).toEqual({ value: "initial", undone: ["uncommitted"] })
    }).pipe(Effect.provide(NodeDatabase.layer({ filename: ":memory:" }))))

  it.effect("undoes an interrupted write", () =>
    Effect.gen(function*() {
      const writer = yield* DurableWriter.DurableWriter
      const { set, state } = cell()
      const ready = yield* Deferred.make<void>()
      const fiber = yield* writer.write(Effect.gen(function*() {
        yield* set("interrupted")
        yield* Deferred.succeed(ready, undefined)
        return yield* Effect.never
      })).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(ready)
      yield* Fiber.interrupt(fiber)
      expect(state).toEqual({ value: "initial", undone: ["interrupted"] })
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("keeps a committed write's changes when an interruption lands during COMMIT", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writer = DurableWriter.make(sql)
      const { set, state } = cell()
      const committing = yield* Deferred.make<void>()
      const resume = yield* Deferred.make<void>()
      // COMMIT waits for the test, so the interruption arrives while it runs.
      yield* Effect.scoped(Effect.map(sql.reserve, (conn) => {
        const execute = conn.executeUnprepared.bind(conn)
        Object.assign(conn, {
          executeUnprepared: (...args: Parameters<typeof execute>) =>
            args[0] === "COMMIT"
              ? Deferred.succeed(committing, undefined).pipe(
                Effect.andThen(Deferred.await(resume)),
                Effect.andThen(execute(...args))
              )
              : execute(...args)
        })
      }))
      const fiber = yield* writer.write(set("committed", sql)).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(committing)
      const interruption = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.succeed(resume, undefined)
      yield* Fiber.join(interruption)
      expect(state).toEqual({ value: "committed", undone: [] })
    }).pipe(Effect.provide(NodeDatabase.layer({ filename: ":memory:" }))))

  it.effect("hands a savepoint interrupted during its release to the parent that commits", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writer = DurableWriter.make(sql)
      const { set, state } = cell()
      let releasing = yield* Deferred.make<void>()
      let resume = yield* Deferred.make<void>()
      // The release waits for the test, so the interruption arrives while it runs.
      yield* Effect.scoped(Effect.map(sql.reserve, (conn) => {
        const execute = conn.executeUnprepared.bind(conn)
        Object.assign(conn, {
          executeUnprepared: (...args: Parameters<typeof execute>) =>
            String(args[0]).startsWith("RELEASE")
              ? Deferred.succeed(releasing, undefined).pipe(
                Effect.andThen(Deferred.await(resume)),
                Effect.andThen(execute(...args))
              )
              : execute(...args)
        })
      }))
      yield* writer.write(Effect.gen(function*() {
        yield* set("parent", sql)
        const savepoint = yield* writer.write(set("savepoint", sql)).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(releasing)
        const interruption = yield* Fiber.interrupt(savepoint).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.succeed(resume, undefined)
        yield* Fiber.join(interruption)
        expect(state).toEqual({ value: "savepoint", undone: [] })
      }))
      expect(state).toEqual({ value: "savepoint", undone: [] })

      // The parent that rolls back undoes the released savepoint with its own change.
      yield* Effect.exit(writer.write(Effect.gen(function*() {
        yield* set("rolled back parent", sql)
        const savepoint = yield* writer.write(set("rolled back savepoint", sql)).pipe(
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(releasing)
        yield* Fiber.interrupt(savepoint)
        return yield* Effect.fail("rollback")
      })))
      expect(state.value).toBe("savepoint")

      // A write nested in a raw transaction registered nothing to hand on.
      state.undone.length = 0
      releasing = yield* Deferred.make<void>()
      resume = yield* Deferred.make<void>()
      yield* sql.withTransaction(Effect.gen(function*() {
        const savepoint = yield* writer.write(set("unowned", sql)).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(releasing)
        const interruption = yield* Fiber.interrupt(savepoint).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.succeed(resume, undefined)
        yield* Fiber.join(interruption)
      }))
      expect(state).toEqual({ value: "unowned", undone: [] })
    }).pipe(Effect.provide(NodeDatabase.layer({ filename: ":memory:" }))))

  it.effect("runs every undo when one dies, and reports the defect with the failure", () =>
    Effect.gen(function*() {
      const writer = yield* DurableWriter.DurableWriter
      const { set, state } = cell()
      const failed = yield* Effect.exit(writer.write(Effect.gen(function*() {
        yield* set("kept order")
        yield* DurableWriter.afterRollback(Effect.die("undo defect"))
        return yield* Effect.fail("rollback")
      })))
      expect(state).toEqual({ value: "initial", undone: ["kept order"] })
      expect(String(failed)).toContain("undo defect")
      expect(String(failed)).toContain("rollback")
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("registers nothing outside an owned transaction or for another database", () =>
    Effect.gen(function*() {
      const writer = yield* DurableWriter.DurableWriter
      const sql = yield* SqlClient.SqlClient
      const other = yield* Layer.build(Layer.fresh(TestDatabase.layer))
      const otherWriter = Context.get(other, DurableWriter.DurableWriter)
      const { set, state } = cell()
      expect(yield* set("outside")).toBe(false)
      expect(yield* sql.withTransaction(set("raw transaction"))).toBe(false)
      yield* Effect.exit(writer.write(Effect.gen(function*() {
        expect(yield* sql.withTransaction(set("raw savepoint"))).toBe(false)
        yield* otherWriter.write(Effect.gen(function*() {
          expect(yield* set("wrong owner", sql)).toBe(false)
        }))
        return yield* Effect.fail("rollback")
      })))
      // Unregistered changes stand through the rollback.
      expect(state).toEqual({ value: "wrong owner", undone: [] })
    }).pipe(Effect.scoped, Effect.provide(TestDatabase.layer)))
})
