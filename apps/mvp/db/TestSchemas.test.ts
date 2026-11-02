import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { PgClient } from "@effect/sql-pg"
import { ConfigProvider, Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { forStore, isLocalFixture, localFixture, MAX_AGE_SECONDS, MAX_SCHEMAS, NAME_PATTERN, reap, schemaName, setup } from "../../../packages/repo-targets/test-utils/test-schemas.ts"
import * as TestDatabase from "./TestDatabase.ts"

const url = await Effect.runPromise(TestDatabase.serverUrl)
const run = <A, E>(body: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) => Effect.runPromise(
  Effect.scoped(Effect.flatMap(SqlClient.SqlClient, body).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(url.toString()), maxConnections: 1 })))),
)
const exists = (name: string) => run((sql) => sql`SELECT 1 FROM pg_namespace WHERE nspname = ${name}`).then((rows) => rows.length === 1)
const startNextRun = () => promisify(execFile)(process.execPath, ["--input-type=module", "-e",
  `const { setup } = await import(${JSON.stringify(new URL("../../../packages/repo-targets/test-utils/test-schemas.ts", import.meta.url).href)}); await setup();`,
], { env: { ...process.env, DATABASE_URL: url.toString() } })
const old = () => schemaName("reapproof", Math.floor(Date.now() / 1_000) - MAX_AGE_SECONDS - 10)
const create = (name: string) => run((sql) => sql`CREATE SCHEMA ${sql(name)}`)
const drop = (name: string) => run((sql) => sql`DROP SCHEMA IF EXISTS ${sql(name)} CASCADE`)

test("schema identities contain their creation time, are unique and fit a Postgres identifier", () => {
  expect(schemaName("flows")).toMatch(new RegExp(NAME_PATTERN))
  expect(schemaName("a".repeat(100))).toHaveLength(63)
  expect(schemaName("flows")).not.toBe(schemaName("flows"))
  const hyphenated = schemaName("who-may-ask")
  expect(hyphenated).toMatch(/^who_may_ask_/)
  expect(hyphenated).toMatch(new RegExp(NAME_PATTERN))
  expect(Buffer.byteLength(schemaName("long-hyphenated-prefix".repeat(10)))).toBe(63)
  for (const prefix of ["", "UPPER", "é", "0bad", "flows\n", "flows\r", "flows\u2028"]) expect(() => schemaName(prefix)).toThrow("Invalid test schema")
  for (const time of [0, 999_999_999, 10_000_000_000, 1_234_567_890.5, NaN]) expect(() => schemaName("flows", time)).toThrow()
})

test("SIGKILL leaves a real schema; the next startup reaps it only after the age bound", async () => {
  const name = schemaName("reapcrash")
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { PgClient } from '@effect/sql-pg';
    import { Effect, Redacted } from 'effect';
    import { SqlClient } from 'effect/sql';
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe('CREATE SCHEMA "' + process.env.REAP_SCHEMA + '"');
      yield* sql.unsafe('CREATE TABLE "' + process.env.REAP_SCHEMA + '".proof (id int)');
      process.stdout.write('ready\\n');
      yield* Effect.never;
    }).pipe(Effect.provide(PgClient.layer({url: Redacted.make(process.env.REAP_URL)})))));
  `], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, REAP_SCHEMA: name, REAP_URL: url.toString() }, stdio: ["ignore", "pipe", "pipe"] })
  try {
    const ready = await Promise.race([once(child.stdout!, "data").then(([data]) => String(data)), once(child, "exit").then(() => "exited")])
    expect(ready).toBe("ready\n")
    const exited = once(child, "exit")
    child.kill("SIGKILL")
    expect((await exited)[1]).toBe("SIGKILL")
    expect(await exists(name)).toBe(true)
    await startNextRun()
    expect(await exists(name)).toBe(true)
    // Advancing the persisted creation timestamp avoids waiting two hours; no test clock or DB mock.
    const expired = old()
    await run((sql) => sql`ALTER SCHEMA ${sql(name)} RENAME TO ${sql(expired)}`)
    try {
      await startNextRun()
      expect(await exists(expired)).toBe(false)
    } finally { await drop(expired) }
  } finally {
    child.kill("SIGKILL")
    await drop(name)
  }
})

test("young, locked, public, smithers_flows and non-matching schemas survive concurrent reapers", async () => {
  const young = schemaName("reapyoung"), locked = old(), stale = old()
  const nonmatching = `reaplegacy_${crypto.randomUUID().replaceAll("-", "")}`
  const protectedBefore = await Promise.all([exists("public"), exists("smithers_flows")])
  await Promise.all([young, locked, stale, nonmatching].map(create))
  try {
    await run((sql) => sql`CREATE TABLE ${sql(locked)}.held (id int)`)
    await run((sql) => sql.withTransaction(Effect.gen(function* () {
      yield* sql`LOCK TABLE ${sql(locked)}.held IN ACCESS SHARE MODE`
      const results = yield* Effect.promise(() => Promise.all(Array.from({ length: 8 }, () => Effect.runPromise(reap(url.toString())))))
      expect(results.reduce((sum, result) => sum + result.dropped, 0)).toBe(1)
    })))
    expect(await Promise.all([young, locked, nonmatching].map(exists))).toEqual([true, true, true])
    expect(await exists(stale)).toBe(false)
    expect(await Promise.all([exists("public"), exists("smithers_flows")])).toEqual(protectedBefore)
    await Effect.runPromise(reap(url.toString()))
    expect(await exists(locked)).toBe(false)
  } finally { await Promise.all([young, locked, stale, nonmatching].map(drop)) }
})

test("cleanup caps work and a later run finishes the remainder", async () => {
  const names = Array.from({ length: MAX_SCHEMAS + 2 }, old)
  await Promise.all(names.map(create))
  try {
    const counts = await Effect.runPromise(reap(url.toString()))
    expect(counts.dropped).toBe(MAX_SCHEMAS)
    expect((await Promise.all(names.map(exists))).filter(Boolean)).toHaveLength(2)
    await Effect.runPromise(reap(url.toString()))
    expect(await Promise.all(names.map(exists))).toEqual(names.map(() => false))
  } finally { await Promise.all(names.map(drop)) }
})

test("the reaper refuses remote URLs and all driver endpoint overrides before connecting", async () => {
  for (const authority of ["db.example.com:54321", "localhost:5432", "127.0.0.2:54321"]) {
    await expect(Effect.runPromise(reap(`postgresql://owner:secret@${authority}/prod`))).rejects.toThrow("refused non-local")
  }
  for (const query of ["host=remote", "port=5432", "hostaddr=10.0.0.1", "service=remote"]) {
    await expect(Effect.runPromise(reap(`${url}?${query}`))).rejects.toThrow("refused non-local")
  }
  expect(isLocalFixture(new URL("https://localhost:54321"), "54321")).toBe(false)
  expect(localFixture(`${url}?options=-c%20search_path%3Dpublic`).search).toBe("")
  const refused = await Effect.runPromise(Effect.flip(TestDatabase.serverUrl.pipe(Effect.provideService(
    ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ DATABASE_URL: "postgresql://owner:secret@remote:54321/prod" }),
  ))))
  expect(refused).toBeInstanceOf(TestDatabase.Unusable)
})

