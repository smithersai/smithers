import { migrations } from "./MigrationManifest.ts"
export { migrations }
import { PgClient } from "@effect/sql-pg"
import { Config, Effect, Layer, Redacted } from "effect"
import { Migrator } from "effect/sql"

/** The compose Postgres (`docker-compose.yml`): what `DATABASE_URL` defaults to, and the only one tests use. */
export const LOCAL_URL = "postgresql://smithers:smithers@localhost:54321/smithers"

/** `DATABASE_URL`: the migrations, the tests, and the origin Hyperdrive fronts for ChatApi. */
export const url = Config.Redacted("DATABASE_URL").pipe(Config.withDefault(Redacted.make(LOCAL_URL)))

/**
 * `DATABASE_URL` in the parts Hyperdrive takes: the `origin` (host; port, 5432 when the URL names none; database,
 * user and password, URL-decoded), and the `sslmode` `alchemy dev` reaches it with: `require` when the URL asks for
 * it, preserving `verify-ca` and `verify-full`; otherwise `disable`. CA file settings are refused because the dev
 * binding cannot preserve them.
 */
export const hyperdrive = (url: Redacted.Redacted<string>) => {
  const parsed = new URL(Redacted.value(url))
  const mode = parsed.searchParams.get("sslmode")
  if (parsed.searchParams.has("sslrootcert")) {
    throw new Error("Hyperdrive dev cannot preserve DATABASE_URL CA settings")
  }
  return {
    origin: {
      scheme: "postgres" as const,
      host: parsed.hostname,
      port: Number(parsed.port || 5432),
      database: decodeURIComponent(parsed.pathname.slice(1)),
      user: decodeURIComponent(parsed.username),
      password: Redacted.make(decodeURIComponent(parsed.password)),
    },
    sslmode: mode === "require" || mode === "verify-ca" || mode === "verify-full" ? mode : ("disable" as const),
  }
}

/**
 * A Postgres client as `PgClient` and `SqlClient`, connected for as long as the scope that builds the layer.
 * A Worker builds one per request, because workerd ties a socket to the request that opened it. Statements go out
 * unnamed: past 100 named statements on a connection the driver closes the oldest, and Hyperdrive drops the
 * connection when it does (`@smthrs/database` `PostgresDatabase`). Standalone operations may supply verified TLS options.
 */
export const layer = <E, R>(connectionString: Effect.Effect<Redacted.Redacted<string>, E, R>, ssl?: PgClient.PgClientConfig["ssl"]) =>
  Layer.unwrap(Effect.map(connectionString, (url) => PgClient.layer({ url, ssl, maxConnections: 1, prepare: false })))

/** Applies every migration in `db/migrations` that hasn't run, in order; returns the ones it applied. */
export const migrate = Migrator.make({})({
  loader: Migrator.fromRecord({
    ...migrations,
    // Keep the published migration intact, preparing its storage before it converts any legacy rows.
    "0025_flow_source": Effect.andThen(migrations["0125_flow_source_limits"], migrations["0025_flow_source"]),
  }),
})

/**
 * `pnpm db:migrate`: `migrate`, then one log line, `db:migrate: applied` with the migrations it applied as `applied`
 * (`<id>_<name>`, comma-separated), or `db:migrate: up to date`.
 */
export const migrateAndReport = Effect.gen(function* () {
  const applied = yield* migrate
  yield* Effect.logInfo(applied.length === 0 ? "db:migrate: up to date" : "db:migrate: applied").pipe(
    Effect.annotateLogs({ applied: applied.map(([id, name]) => `${id}_${name}`).join(", ") }),
  )
})
