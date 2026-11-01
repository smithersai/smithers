import { isLocalFixture } from "../../../packages/repo-targets/test-utils/test-schemas.ts"
import { TestSchemas } from "@smthrs/database"
import { PgClient } from "@effect/sql-pg"
import { Config, Context, Data, Effect, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import * as Database from "./Database.ts"

// The Postgres a test uses (docs/infrastructure.md#tests): the selected local fixture only, and there a schema of its
// own, built by db/migrations and dropped after. A test never migrates the dev database, never touches the dev
// conversation, and never sees another test file's rows.

/** Tests cannot use Postgres: the endpoint is not allowed, or the selected local fixture does not answer. */
export class Unusable extends Data.TaggedError("TestDatabaseUnusable")<{ readonly message: string }> {}

/**
 * A test file's schema on the selected local Postgres: its `name`, and `database`, which opens a client with the schema as
 * its `search_path` for the scope that builds it, as `Database.layer` does for ChatApi.
 */
export class Scratch extends Context.Service<
  Scratch,
  {
    readonly name: string
    readonly database: Layer.Layer<SqlClient.SqlClient | PgClient.PgClient, unknown>
  }
>()("@smthrs/mvp/test/Scratch") {}

const compose = new URL(Database.LOCAL_URL)

const localServer = Config.Port("TEST_DATABASE_PORT").pipe(Config.withDefault(Number(compose.port)), Effect.map((port) => {
  const server = new URL(compose)
  server.port = String(port)
  return server
}))

/** An isolated fixture's Electric port; test configuration cannot name a remote host. */
export const electricUrl = Config.Port("TEST_ELECTRIC_PORT").pipe(
  Config.withDefault(30001),
  Effect.map((port) => `http://localhost:${port}`),
)

/** `DATABASE_URL`, the local Postgres when unset; only selected-port loopback authorities without endpoint overrides. */
export const serverUrl = Effect.gen(function* () {
  const expected = yield* localServer
  const url = new URL(Redacted.value(yield* Database.url))
  if (!isLocalFixture(url, expected.port)) {
    return yield* new Unusable({
      message: `Tests use only the compose Postgres at ${expected.host}, and DATABASE_URL names ${url.host}. Unset it.`,
    })
  }
  return url
})

/** Only selected local fixture endpoints, retained across nested ConfigProvider boundaries. */
export const fixtureConfig = Effect.gen(function* () {
  const database = yield* serverUrl
  const electric = yield* electricUrl
  return {
    DATABASE_URL: database.toString(),
    TEST_DATABASE_PORT: database.port,
    ELECTRIC_URL: electric,
    TEST_ELECTRIC_PORT: new URL(electric).port,
  }
})

/** Socket error codes that only say nothing listens there, or there is no route to it. */
const UNREACHABLE = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"])

/** Whether a failure only says the server isn't there: an unreachable socket error's code, on it or a cause of it. */
const unreachable = (error: unknown): boolean =>
  typeof error === "object" && error !== null &&
  (UNREACHABLE.has(String((error as { readonly code?: unknown }).code)) ||
    unreachable((error as { readonly cause?: unknown }).cause))

/**
 * A failure as a test reports it: `Unusable`, naming `pnpm db:up`, when it only says nothing answers at `host`, where
 * the compose `service` runs; any other failure as it is.
 */
export const explain = (service: string, host: string) => (error: unknown) =>
  unreachable(error) ? new Unusable({ message: `No ${service} answers at ${host}. Start it with pnpm db:up.` }) : error

/**
 * A schema named `<prefix>_<epoch-seconds>_<hex>` on the compose Postgres, migrated by db/migrations: `Scratch`, and a `SqlClient`
 * of up to 4 connections on it. Connections name the schema as their `application_name`, so `pg_stat_activity`
 * tells them apart. The schema is dropped, with everything in it, when the layer's scope closes. Fails with
 * `Unusable` naming `pnpm db:up` when nothing answers at the compose Postgres; any other failure passes as it is.
 */
export const layer = (prefix: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const server = yield* serverUrl
      const name = TestSchemas.schemaName(prefix)
      const scoped = new URL(server)
      scoped.searchParams.set("options", `-c search_path=${name}`)
      scoped.searchParams.set("application_name", name)
      const url = Redacted.make(scoped.toString())
      const database = Database.layer(Effect.succeed(url))
      const admin = yield* Layer.build(PgClient.layer({ url: Redacted.make(server.toString()), maxConnections: 1 }))
      const sql = Context.get(admin, SqlClient.SqlClient)
      // A connection still open on the schema when its scope closes, such as a request ChatApi was still serving, is
      // ended first. The drop takes every table's lock in turn, so a transaction holding one table while it waits for
      // another deadlocked with it.
      yield* Effect.acquireRelease(
        sql`CREATE SCHEMA ${sql(name)}`,
        () =>
          Effect.orDie(
            Effect.andThen(
              sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = ${name}`,
              sql`DROP SCHEMA ${sql(name)} CASCADE`,
            ),
          ),
      )
      yield* Effect.provide(Database.migrate, database)
      return Layer.merge(
        Layer.succeed(Scratch, Scratch.of({ name, database })),
        PgClient.layer({ url, maxConnections: 4 }),
      )
    }).pipe(Effect.catch((error) => Effect.flatMap(localServer, (expected) => Effect.fail(explain("Postgres", expected.host)(error))))),
  )
