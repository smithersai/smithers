import * as TestSchemas from "../src/TestSchemas.ts"
/**
 * `PostgresDatabase` behind a transaction-pooling proxy, and on a direct
 * connection, through one suite.
 *
 * PgBouncer with `pool_mode=transaction` (the `pgbouncer` service in
 * `apps/mvp/docker-compose.yml`, on 127.0.0.1:54322 over the compose Postgres)
 * stands in for Cloudflare Hyperdrive: it runs each transaction on whichever of
 * its four server connections is free and resets that connection when the
 * transaction ends, so a session setting made outside a transaction is lost. The
 * same cases run directly against `SMITHERS_TEST_PG_URL`, the server the
 * storage matrix provides. Each endpoint skips, and says why, only when nothing
 * listens there.
 */
import * as Pg from "@effect/sql-pg"
import { describe, expect, it } from "@effect/vitest"
import { Clock, Context, Deferred, Duration, Effect, Exit, Fiber, Layer, Logger, Metric, Stream } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { randomUUID } from "node:crypto"
import { DatabaseMetrics, DurableWriter, PostgresDatabase } from "../src/index.ts"
import * as SlowNetwork from "../src/test/SlowNetwork.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"
import { listening, pgbouncerUrl } from "./harness/listening.ts"

const endpoints = [
  { name: "PostgreSQL", url: process.env.SMITHERS_TEST_PG_URL, start: "`pnpm coverage` provides a server" },
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

  describe(endpoint.name, () => {
    if (url === undefined || absent !== undefined) {
      it.skip(`skipped: ${absent}`, () => {})
      return
    }

    const schema = () => TestSchemas.schemaName("pooling")
    /** A client for `name`, with its own pool, whose schema is dropped when the test's scope closes. */
    const client = (
      name: string,
      options?: {
        readonly readOnly?: boolean
        readonly applicationName?: string
        readonly maxConnections?: number
        readonly writerLockTimeout?: Duration.Input
        readonly acquireWarning?: Duration.Input
      }
    ) =>
      Effect.gen(function*() {
        const sql = Context.get(
          yield* Layer.build(PostgresDatabase.layer({
            url,
            driver: Pg,
            schema: name,
            readOnly: options?.readOnly,
            writerLockTimeout: options?.writerLockTimeout,
            acquireWarning: options?.acquireWarning,
            postgres: { applicationName: options?.applicationName, maxConnections: options?.maxConnections }
          })),
          SqlClient
        )
        if (options?.readOnly !== true) {
          yield* Effect.addFinalizer(() => TestDatabase.dropSchema(sql, name).pipe(Effect.orDie))
        }
        return sql
      })
    const schemaOf = (sql: SqlClient) =>
      Effect.map(sql<{ readonly schema: string }>`SELECT current_schema() AS schema`, ([row]) => row!.schema)

    it.live("gives concurrent fibers on two schemas only their own schema", () =>
      Effect.gen(function*() {
        const [first, second] = [schema(), schema()]
        const clients = [[yield* client(first), first], [yield* client(second), second]] as const
        // Lone statements, transactions, writes and savepoints, each checking
        // the schema it runs in.
        const observed = yield* Effect.all(
          Array.from({ length: 400 }, (_, index) => {
            const [sql, expected] = clients[index % 2]!
            const writer = DurableWriter.make(sql)
            const read = schemaOf(sql)
            const forms: ReadonlyArray<Effect.Effect<string, unknown>> = [
              read,
              sql.withTransaction(read),
              writer.write(read),
              writer.write(writer.write(read))
            ]
            const via = forms[Math.floor(index / 2) % forms.length]!
            return Effect.map(via, (actual) => actual === expected ? undefined : `${expected} read ${actual}`)
          }),
          { concurrency: 32 }
        )
        expect(observed.filter((entry) => entry !== undefined)).toEqual([])
      }))

    it.live("keeps a write whose nested write failed, and only the savepoint rolls back", () =>
      Effect.gen(function*() {
        const name = schema()
        const sql = yield* client(name)
        const other = yield* client(name)
        const writer = DurableWriter.make(sql)
        yield* sql`CREATE TABLE receipts (id INTEGER PRIMARY KEY)`
        const nested = yield* writer.write(Effect.gen(function*() {
          yield* sql`INSERT INTO receipts VALUES (1)`
          const failed = yield* Effect.exit(writer.write(Effect.andThen(
            sql`INSERT INTO receipts VALUES (2)`,
            sql`INSERT INTO receipts VALUES (1)`
          )))
          yield* writer.write(sql`INSERT INTO receipts VALUES (3)`)
          return failed
        }))
        expect(Exit.isFailure(nested)).toBe(true)
        expect(yield* other`SELECT id FROM ${other(name)}.receipts ORDER BY id`).toEqual([{ id: 1 }, { id: 3 }])
      }))

    it.live("rolls back a failed write, a failed statement and a COMMIT the server refused", () =>
      Effect.gen(function*() {
        const name = schema()
        const sql = yield* client(name)
        const writer = DurableWriter.make(sql)
        yield* sql`CREATE TABLE receipts (id INTEGER PRIMARY KEY)`
        yield* sql`INSERT INTO receipts VALUES (1)`
        const failedWrite = yield* Effect.exit(writer.write(Effect.andThen(
          sql`INSERT INTO receipts VALUES (2)`,
          Effect.fail("refused")
        )))
        const failedStatement = yield* Effect.exit(sql`INSERT INTO receipts VALUES (1)`)
        // A caught failure aborts the transaction, and PostgreSQL then answers
        // COMMIT with ROLLBACK instead of an error.
        const aborted = yield* Effect.flip(sql.withTransaction(Effect.gen(function*() {
          yield* sql`INSERT INTO receipts VALUES (3)`
          yield* Effect.exit(sql`SELECT 1 / 0`)
        })))
        expect([Exit.isFailure(failedWrite), Exit.isFailure(failedStatement)]).toEqual([true, true])
        expect(aborted.reason.message).toBe("PostgresDatabase: COMMIT rolled back an aborted transaction")
        expect(yield* sql`SELECT id FROM ${sql(name)}.receipts ORDER BY id`).toEqual([{ id: 1 }])
      }))

    it.live("interleaves writers on two pools of one schema with a writer on another", () =>
      Effect.gen(function*() {
        const [shared, other] = [schema(), schema()]
        const first = yield* client(shared)
        const second = yield* client(shared)
        const elsewhere = yield* client(other)
        for (const sql of [first, elsewhere]) {
          yield* sql`CREATE TABLE counter (value INTEGER NOT NULL)`
          yield* sql`INSERT INTO counter VALUES (0)`
        }
        const increment = (sql: SqlClient) =>
          DurableWriter.make(sql).write(Effect.gen(function*() {
            const [row] = yield* sql<{ readonly value: number }>`SELECT value FROM counter`
            yield* sql`UPDATE counter SET value = ${row!.value + 1}`
          }))
        yield* Effect.all(
          Array.from({ length: 60 }, (_, index) => increment([first, second, elsewhere][index % 3]!)),
          { concurrency: 60 }
        )
        expect(yield* second`SELECT value FROM ${second(shared)}.counter`).toEqual([{ value: 40 }])
        expect(yield* elsewhere`SELECT value FROM ${elsewhere(other)}.counter`).toEqual([{ value: 20 }])
      }))

    it.live("times each write transaction's wait for the schema's writer lock", () =>
      Effect.gen(function*() {
        const name = schema()
        const holder = yield* client(name)
        const waiter = yield* client(name)
        const reader = yield* client(name, { readOnly: true })
        const waits = Metric.value(DatabaseMetrics.writerLockWait)
        const before = yield* waits
        const waiting = holder<{ readonly waiting: boolean }>`SELECT EXISTS (SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
            AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${name}, 2099)) AS waiting`
        const { blocked, held } = yield* holder.withTransaction(Effect.gen(function*() {
          const blocked = yield* DurableWriter.make(waiter).write(waiter`SELECT 1`).pipe(Effect.forkScoped)
          yield* TestDatabase.until(Effect.map(waiting, ([row]) => row!.waiting))
          const observed = yield* Clock.currentTimeMillis
          expect(yield* waiting).toEqual([{ waiting: true }])
          return { blocked, held: (yield* Clock.currentTimeMillis) - observed }
        }))
        yield* Fiber.join(blocked)
        // Neither a read-only transaction nor a lone statement takes the lock.
        yield* reader.withTransaction(reader`SELECT 1`)
        yield* holder`SELECT 1`
        const after = yield* waits
        expect(after.count - before.count).toBe(2)
        expect(after.max).toBeGreaterThanOrEqual(held)
      }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())))

    // Writers queued on the writer lock each held one of Hyperdrive's server
    // connections while they waited, so a queue as long as its pool held them
    // all, and Hyperdrive closed every other client after 15 seconds without
    // one: production alarms failed with `Connection closed` (2026-10-22).
    // PgBouncer's four server connections stand in for that pool here.
    it.live("lets its server connection go while a write waits out a held writer lock", () =>
      Effect.gen(function*() {
        const name = schema()
        const holder = yield* client(name)
        yield* holder`CREATE TABLE receipts (id INTEGER PRIMARY KEY)`
        const writers = yield* Effect.forEach(
          Array.from({ length: 6 }, (_, index) => index),
          () => client(name, { maxConnections: 1, writerLockTimeout: "100 millis" })
        )
        const reader = yield* client(schema())
        const timeouts = Metric.value(DatabaseMetrics.writerLockTimeouts)
        const before = (yield* timeouts).count
        const release = yield* Deferred.make<void>()
        const held = yield* Deferred.make<void>()
        const holding = yield* holder.withTransaction(
          Effect.andThen(Deferred.succeed(held, undefined), Deferred.await(release))
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(held)
        const writes = yield* Effect.forEach(
          writers,
          (sql, index) => DurableWriter.make(sql).write(sql`INSERT INTO receipts VALUES (${index})`),
          { concurrency: "unbounded" }
        ).pipe(Effect.forkScoped)
        // The writers queue on the lock: through PgBouncer, more of them than
        // it has server connections left.
        yield* Effect.sleep("300 millis")
        // A client that needs no lock still gets a server connection while the
        // lock stays held.
        const read = yield* Effect.timeoutOption(reader`SELECT 1 AS one`, "2 seconds")
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(holding)
        yield* Fiber.join(writes)
        expect(read._tag === "Some" ? read.value : "starved").toEqual([{ one: 1 }])
        expect(yield* holder`SELECT id FROM receipts ORDER BY id`).toEqual(
          writers.map((_, index) => ({ id: index }))
        )
        expect((yield* timeouts).count - before).toBeGreaterThanOrEqual(writers.length)
      }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())))

    for (const partition of [undefined, "run-a"]) {
      it.live(`bounds a ${partition === undefined ? "schema" : "partition"} write's wait and counts the waits that ran out`, () =>
        Effect.gen(function*() {
          const name = schema()
          const holder = yield* client(name)
          const waiter = yield* client(name, { writerLockTimeout: "50 millis" })
          const timeouts = Metric.value(DatabaseMetrics.writerLockTimeouts)
          const waits = Metric.value(DatabaseMetrics.writerLockWait)
          const timeoutsBefore = (yield* timeouts).count
          const waitsBefore = yield* waits
          // `lock_timeout` stays at the client's limit for the rest of the write.
          const setting = waiter<{ readonly timeout: string }>`SELECT current_setting('lock_timeout') AS timeout`
          const { inside } = yield* holder.withTransaction(Effect.gen(function*() {
            const inside = yield* DurableWriter.make(waiter).write(setting, { partition }).pipe(Effect.forkScoped)
            yield* TestDatabase.until(Effect.map(timeouts, (counter) => counter.count - timeoutsBefore >= 3))
            return { inside }
          }))
          expect(yield* Fiber.join(inside)).toEqual([{ timeout: "50ms" }])
          // A lone statement takes no lock and keeps the server's own limit.
          expect(yield* setting).toEqual([{ timeout: "0" }])
          // An infinite limit waits as long as the lock is held.
          const unbounded = yield* client(name, { writerLockTimeout: Duration.infinity })
          expect(
            yield* unbounded.withTransaction(
              unbounded<{ readonly timeout: string }>`SELECT current_setting('lock_timeout') AS timeout`
            )
          ).toEqual([{ timeout: "0" }])
          const after = yield* waits
          // The holder, waiter and unbounded writes. An existing schema check takes no writer lock.
          expect(after.count - waitsBefore.count).toBe(3)
          expect(after.max).toBeGreaterThanOrEqual(150)
        }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())))
    }

    // A step that waited on a pool logged nothing for 26 seconds on a loaded
    // stack (2026-10-22).
    it.live("warns while a wait for a pooled connection runs long, then takes the connection, and times every wait", () =>
      Effect.gen(function*() {
        const name = schema()
        const sql = yield* client(name, { maxConnections: 1, acquireWarning: "200 millis" })
        const waits = Metric.value(DatabaseMetrics.connectionWait)
        const before = yield* waits
        const warnings: Array<unknown> = []
        const logger = Logger.make((options) => {
          if (JSON.stringify(options.message).includes("postgres.connection.waiting")) warnings.push(options.message)
        })
        const release = yield* Deferred.make<void>()
        const held = yield* Deferred.make<void>()
        // The pool's one connection is held by a transaction until released.
        const holding = yield* sql.withTransaction(
          Effect.andThen(Deferred.succeed(held, undefined), Deferred.await(release))
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(held)
        const waiting = yield* sql<{ readonly one: number }>`SELECT 1 AS one`.pipe(
          Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
          Effect.forkScoped
        )
        yield* Effect.sleep("500 millis")
        expect(warnings).toHaveLength(1)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(holding)
        expect(yield* Fiber.join(waiting)).toEqual([{ one: 1 }])
        // A wait that ends before the warning logs nothing.
        yield* sql`SELECT 1`.pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])))
        expect(warnings).toHaveLength(1)
        const after = yield* waits
        expect(after.count - before.count).toBe(3)
        expect(after.max).toBeGreaterThanOrEqual(400)
      }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())))

    it.live("counts a connection that would not open and a login the server refused", () =>
      Effect.gen(function*() {
        const closed = new URL(url)
        closed.port = "1"
        const refused = new URL(url)
        refused.password = "not-the-password"
        const failures = Metric.value(DatabaseMetrics.loginFailures)
        for (const target of [closed, refused]) {
          const before = (yield* failures).count
          const built = yield* Effect.exit(Layer.build(PostgresDatabase.layer({
            url: target.toString(),
            driver: Pg,
            schema: schema()
          })))
          expect(Exit.isFailure(built)).toBe(true)
          expect((yield* failures).count - before).toBe(1)
        }
      }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())))

    it.live("tallies one effect's write transactions and their summed wait for the writer lock", () =>
      Effect.gen(function*() {
        const name = schema()
        const holder = yield* client(name)
        const waiter = yield* client(name)
        const reader = yield* client(name, { readOnly: true })
        const writer = DurableWriter.make(waiter)
        const waiting = holder<{ readonly waiting: boolean }>`SELECT EXISTS (SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
            AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${name}, 2099)) AS waiting`
        // Outside any tally: counted by nobody.
        yield* writer.write(waiter`SELECT 1`)
        const [outer, [inner, held]] = yield* DatabaseMetrics.tally(Effect.gen(function*() {
          // One transaction: the nested write is its savepoint.
          yield* writer.write(writer.write(waiter`SELECT 1`))
          // Neither a lone statement nor a read-only transaction takes the lock.
          yield* waiter`SELECT 1`
          yield* reader.withTransaction(reader`SELECT 1`)
          return yield* DatabaseMetrics.tally(Effect.gen(function*() {
            // The holder's transaction counts, and so does the write a forked
            // fiber sends while the holder keeps it waiting.
            const { blocked, held } = yield* holder.withTransaction(Effect.gen(function*() {
              const blocked = yield* writer.write(waiter`SELECT 1`).pipe(Effect.forkScoped)
              yield* TestDatabase.until(Effect.map(waiting, ([row]) => row!.waiting))
              const observed = yield* Clock.currentTimeMillis
              yield* Effect.sleep("50 millis")
              return { blocked, held: (yield* Clock.currentTimeMillis) - observed }
            }))
            yield* Fiber.join(blocked)
            return held
          }))
        }))
        // None names a partition, so each holds the whole schema.
        expect([inner.transactions, inner.schemaWide]).toEqual([2, 2])
        expect(Duration.toMillis(inner.lockWait)).toBeGreaterThanOrEqual(held)
        expect(Duration.toMillis(inner.maxLockWait)).toBeGreaterThanOrEqual(held)
        expect(Duration.toMillis(inner.maxLockWait)).toBeLessThanOrEqual(Duration.toMillis(inner.lockWait))
        expect(Duration.toMillis(outer.maxLockWait)).toBeGreaterThanOrEqual(Duration.toMillis(inner.maxLockWait))
        expect([outer.transactions, outer.schemaWide]).toEqual([3, 3])
        expect(Duration.toMillis(outer.lockWait)).toBeGreaterThanOrEqual(Duration.toMillis(inner.lockWait))
      }))

    // Retained transport benchmark: 101 independent writes, no competing writer.
    // Real Postgres (and the pooler) behind a TCP proxy, never a mocked SQL service.
    it.live("separates summed acquisition transport cost from the longest uncontended acquisition", () =>
      Effect.gen(function*() {
        const name = schema()
        const direct = yield* client(name)
        yield* direct`CREATE TABLE acquisition_receipts (id INTEGER PRIMARY KEY)`
        const slowUrl = yield* SlowNetwork.proxy(url, { delayMs: 20 })
        const sql = Context.get(
          yield* Layer.build(PostgresDatabase.layer({
            url: slowUrl,
            driver: Pg,
            schema: name,
            postgres: { maxConnections: 1 }
          })),
          SqlClient
        )
        const writer = DurableWriter.make(sql)
        const [cost] = yield* DatabaseMetrics.tally(Effect.gen(function*() {
          for (let id = 0; id < 101; id++) {
            const [row] = yield* writer.write(
              sql<{ readonly id: number }>`
              INSERT INTO acquisition_receipts (id) VALUES (${id}) RETURNING id
            `,
              { partition: "idle-run" }
            )
            expect(row!.id).toBe(id)
          }
        }))
        const [stored] = yield* direct<{ readonly count: number; readonly sum: number }>`
          SELECT count(*) AS count, sum(id) AS sum FROM acquisition_receipts
        `
        expect(stored).toEqual({ count: 101, sum: 5050 })
        expect([cost.transactions, cost.schemaWide]).toEqual([101, 0])
        expect(Duration.toMillis(cost.maxLockWait)).toBeLessThan(Duration.toMillis(cost.lockWait))
        console.info(JSON.stringify({
          benchmark: "uncontended-acquisition-transport",
          backend: endpoint.name,
          transactions: cost.transactions,
          networkDelayEachWayMs: 20,
          lockWaitMs: Math.round(Duration.toMillis(cost.lockWait)),
          maxLockWaitMs: Math.round(Duration.toMillis(cost.maxLockWait))
        }))
      }))

    it.live("runs a read-only client's statements in READ ONLY transactions on its schema", () =>
      Effect.gen(function*() {
        const name = schema()
        const writer = yield* client(name)
        yield* writer`CREATE TABLE receipts (id INTEGER)`
        const reader = yield* client(name, { readOnly: true })
        const flag = reader<{ readonly flag: string }>`SELECT current_setting('transaction_read_only') AS flag`
        expect(yield* Effect.all([flag, reader.withTransaction(flag)])).toEqual([[{ flag: "on" }], [{ flag: "on" }]])
        expect(yield* Effect.all([schemaOf(reader), reader.withTransaction(schemaOf(reader))])).toEqual([name, name])
        const refused = yield* Effect.all([
          Effect.flip(reader`INSERT INTO receipts VALUES (1)`),
          Effect.flip(reader.withTransaction(reader`INSERT INTO receipts VALUES (2)`))
        ])
        expect(refused.map((error) => String(error.reason.cause))).toEqual([
          "Error: cannot execute INSERT in a read-only transaction",
          "Error: cannot execute INSERT in a read-only transaction"
        ])
      }))

    it.live("reads the schema through every statement form outside a transaction", () =>
      Effect.gen(function*() {
        const name = schema()
        const sql = yield* client(name)
        const statement = sql<{ readonly schema: string }>`SELECT current_schema() AS schema`
        const raw = (yield* statement.raw) as { readonly rows: ReadonlyArray<{ readonly schema: string }> }
        expect({
          rows: yield* statement,
          unprepared: yield* statement.unprepared,
          withoutTransform: yield* statement.withoutTransform,
          values: yield* statement.values,
          valuesUnprepared: yield* statement.valuesUnprepared,
          raw: raw.rows
        }).toEqual({
          rows: [{ schema: name }],
          unprepared: [{ schema: name }],
          withoutTransform: [{ schema: name }],
          values: [[name]],
          valuesUnprepared: [[name]],
          raw: [{ schema: name }]
        })
      }))

    it.live("commits a finished stream and rolls back an abandoned or failed one", () =>
      Effect.gen(function*() {
        const name = schema()
        const applicationName = `pooling-stream-${randomUUID()}`
        const sql = yield* client(name, { applicationName })
        const rows = sql<{ readonly schema: string; readonly n: number }>`SELECT current_schema() AS schema, n::int
          FROM generate_series(1, 3) AS n`
        expect(yield* Stream.runCollect(rows.stream)).toEqual([1, 2, 3].map((n) => ({ schema: name, n })))
        const abandoned = sql<{ readonly n: number }>`SELECT n::int FROM generate_series(1, 100000) AS n`
        expect(yield* Stream.runCollect(Stream.take(abandoned.stream, 1))).toEqual([{ n: 1 }])
        const failing = sql`SELECT 1 / (n - 2) FROM generate_series(1, 3) AS n`
        expect(Exit.isFailure(yield* Effect.exit(Stream.runCollect(failing.stream)))).toBe(true)
        // Every stream's transaction has ended, so nothing of this client's is
        // left open on a server connection, and the next statement still works.
        const open = yield* (yield* client(schema()))<{ readonly count: number }>`SELECT count(*)::int AS count
          FROM pg_stat_activity WHERE application_name = ${applicationName} AND state LIKE 'idle in transaction%'`
        expect(open).toEqual([{ count: 0 }])
        expect(yield* schemaOf(sql)).toBe(name)
      }))

    // Hyperdrive drops a connection that closes a statement prepared by name,
    // which `@effect/sql-pg` does when its 100-statement cache evicts one: the
    // flow engine's schema, about 110 statements in one transaction, never
    // installed behind it (2026-10-21).
    it.live("prepares no statement by name, past the hundred a connection's statement cache keeps", () =>
      Effect.gen(function*() {
        const sql = yield* client(schema())
        const marker = `prepared_${randomUUID().replaceAll("-", "")}`
        const held = yield* sql.withTransaction(Effect.gen(function*() {
          for (let index = 0; index < 150; index++) yield* sql.unsafe(`SELECT ${index} AS ${marker}`)
          return yield* sql<{ readonly count: number }>`SELECT count(*)::int AS count FROM pg_prepared_statements
            WHERE statement LIKE ${`%${marker}%`}`
        }))
        expect(held).toEqual([{ count: 0 }])
      }))
  })
}
