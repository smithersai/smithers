/**
 * Nested writes on PostgreSQL behave as savepoints do, with fewer of them on the wire
 * (src/postgres/PostgresDatabase.ts): consecutive savepoints share one, and a read-only body opens none.
 */
import * as Pg from "@effect/sql-pg"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import * as DurableWriter from "../src/DurableWriter.ts"
import * as PostgresDatabase from "../src/postgres/PostgresDatabase.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"
import * as TestSchemas from "../src/TestSchemas.ts"

const url = process.env.SMITHERS_TEST_PG_URL

const withWriter = <A, E>(body: (sql: SqlClient, writer: DurableWriter.Service) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const schema = TestSchemas.schemaName("sp")
    const built = yield* Layer.build(PostgresDatabase.layer({ url: url!, driver: Pg, schema }))
    const sql = Context.get(built, SqlClient)
    yield* Effect.addFinalizer(() => TestDatabase.dropSchema(sql, schema).pipe(Effect.orDie))
    yield* sql.withTransaction(sql.unsafe(`CREATE TABLE t (v TEXT)`))
    return yield* body(sql, DurableWriter.make(sql))
  })))

const rows = (sql: SqlClient) =>
  Effect.map(sql.unsafe<{ v: string }>(`SELECT v FROM t ORDER BY v`), (found) => found.map((row) => row.v))
const put = (sql: SqlClient, v: string) => sql.unsafe(`INSERT INTO t VALUES ('${v}')`)

describe.skipIf(!url)("nested writes on PostgreSQL", () => {
  it("a failure caught at any depth of consecutive nested writes undoes exactly what ran inside it", () =>
    withWriter((sql, writer) =>
      Effect.gen(function*() {
        yield* writer.write(Effect.gen(function*() {
          // Three savepoints in a row, with a statement only in the deepest.
          yield* writer.write(
            writer.write(writer.write(Effect.andThen(put(sql, "deepest"), Effect.fail("no" as const))))
          ).pipe(
            Effect.catch(() => Effect.void)
          )
          yield* put(sql, "after-first")
          // A statement between them: the inner failure keeps the outer's.
          yield* writer.write(Effect.gen(function*() {
            yield* put(sql, "outer")
            yield* writer.write(Effect.andThen(put(sql, "inner"), Effect.fail("no" as const))).pipe(
              Effect.catch(() => Effect.void)
            )
          }))
          // A failure at the middle of a consecutive run rolls back past the deepest's success.
          yield* writer.write(writer.write(put(sql, "deep-ok")).pipe(Effect.andThen(Effect.fail("no" as const)))).pipe(
            Effect.catch(() => Effect.void)
          )
          // Rolled back to the same point twice: the savepoint survives.
          for (const v of ["again-1", "again-2"]) {
            yield* writer.write(Effect.andThen(put(sql, v), Effect.fail("no" as const))).pipe(
              Effect.catch(() => Effect.void)
            )
          }
          yield* put(sql, "last")
        }))
        expect(yield* rows(sql)).toEqual(["after-first", "last", "outer"])
      })
    ))

  it("a failed write's rollback isn't moved by an empty nested write inside it (Astra, P1)", () =>
    withWriter((sql, writer) =>
      Effect.gen(function*() {
        yield* writer.write(Effect.gen(function*() {
          // Leaves a real savepoint at depth 2, with nothing after it.
          yield* writer.write(Effect.andThen(put(sql, "first"), writer.write(Effect.void)))
          // Shares that savepoint, writes, and opens another at depth 2.
          yield* writer.write(Effect.gen(function*() {
            yield* put(sql, "undone")
            yield* writer.write(Effect.void)
            return yield* Effect.fail("no" as const)
          })).pipe(Effect.catch(() => Effect.void))
        }))
        expect(yield* rows(sql)).toEqual(["first"])
      })
    ))

  it("a statement built before a savepoint and run after it counts as after it (Astra, P2)", () =>
    withWriter((sql, writer) =>
      Effect.gen(function*() {
        yield* writer.write(Effect.gen(function*() {
          const [connection] = Option.getOrThrow(yield* Effect.serviceOption(sql.transactionService))
          const insert = connection.executeUnprepared(`INSERT INTO t VALUES ('kept')`, [], undefined)
          yield* writer.write(Effect.void)
          yield* insert
          yield* writer.write(Effect.fail("no" as const)).pipe(Effect.catch(() => Effect.void))
        }))
        expect(yield* rows(sql)).toEqual(["kept"])
      })
    ))

  it("a statement that starts while a savepoint is on the wire counts as after it (Astra, round 2)", () =>
    withWriter((sql, writer) =>
      Effect.gen(function*() {
        yield* writer.write(Effect.gen(function*() {
          yield* put(sql, "first")
          // The empty write's SAVEPOINT is awaiting its answer when the INSERT starts on the same connection.
          yield* Effect.all([writer.write(Effect.void), put(sql, "concurrent")], { concurrency: 2 })
          yield* writer.write(Effect.fail("no" as const)).pipe(Effect.catch(() => Effect.void))
        }))
        expect(yield* rows(sql)).toEqual(["concurrent", "first"])
      })
    ))

  it("a read-only nested write that fails leaves the transaction whole, and its writes commit", () =>
    withWriter((sql, writer) =>
      Effect.gen(function*() {
        yield* writer.write(
          Effect.gen(function*() {
            yield* put(sql, "before")
            const read = writer.write(Effect.andThen(sql.unsafe(`SELECT v FROM t`), Effect.fail("fence" as const)), {
              readOnly: true,
              partition: "run-a"
            })
            expect((yield* Effect.result(read))._tag).toBe("Failure")
            yield* put(sql, "after")
          }),
          { partition: "run-a" }
        )
        expect(yield* rows(sql)).toEqual(["after", "before"])
      })
    ))

  it("a failure outside a read-only nested write still rolls back what ran before it", () =>
    withWriter((sql, writer) =>
      Effect.gen(function*() {
        yield* writer.write(Effect.gen(function*() {
          yield* writer.write(Effect.gen(function*() {
            yield* put(sql, "undone")
            yield* writer.write(sql.unsafe(`SELECT v FROM t`), { readOnly: true })
            return yield* Effect.fail("no" as const)
          }))
        })).pipe(Effect.catch(() => Effect.void))
        expect(yield* rows(sql)).toEqual([])
      })
    ))
})
