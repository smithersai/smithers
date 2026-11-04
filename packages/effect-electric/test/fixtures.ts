import { PgClient } from "@effect/sql-pg"
import { TestSchemas } from "@smthrs/database"
import { type Outbox, Persistence } from "@smthrs/effect-tanstack-db"
import { BrowserCollectionCoordinator, createBrowserWASQLitePersistence } from "@tanstack/browser-db-sqlite-persistence"
import { createPersistedTableName } from "@tanstack/db-sqlite-persistence-core"
import { Effect, Option, Redacted, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { ShapeSource } from "../src/index.ts"
import { sqlite } from "./sqlite.ts"

// What the Electric-backed suites need: a real Postgres and Electric, a scratch table per test, and a network with
// switches. Point them at your own with DATABASE_URL and ELECTRIC_URL; the defaults are apps/mvp's
// docker-compose.yml (`pnpm --filter @smthrs/mvp db:up`).

export const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://smithers:smithers@localhost:54321/smithers"
export const ELECTRIC_URL = process.env.ELECTRIC_URL ?? "http://localhost:30001"

/**
 * Whether Electric answers its health check. Only a refused or timed-out connection counts as absent, and says so;
 * any other answer fails the suite.
 */
export const electricUp: boolean = await fetch(`${ELECTRIC_URL}/v1/health`, { signal: AbortSignal.timeout(2_000) })
  .then((response) => {
    if (!response.ok) throw new Error(`Electric at ${ELECTRIC_URL} answered ${response.status} to /v1/health`)
    return true
  }, (error: unknown) => {
    if (process.env.SMITHERS_ELECTRIC_TEST_REQUIRED === "1") throw error
    const code = (error as { cause?: { code?: string } }).cause?.code
    if (code !== "ECONNREFUSED" && (error as Error).name !== "TimeoutError") throw error
    console.warn(`Electric suites skipped: nothing answers at ELECTRIC_URL=${ELECTRIC_URL}.`)
    return false
  })

/** A Postgres client on DATABASE_URL. */
export const postgres = PgClient.layer({ url: Redacted.make(DATABASE_URL) })

export type Row = { id: string; text: string; n: number }

/** A scratch table `<schema>.notes`, dropped with its schema when the scope closes, and writes to it. */
export const scratchTable = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const schema = TestSchemas.schemaName("effect_electric")
  yield* Effect.acquireRelease(
    sql.unsafe(`create schema ${schema}`).pipe(
      Effect.andThen(
        sql.unsafe(`create table ${schema}.notes (id text primary key, text text not null, n bigint not null)`)
      )
    ),
    () => sql.unsafe(`drop schema ${schema} cascade`).pipe(Effect.ignore)
  )
  const table = `${schema}.notes`
  const write = (row: Row) =>
    sql<{ txid: string }>`insert into ${sql(table)} ${
      sql.insert(row)
    } returning pg_current_xact_id()::xid::text as txid`
      .pipe(Effect.map(([inserted]) => Number(inserted!.txid)), Effect.orDie)
  const rename = (id: string, text: string) =>
    sql`update ${sql(table)} set text = ${text} where id = ${id}`.pipe(Effect.asVoid, Effect.orDie)
  const remove = (id: string) => sql`delete from ${sql(table)} where id = ${id}`.pipe(Effect.asVoid, Effect.orDie)
  return { table, write, rename, remove }
})

/**
 * Runs `make` with `ShapeSource.layerFaulty`, the test source, so the collection it makes sends its shape requests
 * through switches the test throws. Happy-path tests use the real source.
 */
export const faulty = <A, E, R>(make: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const faults = yield* ShapeSource.Faults
    return { faults, collection: yield* make }
  }).pipe(Effect.provide(ShapeSource.layerFaulty()))

/** Retries `check` every 20 ms for up to 10 s. */
export const eventually = (check: () => boolean): Effect.Effect<void> =>
  Effect.suspend(() => (check() ? Effect.void : Effect.fail("not yet"))).pipe(
    Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 500 }),
    Effect.orDie
  )

/** A SQLite file of the test's own. */
export const databaseFile = () => join(tmpdir(), `effect-electric-${crypto.randomUUID()}.sqlite`)

/**
 * `Persistence` over a SQLite file in Node, through TanStack DB's own browser persistence: its database is
 * node:sqlite, as a tab's is OPFS.
 */
export const persistenceOn = (path: string, device?: string) =>
  Persistence.layer({
    open: () => sqlite(path),
    make: (database, coordinator) =>
      createBrowserWASQLitePersistence({ database, ...(coordinator ? { coordinator } : {}) }),
    ...(device === undefined ? {} : {
      coordinator: () => new BrowserCollectionCoordinator({ dbName: device }),
      lock: deviceLocks(device)
    })
  })

// The host's real Web Locks, shared by programs on one test device. No lock is stolen in these suites.
const deviceLocks = (device: string): Outbox.Lock => {
  const request = (name: string, ifAvailable: boolean) =>
    Effect.acquireRelease(
      Effect.callback<(() => void) | undefined>((resume, signal) => {
        void navigator.locks.request(`${device}/${name}`, ifAvailable ? { ifAvailable: true } : { signal }, (held) => {
          if (held === null) return void resume(Effect.succeed(undefined))
          return new Promise<void>((release) => resume(Effect.succeed(release)))
        }).catch(() => undefined)
      }).pipe(Effect.interruptible),
      (release) => Effect.sync(() => release?.())
    ).pipe(Effect.map((release) => release === undefined ? Option.none() : Option.some({ lost: Effect.never })))
  return {
    hold: (name) => Effect.map(request(name, false), Option.getOrThrow),
    tryHold: (name) => request(name, true)
  }
}

/**
 * How many rows of collection `id` the SQLite file at `path` holds, read on a connection of its own. A synced row is
 * stored a moment after the collection shows it, so a test that closes a program waits for this first.
 */
export const storedRows = (path: string, id: string): number => {
  const database = new DatabaseSync(path)
  try {
    const table = createPersistedTableName(id)
    const found = database.prepare("select name from sqlite_master where type = 'table' and name = ?").get(table)
    return found === undefined
      ? 0
      : Number((database.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n)
  } finally {
    database.close()
  }
}
