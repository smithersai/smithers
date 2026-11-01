// The guard every Postgres test passes (db/TestDatabase.ts): the selected local Postgres only, a schema of its own, and a
// failure that says `pnpm db:up` when nothing is running.
import { PgClient } from "@effect/sql-pg"
import { ConfigProvider, Context, Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Option, Redacted, Scope } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import * as TestDatabase from "./TestDatabase.ts"

const runtime = ManagedRuntime.make(TestDatabase.layer("testdb"))
beforeAll(() => runtime.runPromise(Effect.void))
afterAll(() => runtime.dispose())

/** Runs `effect` with `DATABASE_URL` set to `url`, or unset. */
const withDatabaseUrl = (url: string | undefined) =>
  Effect.provideService(
    ConfigProvider.ConfigProvider,
    ConfigProvider.fromUnknown(url === undefined ? {} : { DATABASE_URL: url }),
  )

/** What connecting to `url` fails with. */
const connecting = (url: string) =>
  runtime.runPromise(
    Effect.flip(
      Effect.provide(
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT 1`),
        PgClient.layer({ url: Redacted.make(url) }),
      ),
    ),
  )

describe("serverUrl", () => {
  test("is the compose Postgres when DATABASE_URL is unset", async () => {
    const url = await runtime.runPromise(TestDatabase.serverUrl.pipe(withDatabaseUrl(undefined)))
    expect(url.toString()).toBe("postgresql://smithers:smithers@localhost:54321/smithers")
  })

  test("takes another database on the compose server", async () => {
    const url = await runtime.runPromise(
      TestDatabase.serverUrl.pipe(withDatabaseUrl("postgresql://smithers:smithers@localhost:54321/elsewhere")),
    )
    expect(url.pathname).toBe("/elsewhere")
  })

  test.each([
    ["another host", "postgresql://owner:secret-pass@db.example.com:54321/smithers", "db.example.com:54321"],
    ["another port", "postgresql://owner:secret-pass@localhost:5432/smithers", "localhost:5432"],
    ["another loopback address", "postgresql://owner:secret-pass@127.0.0.2:54321/smithers", "127.0.0.2:54321"],
  ])("refuses %s, naming its host but never its password", async (_, url, host) => {
    const refused = await runtime.runPromise(Effect.flip(TestDatabase.serverUrl.pipe(withDatabaseUrl(url))))
    expect(refused).toBeInstanceOf(TestDatabase.Unusable)
    expect(refused.message).toBe(
      `Tests use only the compose Postgres at localhost:54321, and DATABASE_URL names ${host}. Unset it.`,
    )
  })
})

describe("layer", () => {
  test("is a migrated schema of its own, its connections named for it, dropped when its scope closes", async () => {
    const schemas = Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql<{ readonly name: string }>`SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE 'probe_%'`,
    )
    const name = await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(TestDatabase.layer("probe"))
          const scratch = Context.get(context, TestDatabase.Scratch)
          expect(scratch.name).toMatch(/^probe_[1-9][0-9]{9}_[0-9a-f]{32}$/)
          expect((yield* schemas).map((schema) => schema.name)).toContain(scratch.name)
          const [own] = yield* Effect.provide(
            Effect.flatMap(
              SqlClient.SqlClient,
              (sql) =>
                sql<{ readonly schema: string; readonly application: string; readonly step: string }>`
                  SELECT current_schema() AS schema, current_setting('application_name') AS application,
                    (SELECT increment_by::text FROM pg_sequences
                      WHERE schemaname = current_schema() AND sequencename = 'messages_position_seq') AS step`,
            ),
            scratch.database,
          )
          expect(own).toEqual({ schema: scratch.name, application: scratch.name, step: "2" })
          const [tests] = yield* Effect.provideContext(
            Effect.flatMap(
              SqlClient.SqlClient,
              (sql) => sql<{ readonly schema: string }>`SELECT current_schema() AS schema`,
            ),
            context,
          )
          expect(tests!.schema).toBe(scratch.name)
          return scratch.name
        }),
      ),
    )
    expect((await runtime.runPromise(schemas)).map((schema) => schema.name)).not.toContain(name)
  })

  test("ends a connection still open on the schema before the drop, so a transaction left open never holds it up", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const context = yield* Layer.buildWithScope(TestDatabase.layer("probe"), scope)
        const scratch = Context.get(context, TestDatabase.Scratch)
        // A request ChatApi is still serving: its transaction holds `messages`, and writes again only once let go.
        const holding = yield* Deferred.make<void>()
        const letGo = yield* Deferred.make<void>()
        const writer = yield* Effect.provide(
          Effect.flatMap(SqlClient.SqlClient, (sql) =>
            sql.withTransaction(
              sql`LOCK TABLE messages IN ROW EXCLUSIVE MODE`.pipe(
                Effect.andThen(Deferred.succeed(holding, undefined)),
                Effect.andThen(Deferred.await(letGo)),
                Effect.andThen(sql`SELECT 1`),
              ),
            )),
          scratch.database,
        ).pipe(Effect.forkDetach)
        yield* Deferred.await(holding)

        const closed = yield* Scope.close(scope, Exit.void).pipe(Effect.timeoutOption("10 seconds"))
        yield* Deferred.succeed(letGo, undefined)
        return { closed: Option.isSome(closed), writer: Exit.isFailure(yield* Fiber.await(writer)) }
      }),
    )

    // The drop didn't wait on the transaction: it ended the transaction's connection, so its next write failed.
    expect(outcome).toEqual({ closed: true, writer: true })
  }, 30_000)

  test("refuses DATABASE_URL naming another server before connecting to it", async () => {
    const refused = await runtime.runPromise(
      Effect.flip(
        Effect.scoped(Layer.build(TestDatabase.layer("refused"))).pipe(
          withDatabaseUrl("postgresql://owner:secret-pass@db.example.com:5432/prod"),
        ),
      ),
    )
    expect(refused).toBeInstanceOf(TestDatabase.Unusable)
  })
})

describe("explain", () => {
  const down = TestDatabase.explain("Postgres", "localhost:54321")

  test.each([
    ["Postgres refusing a connection", () => connecting("postgresql://smithers:smithers@127.0.0.1:9/smithers")],
    [
      "Postgres at a name with two addresses, both refusing",
      () => connecting("postgresql://smithers:smithers@localhost:9/smithers"),
    ],
    ["fetch refused", () => fetch("http://127.0.0.1:2/v1/health").catch((error: unknown) => error)],
    ["a host that doesn't resolve", () => fetch("http://nowhere.invalid/").catch((error: unknown) => error)],
  ])("says to start the compose services for %s", async (_, failure) => {
    const explained = down(await failure())
    expect(explained).toBeInstanceOf(TestDatabase.Unusable)
    expect((explained as TestDatabase.Unusable).message).toBe(
      "No Postgres answers at localhost:54321. Start it with pnpm db:up.",
    )
  })

  test("passes any other failure on as it is", async () => {
    const syntax = await runtime.runPromise(Effect.flip(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELEC 1`)))
    expect(SqlError.isSqlError(syntax)).toBe(true)
    expect(down(syntax)).toBe(syntax)
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })
    expect(down(reset)).toBe(reset)
    expect(down("refused")).toBe("refused")
    expect(down(null)).toBe(null)
  })
})
