import { Context, Effect, Exit, Layer, Scope } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { afterAll, describe, test } from "vitest"
import { Dialect, DurableWriter, Migrations, TestSchemas } from "../src/index.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"

const scope = Effect.runSync(Scope.make())
afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)))

const env = await Effect.runPromise(Layer.buildWithScope(TestDatabase.sqliteLayer, scope))
const sql = Context.get(env, SqlClient.SqlClient)
const writer = Context.get(env, DurableWriter.DurableWriter)

await Effect.runPromise(Effect.gen(function*() {
  yield* sql`CREATE TABLE IF NOT EXISTS bench_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    seq INTEGER NOT NULL,
    payload TEXT NOT NULL
  )`
  yield* sql`CREATE INDEX IF NOT EXISTS bench_items_key_idx ON bench_items (key)`
  for (let i = 0; i < 200; i++) {
    const payload = JSON.stringify({ step: `step-${i}`, status: i % 2 === 0 ? "done" : "pending", cost: i * 3 })
    yield* sql`INSERT INTO bench_items (key, seq, payload) VALUES (${`item-${i}`}, ${i}, ${payload})`
  }
}))

const migrationSet: Migrations.MigrationSet = {
  namespace: "bench",
  idOffset: 1000,
  migrations: {
    "0001_init": sql`CREATE TABLE IF NOT EXISTS bench_mig_check (id INTEGER PRIMARY KEY)`.pipe(Effect.asVoid)
  }
}

await Effect.runPromise(
  Migrations.run([migrationSet]).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.provideService(DurableWriter.DurableWriter, writer)
  )
)

const samplePayload = JSON.stringify({ step: "compile", status: "done", cost: 42 })
const pointLookup = sql<{ readonly id: number; readonly payload: string }>`
  SELECT id, payload FROM bench_items WHERE key = ${"item-120"}
`
const rangeScan = sql<{ readonly id: number; readonly key: string; readonly payload: string }>`
  SELECT id, key, payload FROM bench_items WHERE seq >= ${50} AND seq < ${150} ORDER BY seq
`
const jsonExtractQuery = sql<{ readonly step: string | null }>`
  SELECT ${Dialect.jsonText(sql, sql.literal("payload"), "$.step")} AS step
  FROM bench_items WHERE key = ${"item-42"}
`
const idempotentMigrate = Migrations.run([migrationSet]).pipe(
  Effect.provideService(SqlClient.SqlClient, sql),
  Effect.provideService(DurableWriter.DurableWriter, writer)
)

let writeCounter = 0
const singleWrite = writer.write(
  Effect.suspend(() => {
    const idx = writeCounter++
    return sql`INSERT INTO bench_items (key, seq, payload) VALUES (${`w-${idx}`}, ${idx}, ${samplePayload})`.pipe(
      Effect.asVoid
    )
  })
)

const batch20Write = writer.write(
  Effect.gen(function*() {
    for (let i = 0; i < 20; i++) {
      const idx = writeCounter++
      yield* sql`INSERT INTO bench_items (key, seq, payload) VALUES (${`b-${idx}`}, ${idx}, ${samplePayload})`
    }
  })
)

const runPromise = Effect.runPromise
const schemaNameFn = TestSchemas.schemaName
const jsonTextFn = Dialect.jsonText
const opts = { time: 120, warmupTime: 30 }

describe("@smthrs/database (offline SQLite + Dialect)", () => {
  test("DurableWriter.write single-row transaction", async ({ bench }) => {
    await bench("DurableWriter.write (1 row)", () => runPromise(singleWrite)).run(opts)
  })

  test("DurableWriter.write batched 20-row transaction", async ({ bench }) => {
    await bench("DurableWriter.write (20 rows)", () => runPromise(batch20Write)).run(opts)
  })

  test("SqlClient point lookup and 100-row range scan", async ({ bench }) => {
    await bench("SELECT point lookup", () => runPromise(pointLookup)).run(opts)
    await bench("SELECT 100-row range scan", () => runPromise(rangeScan)).run(opts)
  })

  test("Dialect.jsonText fragment build and query", async ({ bench }) => {
    await bench("Dialect.jsonText fragment", () => {
      jsonTextFn(sql, sql.literal("payload"), "$.meta.items[0].name")
    }).run(opts)

    await bench("Dialect.jsonText query", () => runPromise(jsonExtractQuery)).run(opts)
  })

  test("Migrations.run idempotent no-op check", async ({ bench }) => {
    await bench("Migrations.run (already applied)", () => runPromise(idempotentMigrate)).run(opts)
  })

  test("TestSchemas.schemaName generation", async ({ bench }) => {
    await bench("TestSchemas.schemaName", () => {
      schemaNameFn("bench")
    }).run(opts)
  })
})