test("a failed startup logs a redacted warning and resolves", async () => {
  await setup()
  const original = process.env.DATABASE_URL
  process.env.DATABASE_URL = "postgresql://owner:secret@remote.example:54321/production"
  try { await expect(setup()).resolves.toBeUndefined() }
  finally {
    if (original === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = original
  }
})


test("store-derived identities preserve age, remain distinct, and retain legacy configuration", () => {
  const prefix = schemaName("test_copy")
  expect(forStore(prefix, "engine_db")).toMatch(new RegExp(NAME_PATTERN))
  expect(forStore(prefix, "engine_db").slice(-44)).toBe(prefix.slice(-44))
  expect(forStore(prefix, "engine_db")).not.toBe(forStore(prefix, "control_db"))
  expect(forStore("legacy", "engine_db")).toBe("legacy_engine_db")
  expect(() => forStore(prefix, "UPPER")).toThrow("Invalid test store")
  expect(() => forStore(prefix, "engine\n")).toThrow("Invalid test store")
  expect(forStore(`${prefix}\n`, "engine")).toBe(`${prefix}\n_engine`)
})

test("a real permission failure skips the drop and leaves cleanup usable", async () => {
  const name = old(), role = schemaName("reaprole")
  await create(name)
  await run((sql) => sql.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD 'fixture-only'`))
  try {
    const restricted = new URL(url)
    restricted.username = role
    restricted.password = "fixture-only"
    expect(await Effect.runPromise(reap(restricted.toString()))).toMatchObject({ dropped: 0, skipped: 1 })
    expect(await exists(name)).toBe(true)
    expect(await Effect.runPromise(reap(url.toString()))).toMatchObject({ dropped: 1 })
  } finally {
    await drop(name)
    await run((sql) => sql`DROP ROLE ${sql(role)}`)
  }
})

test("a schema object lock races the relation probe: lock_timeout skips it without stalling startup", async () => {
  const name = old()
  await create(name)
  try {
    await run((sql) => sql.withTransaction(Effect.gen(function* () {
      yield* sql`COMMENT ON SCHEMA ${sql(name)} IS 'fixture lock'`
      const counts = yield* Effect.promise(() => Effect.runPromise(reap(url.toString())))
      expect(counts).toMatchObject({ dropped: 0, skipped: 1 })
    })))
    expect(await exists(name)).toBe(true)
    expect(await Effect.runPromise(reap(url.toString()))).toMatchObject({ dropped: 1 })
  } finally { await drop(name) }
})

test("fixture configuration captures and restores the selected local database and Electric ports", async () => {
  const config = await Effect.runPromise(TestDatabase.fixtureConfig.pipe(Effect.provideService(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromUnknown({ DATABASE_URL: url.toString(), TEST_DATABASE_PORT: url.port, TEST_ELECTRIC_PORT: "30055" }),
  )))
  expect(config).toEqual({ DATABASE_URL: url.toString(), TEST_DATABASE_PORT: url.port, ELECTRIC_URL: "http://localhost:30055", TEST_ELECTRIC_PORT: "30055" })
  expect((await Effect.runPromise(TestDatabase.serverUrl.pipe(Effect.provideService(
    ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(config),
  )))).toString()).toBe(url.toString())
})
