import * as TestSchemas from "../src/TestSchemas.ts"
/**
 * Partitioned writer locks on PostgreSQL (docs/decisions/0001-run-writer-locks.md):
 * writes to one partition commit one at a time, writes to two commit
 * concurrently, and a write that names no partition commits alone. A nested
 * write takes whatever lock its transaction lacks. The cases run on
 * `SMITHERS_TEST_PG_URL` and through PgBouncer in transaction
 * pooling, as `PostgresPooling.test.ts` does, and skip where nothing listens.
 */
import * as Pg from "@effect/sql-pg"
import { describe, expect, it } from "@effect/vitest"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Metric } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import * as SqlError from "effect/sql/SqlError"
import { DatabaseMetrics, DurableWriter, Migrations, PostgresDatabase } from "../src/index.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"
import { absence, pgbouncer, postgres } from "./harness/listening.ts"

const endpoints = [postgres(), pgbouncer()]

for (const endpoint of endpoints) {
  const url = endpoint.url
  const absent = await absence(endpoint)

  describe(endpoint.name, () => {
    if (url === undefined || absent !== undefined) {
      it.skip(`skipped: ${absent}`, () => {})
      return
    }

    const schema = () => TestSchemas.schemaName("partitions")
    /** A client for `name` with its own pool, whose schema is dropped when the test's scope closes. */
    const client = (name: string) =>
      Effect.gen(function*() {
        const sql = Context.get(
          yield* Layer.build(PostgresDatabase.layer({ url, driver: Pg, schema: name })),
          SqlClient
        )
        yield* Effect.addFinalizer(() => TestDatabase.dropSchema(sql, name).pipe(Effect.orDie))
        return sql
      })
    it.live("falls back to the migration pass when the lock-free ledger probe fails", () =>
      Effect.gen(function*() {
        const sql = yield* client(schema())
        let probes = 0
        const faulty = new Proxy(sql, {
          apply(target, receiver, args) {
            if (probes === 0 && String(args[0]).includes("to_regclass")) {
              probes += 1
              return Effect.fail(
                new SqlError.SqlError({
                  reason: SqlError.classifySqliteError(Object.assign(new Error("SQLITE_BUSY"), { code: "SQLITE_BUSY" }))
                })
              )
            }
            return Reflect.apply(target, receiver, args)
          }
        })
        const sets = [{
          namespace: "probe",
          idOffset: 0,
          migrations: {
            "0001_initial": sql`CREATE TABLE probe_receipt (id INTEGER PRIMARY KEY)`
          }
        }]
        const applied = yield* Migrations.run(sets).pipe(Effect.provideService(SqlClient, faulty))
        expect(probes).toBe(1)
        expect(applied).toEqual([[1, "probe_initial"]])
        yield* sql`INSERT INTO probe_receipt (id) VALUES (1)`
        expect(yield* sql`SELECT id FROM probe_receipt`).toEqual([{ id: 1 }])
        expect(yield* Migrations.run(sets).pipe(Effect.provideService(SqlClient, sql))).toEqual([])
      }))

    /** Whether some request for `name`'s schema lock, or for its `partition`'s lock, is waiting. */
    const waiting = (sql: SqlClient, name: string, partition?: string) =>
      Effect.map(
        partition === undefined
          ? sql<{ readonly waiting: boolean }>`SELECT EXISTS (SELECT 1 FROM pg_locks
              WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
                AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${name}, 2099)) AS waiting`
          : sql<{ readonly waiting: boolean }>`SELECT EXISTS (SELECT 1 FROM pg_locks
              WHERE locktype = 'advisory' AND NOT granted AND objsubid = 2
                AND classid::bigint = (hashtext(${name})::bigint & 4294967295)
                AND objid::bigint = (hashtext(${partition})::bigint & 4294967295)) AS waiting`,
        ([row]) => row!.waiting
      )
    /**
     * Holds a write open on `sql` until the returned `release` runs: the write
     * names `partition`, or none. `opened` completes once it holds its locks.
     */
    const hold = (sql: SqlClient, partition: string | undefined, body: Effect.Effect<unknown, unknown> = Effect.void) =>
      Effect.gen(function*() {
        const opened = yield* Deferred.make<void>()
        const released = yield* Deferred.make<void>()
        const fiber = yield* DurableWriter.make(sql).write(
          Effect.andThen(body, Effect.andThen(Deferred.succeed(opened, undefined), Deferred.await(released))),
          { partition }
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(opened)
        return { fiber, release: Deferred.succeed(released, undefined).pipe(Effect.andThen(Fiber.join(fiber))) }
      })
    /** A one-row write on its own client: a separate process's writer. */
    const write = (sql: SqlClient, partition: string | undefined) =>
      DurableWriter.make(sql).write(sql`INSERT INTO rows (partition) VALUES (${partition ?? "none"})`, { partition })

    it.live("commits writes to two partitions concurrently and writes to one partition in turn", () =>
      Effect.gen(function*() {
        const name = schema()
        const [first, second, third] = [yield* client(name), yield* client(name), yield* client(name)]
        yield* first`CREATE TABLE rows (partition TEXT NOT NULL)`
        const held = yield* hold(first, "run-a")
        // Another partition commits while run-a's writer holds its lock.
        yield* write(second, "run-b")
        // run-a's next writer waits for the one holding it.
        const queued = yield* write(third, "run-a").pipe(Effect.forkScoped)
        yield* TestDatabase.until(waiting(second, name, "run-a"))
        yield* held.release
        yield* Fiber.join(queued)
        expect(yield* second`SELECT partition FROM rows ORDER BY partition`).toEqual([
          { partition: "run-a" },
          { partition: "run-b" }
        ])
      }))

    it.live("holds a write that names no partition until every partition's writer commits, and the reverse", () =>
      Effect.gen(function*() {
        const name = schema()
        const [first, second] = [yield* client(name), yield* client(name)]
        yield* first`CREATE TABLE rows (partition TEXT NOT NULL)`
        // A partition's writer holds up a writer that names none...
        const partitioned = yield* hold(first, "run-a")
        const whole = yield* write(second, undefined).pipe(Effect.forkScoped)
        yield* TestDatabase.until(waiting(second, name))
        yield* partitioned.release
        yield* Fiber.join(whole)
        // ...and one that names none holds up every partition's, as a writer on
        // a release before partitions, which takes the schema's lock, does.
        const exclusive = yield* hold(first, undefined)
        const queued = yield* write(second, "run-b").pipe(Effect.forkScoped)
        yield* TestDatabase.until(waiting(second, name))
        yield* exclusive.release
        yield* Fiber.join(queued)
        expect(yield* second`SELECT count(*)::int AS count FROM rows`).toEqual([{ count: 2 }])
      }))

    it.live("gives a nested write the lock its transaction lacks: another partition, or the whole schema", () =>
      Effect.gen(function*() {
        const name = schema()
        const [first, second] = [yield* client(name), yield* client(name)]
        yield* first`CREATE TABLE rows (partition TEXT NOT NULL)`
        const writer = DurableWriter.make(first)
        // run-a's transaction joins run-b through a nested write: run-b's
        // writers now wait for it, run-c's do not.
        const joined = yield* hold(first, "run-a", writer.write(first`SELECT 1`, { partition: "run-b" }))
        const blocked = yield* write(second, "run-b").pipe(Effect.forkScoped)
        yield* TestDatabase.until(waiting(second, name, "run-b"))
        yield* write(second, "run-c")
        yield* joined.release
        yield* Fiber.join(blocked)
        // A nested write that names no partition widens run-a's transaction to
        // the whole schema: run-c's writer waits for it.
        const widened = yield* hold(first, "run-a", writer.write(first`SELECT 1`))
        const held = yield* write(second, "run-c").pipe(Effect.forkScoped)
        yield* TestDatabase.until(waiting(second, name))
        yield* widened.release
        yield* Fiber.join(held)
        // A nested write to its own partition, or inside a schema-wide
        // transaction, takes nothing more.
        const [tally] = yield* DatabaseMetrics.tally(Effect.all([
          writer.write(writer.write(first`SELECT 1`, { partition: "run-a" }), { partition: "run-a" }),
          writer.write(writer.write(first`SELECT 1`, { partition: "run-a" }))
        ]))
        expect({ transactions: tally.transactions, schemaWide: tally.schemaWide }).toEqual({
          transactions: 2,
          schemaWide: 1
        })
      }))

    it.live("counts a transaction schema-wide once, though a rollback made it widen twice", () =>
      Effect.gen(function*() {
        const sql = yield* client(schema())
        const writer = DurableWriter.make(sql)
        const [tally] = yield* DatabaseMetrics.tally(writer.write(
          Effect.gen(function*() {
            // Widens inside a savepoint that rolls back, releasing the schema's lock...
            yield* Effect.exit(writer.write(
              Effect.andThen(writer.write(sql`SELECT 1`), Effect.fail("refused")),
              { partition: "run-b" }
            ))
            // ...so this widens again.
            yield* writer.write(sql`SELECT 1`)
          }),
          { partition: "run-a" }
        ))
        expect({ transactions: tally.transactions, schemaWide: tally.schemaWide }).toEqual({
          transactions: 1,
          schemaWide: 1
        })
      }))

    it.live("takes a partition's lock again after the savepoint that took it rolled back", () =>
      Effect.gen(function*() {
        const name = schema()
        const [first, second] = [yield* client(name), yield* client(name)]
        yield* first`CREATE TABLE rows (partition TEXT NOT NULL)`
        const writer = DurableWriter.make(first)
        const body = Effect.gen(function*() {
          // run-b's lock taken inside a savepoint that rolls back...
          const failed = yield* Effect.exit(writer.write(
            writer.write(Effect.andThen(first`SELECT 1`, Effect.fail("refused")), { partition: "run-b" }),
            { partition: "run-c" }
          ))
          expect(Exit.isFailure(failed)).toBe(true)
          // ...is taken again by the next nested write that names run-b.
          yield* writer.write(first`SELECT 1`, { partition: "run-b" })
        })
        const held = yield* hold(first, "run-a", body)
        const blocked = yield* write(second, "run-b").pipe(Effect.forkScoped)
        yield* TestDatabase.until(waiting(second, name, "run-b"))
        yield* held.release
        yield* Fiber.join(blocked)
      }))

    it.live("replays a write that deadlocked widening against another partition's", () =>
      Effect.gen(function*() {
        const name = schema()
        const [first, second] = [yield* client(name), yield* client(name)]
        yield* first`CREATE TABLE rows (partition TEXT NOT NULL)`
        const both = yield* Deferred.make<void>()
        let arrived = 0
        // Each holds its partition, shares the schema, then widens to the
        // schema: each waits for the other's shared lock, and the server
        // breaks the deadlock by failing one, which the writer replays.
        const widening = (sql: SqlClient, partition: string) => {
          const writer = DurableWriter.make(sql)
          return writer.write(
            Effect.gen(function*() {
              arrived += 1
              if (arrived >= 2) yield* Deferred.succeed(both, undefined)
              yield* Deferred.await(both)
              yield* writer.write(sql`INSERT INTO rows (partition) VALUES (${partition})`)
            }),
            { partition }
          )
        }
        const retries = Effect.map(Metric.value(DatabaseMetrics.writeRetries), (state) => state.count)
        const before = yield* retries
        yield* Effect.all([widening(first, "run-a"), widening(second, "run-b")], { concurrency: 2 })
        expect((yield* retries) - before).toBeGreaterThanOrEqual(1)
        expect(yield* first`SELECT partition FROM rows ORDER BY partition`).toEqual([
          { partition: "run-a" },
          { partition: "run-b" }
        ])
      }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())))

    it.live("migrates an installed schema without the schema's lock, and takes it to install", () =>
      Effect.gen(function*() {
        const name = schema()
        const sql = yield* client(name)
        const installed: Migrations.MigrationSet = {
          namespace: "partitions",
          idOffset: 0,
          migrations: { "0001_rows": Effect.asVoid(sql`CREATE TABLE rows (partition TEXT NOT NULL)`) }
        }
        const appended: Migrations.MigrationSet = {
          ...installed,
          migrations: {
            ...installed.migrations,
            "0002_more": Effect.asVoid(sql`CREATE TABLE more (partition TEXT NOT NULL)`)
          }
        }
        const run = (set: Migrations.MigrationSet) => Migrations.run([set]).pipe(Effect.provideService(SqlClient, sql))
        expect(yield* run(installed)).toEqual([[1, "partitions_rows"]])
        const exclusive = yield* hold(yield* client(name), undefined)
        // Every planned migration is in the ledger: nothing waits for the holder.
        expect(yield* run(installed)).toEqual([])
        // A pending one installs under the lock, after the holder commits.
        const pending = yield* run(appended).pipe(Effect.forkScoped)
        yield* TestDatabase.until(waiting(sql, name))
        yield* exclusive.release
        expect(yield* Fiber.join(pending)).toEqual([[2, "partitions_more"]])
        // A ledger that names a planned id differently runs the full pass, which refuses it.
        const renamed = { ...installed, migrations: { "0001_renamed": installed.migrations["0001_rows"]! } }
        expect((yield* Effect.flip(run(renamed))).message).toContain("was recorded as partitions_rows")
        // So does a ledger the full pass would refuse to read.
        yield* sql`INSERT INTO flows_migrations (migration_id, name) VALUES (-1, 'partitions_broken')`
        expect((yield* Effect.flip(run(installed))).message).toContain("contains an invalid migration_id: -1")
      }))

    it.live("migrates a fresh schema inside a caller's transaction", () =>
      Effect.gen(function*() {
        const sql = yield* client(schema())
        const set: Migrations.MigrationSet = {
          namespace: "partitions",
          idOffset: 0,
          migrations: { "0001_rows": Effect.asVoid(sql`CREATE TABLE rows (partition TEXT NOT NULL)`) }
        }
        // No ledger yet: a probe that read it would abort the caller's transaction.
        const applied = yield* sql.withTransaction(Migrations.run([set]).pipe(Effect.provideService(SqlClient, sql)))
        expect(applied).toEqual([[1, "partitions_rows"]])
      }))

    it.live("rolls back a read-only transaction's savepoint without a writer lock to forget", () =>
      Effect.gen(function*() {
        const name = schema()
        yield* client(name)
        const reader = Context.get(
          yield* Layer.build(PostgresDatabase.layer({ url, driver: Pg, schema: name, readOnly: true })),
          SqlClient
        )
        const outcome = yield* reader.withTransaction(
          Effect.andThen(
            Effect.exit(reader.withTransaction(Effect.andThen(reader`SELECT 1`, Effect.fail("refused")))),
            reader<{ readonly one: number }>`SELECT 1 AS one`
          )
        )
        expect(outcome).toEqual([{ one: 1 }])
      }))

    it.live("replays a write that deadlocked joining the partition another write holds", () =>
      Effect.gen(function*() {
        const name = schema()
        const [first, second] = [yield* client(name), yield* client(name)]
        yield* first`CREATE TABLE rows (partition TEXT NOT NULL)`
        const both = yield* Deferred.make<void>()
        let arrived = 0
        // Each holds its own partition and then joins the other's, in opposite orders.
        const crossing = (sql: SqlClient, own: string, other: string) => {
          const writer = DurableWriter.make(sql)
          return writer.write(
            Effect.gen(function*() {
              arrived += 1
              if (arrived >= 2) yield* Deferred.succeed(both, undefined)
              yield* Deferred.await(both)
              yield* writer.write(sql`INSERT INTO rows (partition) VALUES (${other})`, { partition: other })
            }),
            { partition: own }
          )
        }
        const retries = Effect.map(Metric.value(DatabaseMetrics.writeRetries), (state) => state.count)
        const before = yield* retries
        yield* Effect.all([crossing(first, "run-a", "run-b"), crossing(second, "run-b", "run-a")], {
          concurrency: 2
        })
        expect((yield* retries) - before).toBeGreaterThanOrEqual(1)
        expect(yield* first`SELECT partition FROM rows ORDER BY partition`).toEqual([
          { partition: "run-a" },
          { partition: "run-b" }
        ])
      }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())))

    it.live("opens a client on an existing schema without the schema's lock", () =>
      Effect.gen(function*() {
        const name = schema()
        const first = yield* client(name)
        const exclusive = yield* hold(first, undefined)
        // A second client on the schema builds while a writer holds its lock:
        // were it to wait for the lock, it would wait for the release below.
        const second = yield* client(name).pipe(Effect.timeout("30 seconds"))
        expect(yield* second`SELECT current_schema() AS schema`).toEqual([{ schema: name }])
        yield* exclusive.release
      }))
  })
}
