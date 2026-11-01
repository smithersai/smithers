import { TestSchemas } from "@smthrs/database"
/**
 * The real databases the execution suites run against, both from
 * `apps/mvp/docker-compose.yml`: Postgres itself, and PgBouncer in
 * transaction-pooling mode in front of it, which treats a client the way
 * Cloudflare Hyperdrive does. Each case gets a schema of its own and drops it
 * afterwards.
 */
import * as Pg from "@effect/sql-pg"
import { PostgresDatabase } from "@smthrs/database"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as SqlClient from "effect/sql/SqlClient"
import { connect } from "node:net"

/**
 * Whether anything accepts connections at `url`. Only a refused connection
 * means the service is absent; any other error fails the suite.
 */
const listening = (url: string): Promise<boolean> => {
  const { hostname, port } = new URL(url)
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port || 5432) })
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once(
      "error",
      (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED" ? resolve(false) : reject(error)
    )
  })
}

/** The compose Postgres, or `SMITHERS_TEST_PG_URL`. Schemas are made and dropped here. */
export const url = process.env.SMITHERS_TEST_PG_URL ?? "postgresql://smithers:smithers@127.0.0.1:54321/smithers"

/** A database the engine runs against in a suite. */
export interface Target {
  readonly url: string
  readonly available: boolean
  /** The name a suite carries: when the database is absent, why the suite skipped. */
  readonly label: string
}

const target = async (name: string, targetUrl: string, start: string): Promise<Target> => {
  const available = await listening(targetUrl)
  return {
    url: targetUrl,
    available,
    label: available ? name : `${name}, skipped: nothing listens at ${new URL(targetUrl).host} (${start})`
  }
}

/** Postgres directly, and through transaction pooling. */
export const targets: ReadonlyArray<Target> = [
  await target("Postgres", url, "pnpm db:up in apps/mvp"),
  await target(
    "PgBouncer in transaction pooling",
    process.env.SMITHERS_TEST_PGBOUNCER_URL ?? "postgresql://smithers:smithers@127.0.0.1:54322/smithers",
    "docker compose up -d pgbouncer in apps/mvp"
  )
]

/** Postgres directly. */
export const direct: Target = targets[0]!

/** A fresh schema name for one case. */
export const freshSchema = (): string => TestSchemas.schemaName("cf_test")

/** The engine's `SqlClient` in `schema`, the way an app composes it. */
export const database = (schema: string, databaseUrl = url) =>
  PostgresDatabase.layer({ url: databaseUrl, driver: Pg, schema })

/** Runs `effect` with a plain client on Postgres directly, outside any engine schema. */
export const admin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Pg.PgClient.layer({ url: Redacted.make(url), maxConnections: 1 })), Effect.scoped)
  )

/** How many journal entries `schema` holds: its runs' own and their ownership records. */
export const entries = (schema: string): Promise<number> =>
  admin(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly entries: number }>`
      SELECT COUNT(*)::int AS entries FROM ${sql(schema)}.flows_journal_events
    `
    return row!.entries
  }))

/** Drops a case's schema. */
export const dropSchema = (schema: string): Promise<void> =>
  admin(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`
  }))
