import * as TestSchemas from "../src/TestSchemas.ts"
/**
 * Durable writes per second through PostgreSQL's writer locks
 * (docs/decisions/0001-run-writer-locks.md).
 *
 * A `DurableWriter.write` that names no partition takes the schema's
 * transaction-scoped advisory lock, so such writes to one schema commit one
 * at a time however many processes send them. A write that names a partition
 * shares the schema's lock and takes its partition's, so writes to different
 * partitions, such as two runs' journal entries, commit side by side. Each
 * writer here is a separate client with one connection, the way separate
 * Workers or Durable Objects write, and each write inserts one row in its own
 * transaction. The cases:
 *
 * - one writer on one schema: the latency floor of a write;
 * - sixteen writers on one schema naming no partition: the schema lock's
 *   ceiling, which every write had before partitions;
 * - sixteen writers on one schema, one partition: one run's ceiling;
 * - sixteen writers on one schema, sixteen partitions: sixteen runs;
 * - sixteen writers on sixteen schemas: no shared lock at all.
 *
 * Each runs on the compose PgBouncer (`pool_mode=transaction`, 127.0.0.1:54322),
 * the compose PostgreSQL it fronts (127.0.0.1:54321), and that PostgreSQL
 * behind a 2 ms-each-way slow network (`@smthrs/database/test/SlowNetwork`),
 * which charges a round trip about what a Worker pays through Hyperdrive.
 * Bounded by the server connections the pooler grants (four on the compose
 * PgBouncer). Writes per second is the reported rate times the writes per
 * iteration (1 or 16); the line printed after each case states it.
 *
 * Run: `docker compose up -d postgres pgbouncer` in apps/mvp, then
 * `pnpm --filter @smthrs/database bench`.
 */
import * as Pg from "@effect/sql-pg"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { randomUUID } from "node:crypto"
import { afterAll, describe, test, type TestContext } from "vitest"
import { DurableWriter, PostgresDatabase } from "../src/index.ts"
import * as SlowNetwork from "../src/test/SlowNetwork.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"
import { listening, pgbouncerUrl } from "./harness/listening.ts"

const scope = Effect.runSync(Scope.make())
afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)))

const postgresUrl = "postgres://smithers:smithers@127.0.0.1:54321/smithers"
const endpoints = [
  { name: "PgBouncer pool_mode=transaction", url: pgbouncerUrl, probe: pgbouncerUrl },
  { name: "PostgreSQL", url: postgresUrl, probe: postgresUrl },
  {
    name: "PostgreSQL behind a 2 ms slow network",
    url: await Effect.runPromise(Scope.provide(SlowNetwork.proxy(postgresUrl, { delayMs: 2 }), scope)),
    probe: postgresUrl
  }
]

/**
 * One writer: its own one-connection client on `schema` in `within`, which
 * closes it, and a table to insert into; it writes `partition`.
 */
const writer = (within: Scope.Scope, url: string, schema: string, partition?: string) =>
  Effect.runPromise(Effect.gen(function*() {
    const sql = Context.get(
      yield* Layer.buildWithScope(
        PostgresDatabase.layer({ url, driver: Pg, schema, postgres: { maxConnections: 1 } }),
        within
      ),
      SqlClient
    )
    yield* sql`CREATE TABLE IF NOT EXISTS writes (id BIGINT GENERATED ALWAYS AS IDENTITY, writer TEXT NOT NULL)`
    yield* Scope.addFinalizer(within, TestDatabase.dropSchema(sql, schema).pipe(Effect.orDie))
    const durable = DurableWriter.make(sql)
    const name = randomUUID()
    return durable.write(sql`INSERT INTO writes (writer) VALUES (${name})`, { partition })
  }))

const name = () => TestSchemas.schemaName("bench")

for (const endpoint of endpoints) {
  const up = await listening(endpoint.probe)
  describe.skipIf(!up)(`${endpoint.name} (${new URL(endpoint.url).host})`, () => {
    /**
     * Benchmarks `count` writers sending one write each per iteration: writer
     * `index` writes schema `schemaOf(index)` and partition `partitionOf(index)`.
     * Their connections close when the case ends, so the pooler's client limit
     * is never reached.
     */
    const measure = async (
      bench: TestContext["bench"],
      label: string,
      count: number,
      schemaOf: (index: number) => string,
      partitionOf: (index: number) => string | undefined
    ) => {
      const within = Effect.runSync(Scope.make())
      try {
        const writes = []
        // One at a time: concurrent CREATE TABLE IF NOT EXISTS in one schema can collide.
        for (let index = 0; index < count; index++) {
          writes.push(await writer(within, endpoint.url, schemaOf(index), partitionOf(index)))
        }
        const all = Effect.all(writes, { concurrency: "unbounded", discard: true })
        const result = await bench(label, () => Effect.runPromise(all)).run()
        console.log(`${endpoint.name}, ${label}: ${Math.round(result.throughput.mean * count)} writes/s`)
      } finally {
        await Effect.runPromise(Scope.close(within, Exit.void))
      }
    }

    test("one writer, one schema", async ({ bench }) => {
      const schema = name()
      await measure(bench, "1 writer, 1 schema", 1, () => schema, () => undefined)
    })

    test("sixteen writers, one schema", async ({ bench }) => {
      const schema = name()
      await measure(bench, "16 writers, 1 schema", 16, () => schema, () => undefined)
    })

    test("sixteen writers, one schema, one partition", async ({ bench }) => {
      const schema = name()
      await measure(bench, "16 writers, 1 schema, 1 partition", 16, () => schema, () => "run")
    })

    test("sixteen writers, one schema, sixteen partitions", async ({ bench }) => {
      const schema = name()
      await measure(bench, "16 writers, 1 schema, 16 partitions", 16, () => schema, (index) => `run-${index}`)
    })

    test("sixteen writers, sixteen schemas", async ({ bench }) => {
      const schemas = Array.from({ length: 16 }, name)
      await measure(bench, "16 writers, 16 schemas", 16, (index) => schemas[index]!, () => undefined)
    })
  })
}
