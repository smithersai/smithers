// The Hyperdrive configs ChatApi binds, `ChatDatabase` and `EngineDatabase`, and in production the deploy step that
// migrates Postgres first.
// Only alchemy.run.ts imports this file: it runs `db/migrations` from the deploying machine.
import * as Alchemy from "alchemy"
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Output from "alchemy/Output"
import { Effect, FileSystem, type Redacted } from "effect"
import * as Database from "../db/Database.ts"
import * as Connection from "../ops/database/Connection.ts"
import { COMPUTE_MAX_CU, COMPUTE_MIN_CU, CONNECTION_BUDGET } from "./Connections.ts"
import { Compute, migrationUrl, Postgres } from "./Postgres.ts"

/**
 * Applies `db/migrations` to the production database with `Database.migrate`, the migrations `pnpm db:migrate` runs
 * locally. Alchemy runs it during a deploy whose input changed: a new database or a new migration file. It returns
 * the migration files it was run for.
 */
const Migrations = Alchemy.Action(
  "ChatMigrations",
  (input: { readonly database: Redacted.Redacted<string>; readonly migrations: ReadonlyArray<string> }) =>
    Connection.migrate(input.database).pipe(Effect.as(input.migrations)),
)

/** The migration files in `db/migrations`, in order. */
const migrationFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const files = yield* fs.readDirectory("db/migrations")
  return files.filter((file) => file.endsWith(".ts")).sort()
}).pipe(Effect.orDie)

/**
 * The two Hyperdrive configs in front of Postgres, with their query cache off: an answer's history must see the latest
 * writes. `ChatDatabase` is the request path's (ChatApi's requests), `EngineDatabase` the durable engine's (every
 * `FlowExecution` alarm and call), each with its own origin connection limit (infra/Connections.ts
 * `CONNECTION_BUDGET`, decision 0150), so an engine burst can't take the connections sessions, roles and shape access
 * read with.
 * - Production: both front the Neon project's direct host, and are created or updated only after the migrations ran,
 *   so ChatApi never deploys against an unmigrated database.
 * - `alchemy dev`: each passes the binding straight through to `DATABASE_URL`, the compose Postgres by default.
 *
 * alchemy.run.ts declares them before ChatApi, so ChatApi's own `Hyperdrive.Connection("ChatDatabase", …)` and
 * `Hyperdrive.Connection("EngineDatabase", …)` resolve to these.
 */
export const Databases = Effect.gen(function* () {
  if (yield* Alchemy.ALCHEMY_DEV) {
    const { origin, sslmode } = Database.hyperdrive(yield* Database.url)
    const dev = (name: string) =>
      Cloudflare.Hyperdrive.Connection(name, { origin, caching: { disabled: true }, dev: { ...origin, sslmode } })
    return { chat: yield* dev("ChatDatabase"), engine: yield* dev("EngineDatabase") }
  }
  const postgres = yield* Postgres
  // The compute's size before anything connects to it (infra/Connections.ts `COMPUTE_MIN_CU`).
  const compute = yield* Compute({
    projectId: postgres.projectId,
    branchId: postgres.defaultBranchId,
    minCu: COMPUTE_MIN_CU,
    maxCu: COMPUTE_MAX_CU,
  })
  const migrated = yield* Migrations({ database: migrationUrl(postgres), migrations: yield* migrationFiles })
  const origin = Output.map(Output.all(postgres.origin, migrated, compute), ([origin]) => origin)
  // Each config's share of the compute's connections (infra/Connections.ts `CONNECTION_BUDGET`).
  const chat = yield* Cloudflare.Hyperdrive.Connection("ChatDatabase", {
    origin,
    caching: { disabled: true },
    originConnectionLimit: CONNECTION_BUDGET.hyperdrive,
  })
  const engine = yield* Cloudflare.Hyperdrive.Connection("EngineDatabase", {
    origin,
    caching: { disabled: true },
    originConnectionLimit: CONNECTION_BUDGET.engine,
  })
  return { chat, engine }
})
