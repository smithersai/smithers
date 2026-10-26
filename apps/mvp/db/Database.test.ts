// The Postgres client layer, Hyperdrive's view of DATABASE_URL, and `pnpm db:migrate` (db/Database.ts, db/migrate.ts),
// against the compose Postgres in schemas of this file's own.
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { Effect, Logger, ManagedRuntime, Redacted, References } from "effect"
import { Migrator, SqlClient } from "effect/sql"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { digestSync } from "@smthrs/crypto"
import { renderSource } from "../src/features/flows-ui/source.ts"
import * as Database from "./Database.ts"
import * as TestDatabase from "./TestDatabase.ts"

const runtime = ManagedRuntime.make(TestDatabase.layer("database"))
beforeAll(() => runtime.runPromise(Effect.void))
afterAll(() => runtime.dispose())

describe("hyperdrive", () => {
  test("splits DATABASE_URL into Hyperdrive's origin, URL-decoded, and asks for TLS when the URL does", () => {
    const { origin, sslmode } = Database.hyperdrive(
      Redacted.make("postgresql://app%40team:p%2Fss%20word@db.example.com/my%20db?sslmode=require"),
    )
    expect({ ...origin, password: Redacted.value(origin.password) }).toEqual({
      scheme: "postgres",
      host: "db.example.com",
      port: 5432,
      database: "my db",
      user: "app@team",
      password: "p/ss word",
    })
    expect(sslmode).toBe("require")
  })

  test("keeps the URL's port, and connects without TLS unless the URL requires it", () => {
    const { origin, sslmode } = Database.hyperdrive(
      Redacted.make("postgresql://smithers:smithers@localhost:54321/smithers?sslmode=prefer"),
    )
    expect(origin).toMatchObject({ host: "localhost", port: 54321, database: "smithers", user: "smithers" })
    expect(sslmode).toBe("disable")
  })
})

/** A schema of its own, empty, for as long as `use` runs, and the compose Postgres URL that connects with it. */
const emptySchema = async <A>(use: (url: string, schema: string) => Promise<A>) => {
  const schema = `cli_${crypto.randomUUID().replaceAll("-", "")}`
  await sql(`CREATE SCHEMA ${schema}`)
  try {
    const url = await runtime.runPromise(TestDatabase.serverUrl)
    url.searchParams.set("options", `-c search_path=${schema}`)
    return await use(url.toString(), schema)
  } finally {
    await sql(`DROP SCHEMA ${schema} CASCADE`)
  }
}

const sql = (statement: string) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(statement)))

/** Whether `schema` has `messages` (1 or 0), and the step its positions take (0 before it is migrated). */
const migrated = async (schema: string) => {
  const [found] = await sql(`
    SELECT (SELECT count(*)::int FROM pg_tables WHERE schemaname = '${schema}' AND tablename = 'messages') AS messages,
      (SELECT coalesce(max(increment_by), 0)::int FROM pg_sequences WHERE schemaname = '${schema}') AS step`)
  return found
}

describe("layer", () => {
  test("prepares no statement by name, past the hundred a connection's statement cache keeps", async () => {
    const marker = `prepared_${crypto.randomUUID().replaceAll("-", "")}`
    const held = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        for (let index = 0; index < 150; index++) yield* sql.unsafe(`SELECT ${index} AS ${marker}`)
        return yield* sql<{ readonly count: number }>`SELECT count(*)::int AS count FROM pg_prepared_statements
          WHERE statement LIKE ${`%${marker}%`}`
      }).pipe(Effect.provide(Database.layer(Effect.map(TestDatabase.serverUrl, (url) => Redacted.make(url.toString()))))),
    )
    expect(held).toEqual([{ count: 0 }])
  })
})

describe("migrateAndReport", () => {
  test("applies what hasn't run and logs which, then logs that the database is up to date", () =>
    emptySchema(async (url) => {
      const lines: Array<{ readonly message: unknown; readonly applied: unknown }> = []
      const logger = Logger.make((options) => {
        const { applied } = options.fiber.getRef(References.CurrentLogAnnotations)
        lines.push({ message: options.message, applied })
      })
      const run = Database.migrateAndReport.pipe(
        Effect.provide(Database.layer(Effect.succeed(Redacted.make(url)))),
        Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      )
      await runtime.runPromise(run)
      await runtime.runPromise(run)
      expect(lines).toEqual([
        {
          message: ["db:migrate: applied"],
          // Every migration the migrator loads, in order, as `<id>_<name>`: `0028_clone_progress` logs `28_clone_progress`.
          applied: Object.keys(Database.migrations)
            .sort()
            .map((key) => `${Number(key.slice(0, 4))}_${key.slice(5)}`)
            .join(", "),
        },
        { message: ["db:migrate: up to date"], applied: "" },
      ])
    }))
})

describe("pnpm db:migrate", () => {
  const migrate = (url: string) =>
    promisify(execFile)(process.execPath, ["db/migrate.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url).href),
      env: { ...process.env, DATABASE_URL: url },
    })

  test("applies every migration to an empty database once, then reports it up to date", () =>
    emptySchema(async (url, schema) => {
      const first = await migrate(url)
      expect(first.stdout).toContain("db:migrate: applied")
      expect(first.stdout).toContain("1_messages, 2_answer_attempts, 3_paired_positions, 4_model_roles")
      const second = await migrate(url)
      expect(second.stdout).toContain("db:migrate: up to date")
      expect(await migrated(schema)).toEqual({ messages: 1, step: 2 })
    }))
})

/** Applies the migrations up to and including `last` (`"0008"`) that haven't run. */
const through = (last: string) =>
  Migrator.make({})({
    loader: Migrator.fromRecord(
      Object.fromEntries(Object.entries(Database.migrations).filter(([name]) => name.slice(0, 4) <= last)),
    ),
  })

describe("0008_browser_answering", () => {
  test("fails what ChatApi left streaming, drops its attempts and sweep index, and indexes the turn wait", () =>
    emptySchema(async (url, schema) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        runtime.runPromise(Effect.provide(effect, database))
      const earlier = Object.fromEntries(Object.entries(Database.migrations).filter(([name]) => name < "0008"))
      await on(Migrator.make({})({ loader: Migrator.fromRecord(earlier) }))
      // What ChatApi left: an answer it was still streaming on its first attempt, and one it finished.
      const [stuck, finished] = [crypto.randomUUID(), crypto.randomUUID()]
      const [asked, done] = [crypto.randomUUID(), crypto.randomUUID()]
      await on(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO messages (id, role, text, status) VALUES
          (${asked}, 'user', 'Still there?', 'done'), (${done}, 'user', 'Hello', 'done')`
        yield* sql`INSERT INTO messages (id, role, text, status, question_id, attempts) VALUES
          (${stuck}, 'assistant', 'Half an', 'streaming', ${asked}, 1),
          (${finished}, 'assistant', 'Hi.', 'done', ${done}, 1)`
      }))

      const applied = await on(through("0008"))

      expect(applied.map(([id, name]) => `${id}_${name}`)).toEqual(["8_browser_answering"])
      const rows = await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{ readonly id: string; readonly status: string; readonly failure: string | null; readonly text: string }>`
          SELECT id, status, failure, text FROM messages WHERE role = 'assistant' ORDER BY position`))
      expect(rows).toEqual([
        { id: stuck, status: "failed", failure: "abandoned", text: "Half an" },
        { id: finished, status: "done", failure: null, text: "Hi." },
      ])
      const [columns] = await sql(`
        SELECT count(*)::int AS attempts FROM information_schema.columns
        WHERE table_schema = '${schema}' AND table_name = 'messages' AND column_name = 'attempts'`)
      expect(columns).toEqual({ attempts: 0 })
      const indexes = await sql(`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = '${schema}' AND indexname LIKE 'messages_streaming%' ORDER BY indexname`)
      expect(indexes).toEqual([
        {
          indexname: "messages_streaming_position",
          indexdef: `CREATE INDEX messages_streaming_position ON ${schema}.messages USING btree ("position") ` +
            `WHERE (status = 'streaming'::text)`,
        },
      ])
    }))
})

describe("0009_clone_ids", () => {
  test("gives every row an attempt id of its own, and fails the clones started under the counter", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        runtime.runPromise(Effect.provide(effect, database))
      await on(through("0008"))
      // A clone still running under the counter, one ready and one failed.
      await on(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO repositories (id, owner, name, status, stored_bytes) VALUES
          ('github/a/cloning', 'a', 'cloning', 'cloning', 10)`
        yield* sql`INSERT INTO repositories (id, owner, name, status, head_sha, settled_at) VALUES
          ('github/a/ready', 'a', 'ready', 'ready', ${"a".repeat(40)}, now())`
        yield* sql`INSERT INTO repositories (id, owner, name, status, failure, attempt, settled_at) VALUES
          ('github/a/failed', 'a', 'failed', 'failed', 'not_found', 3, now())`
      }))

      const applied = await on(through("0009"))

      expect(applied.map(([id, name]) => `${id}_${name}`)).toEqual(["9_clone_ids"])
      const rows = await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{
          readonly id: string
          readonly status: string
          readonly failure: string | null
          readonly attempt: number
          readonly settled: boolean
          readonly cloneId: string
        }>`
          SELECT id, status, failure, attempt, settled_at IS NOT NULL AS settled, clone_id::text AS "cloneId"
          FROM repositories ORDER BY id`))
      expect(rows.map(({ cloneId: _, ...row }) => row)).toEqual([
        { id: "github/a/cloning", status: "failed", failure: "unavailable", attempt: 1, settled: true },
        { id: "github/a/failed", status: "failed", failure: "not_found", attempt: 3, settled: true },
        { id: "github/a/ready", status: "ready", failure: null, attempt: 1, settled: true },
      ])
      // A new row draws its own id too; none repeats.
      const [added] = await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{ readonly cloneId: string }>`
          INSERT INTO repositories (id, owner, name, status) VALUES ('github/a/new', 'a', 'new', 'cloning')
          RETURNING clone_id::text AS "cloneId"`))
      const ids = [...rows.map((row) => row.cloneId), added!.cloneId]
      for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      expect(new Set(ids).size).toBe(4)
    }))
})

describe("0010_views", () => {
  test("adds views that sit among the messages by the conversation's own sequence, never on a message's position", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        runtime.runPromise(Effect.provide(effect, database))
      await on(through("0009"))
      const [question, answer, view, refused] = [
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
      ]
      // A question and its answer before the table exists.
      await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`
          WITH q AS (INSERT INTO messages (id, role, text, status) VALUES (${question}, 'user', 'Hi', 'done') RETURNING position)
          INSERT INTO messages (id, role, status, question_id, position) OVERRIDING SYSTEM VALUE
          SELECT ${answer}, 'assistant', 'streaming', ${question}, position + 1 FROM q`))

      const applied = await on(through("0010"))

      expect(applied.map(([id, name]) => `${id}_${name}`)).toEqual(["10_views"])
      const [added] = await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{ readonly position: string }>`
          INSERT INTO views (id, template, props) VALUES (${view}, 'webpage', '{"url":"https://example.com/"}')
          RETURNING position::text AS position`))
      const positions = await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{ readonly position: string }>`SELECT position::text AS position FROM messages ORDER BY position`))
      // After the answer, on a position no message holds.
      expect(Number(added!.position)).toBeGreaterThan(Number(positions.at(-1)!.position))
      expect(positions.map((row) => row.position)).not.toContain(added!.position)
      // Only the two templates, and props that are an object.
      const rejected = await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        Effect.all([
          Effect.flip(sql`INSERT INTO views (id, template, props) VALUES (${refused}, 'iframe', '{}')`),
          Effect.flip(sql`INSERT INTO views (id, template, props) VALUES (${refused}, 'link', '[]')`),
        ])))
      expect(rejected.map((error) => error.reason._tag)).toEqual(["ConstraintError", "ConstraintError"])
    }))
})

describe("0011_question_askers", () => {
  test("adds the asker to questions only, and fails the answers no one may write any more", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        runtime.runPromise(Effect.provide(effect, database))
      await on(through("0010"))
      // Before askers: one answer still streaming, one finished.
      const [asked, stuck, done, finished] = [
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
      ]
      await on(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO messages (id, role, text, status) VALUES
          (${asked}, 'user', 'Still there?', 'done'), (${done}, 'user', 'Hello', 'done')`
        yield* sql`INSERT INTO messages (id, role, text, status, question_id) VALUES
          (${stuck}, 'assistant', 'Half an', 'streaming', ${asked}),
          (${finished}, 'assistant', 'Hi.', 'done', ${done})`
      }))

      const applied = await on(through("0011"))

      expect(applied.map(([id, name]) => `${id}_${name}`)).toEqual(["11_question_askers"])
      const rows = await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{ readonly id: string; readonly status: string; readonly failure: string | null; readonly askedBy: null }>`
          SELECT id, status, failure, asked_by AS "askedBy" FROM messages ORDER BY position`))
      expect(rows).toEqual([
        { id: asked, status: "done", failure: null, askedBy: null },
        { id: done, status: "done", failure: null, askedBy: null },
        { id: stuck, status: "failed", failure: "abandoned", askedBy: null },
        { id: finished, status: "done", failure: null, askedBy: null },
      ])
      // A question records its asker; an answer can't.
      const [question, answer] = [crypto.randomUUID(), crypto.randomUUID()]
      await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`INSERT INTO messages (id, role, text, status, asked_by) VALUES (${question}, 'user', 'Mine', 'done', 'p-1')`))
      const refused = await on(Effect.flip(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`INSERT INTO messages (id, role, status, question_id, asked_by)
          VALUES (${answer}, 'assistant', 'streaming', ${question}, 'p-1')`)))
      expect(refused.reason._tag).toBe("ConstraintError")
    }))
})

describe("0012_model_reservations", () => {
  test("settles every earlier call, seeds each day's counter from them, and keeps the counter from going negative", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        runtime.runPromise(Effect.provide(effect, database))
      await on(through("0011"))
      // Three calls metered before reservations: two today (UTC), one two days ago.
      await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`
          INSERT INTO model_usage (invocation_id, request_id, role, model_id, input_tokens, output_tokens, created_at)
          VALUES ('a', 'r', 'agent', 'm', 10, 5, now()), ('b', 'r', 'agent', 'm', 1, 2, now()),
            ('c', 'r', 'judge', 'm', 100, 0, now() - interval '2 days')`))

      const applied = await on(through("0012"))

      expect(applied.map(([id, name]) => `${id}_${name}`)).toEqual(["12_model_reservations"])
      const rows = await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{ readonly id: string; readonly days: number; readonly reserved: number; readonly settled: boolean }>`
          SELECT invocation_id AS id, ((now() AT TIME ZONE 'UTC')::date - day) AS days, reserved_tokens AS reserved,
            settled_at = created_at AS settled
          FROM model_usage ORDER BY invocation_id`))
      expect(rows).toEqual([
        { id: "a", days: 0, reserved: 0, settled: true },
        { id: "b", days: 0, reserved: 0, settled: true },
        { id: "c", days: 2, reserved: 0, settled: true },
      ])
      const counters = await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{ readonly days: number; readonly committed: string }>`
          SELECT ((now() AT TIME ZONE 'UTC')::date - day) AS days, committed::text AS committed
          FROM model_budget_days ORDER BY day DESC`))
      expect(counters).toEqual([{ days: 0, committed: "18" }, { days: 2, committed: "100" }])
      const refused = await on(Effect.flip(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`UPDATE model_budget_days SET committed = -1`)))
      expect(refused.reason._tag).toBe("ConstraintError")
    }))
})

describe("0017_model_charges", () => {
  test("charges each earlier call what it settled to, or its reservation while open, and expires it after an hour", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        runtime.runPromise(Effect.provide(effect, database))
      await on(through("0016"))
      // One call settled to 15 of the 100 it reserved, and one still open with 40 reserved.
      await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`
          INSERT INTO model_usage (invocation_id, request_id, role, model_id, input_tokens, output_tokens, day,
            reserved_tokens, settled_at)
          VALUES ('settled', 'r', 'agent', 'm', 10, 5, (now() AT TIME ZONE 'UTC')::date, 100, now()),
            ('open', 'r', 'agent', 'm', 0, 0, (now() AT TIME ZONE 'UTC')::date, 40, NULL)`))

      const applied = await on(through("0017"))

      expect(applied.map(([id, name]) => `${id}_${name}`)).toEqual(["17_model_charges"])
      const rows = await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{ readonly id: string; readonly charged: number; readonly expiresInSeconds: number }>`
          SELECT invocation_id AS id, charged_tokens AS charged,
            extract(epoch FROM expires_at - created_at)::int AS "expiresInSeconds"
          FROM model_usage ORDER BY invocation_id`))
      expect(rows).toEqual([
        { id: "open", charged: 40, expiresInSeconds: 3_600 },
        { id: "settled", charged: 15, expiresInSeconds: 3_600 },
      ])
      const refused = await on(Effect.flip(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`UPDATE model_usage SET charged_tokens = -1`)))
      expect(refused.reason._tag).toBe("ConstraintError")
    }))
})

describe("0018_triage", () => {
  test("existing issues read proposed until their next read, which the cleared cursor brings; triage writes are taken", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        runtime.runPromise(Effect.provide(effect, database))
      await on(through("0017"))
      await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`
          INSERT INTO items (id, repo_id, number, kind, github_id, title, state, created_at, updated_at,
            source_updated_at, fetched_at)
          VALUES ('github/a/b#1', 'github/a/b', 1, 'issue', 1, 't', 'open', now(), now(), now(), now())`))
      await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`INSERT INTO github_sync (repo_id, stream, cursor) VALUES ('github/a/b', 'issues', 'c1'), ('github/a/b', 'other', 'c2')`))

      const applied = await on(through("0018"))

      expect(applied.map(([id, name]) => `${id}_${name}`)).toEqual(["18_triage"])
      const sql = <A extends object>(statement: string) =>
        on(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe<A>(statement)))
      expect(await sql(`SELECT triage, triage_pinned AS pinned FROM items`)).toEqual([{ triage: "proposed", pinned: false }])
      expect(await sql(`SELECT stream, cursor FROM github_sync ORDER BY stream`)).toEqual([
        { stream: "issues", cursor: null },
        { stream: "other", cursor: "c2" },
      ])
      const hash = "0".repeat(64)
      // Run triage again and Pause need no person's session; a person's override does.
      await sql(`
        INSERT INTO github_writes (id, repo_id, actor_id, session_id, via, op, payload, payload_hash)
        VALUES ('00000000-0000-4000-8000-000000000001', 'github/a/b', 'p', NULL, 'person', 'triage/run', '{}', '${hash}')`)
      const refused = async (statement: string) =>
        (await on(Effect.flip(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(statement))))).reason._tag
      expect(await refused(`
        INSERT INTO github_writes (id, repo_id, actor_id, session_id, via, op, payload, payload_hash)
        VALUES ('00000000-0000-4000-8000-000000000002', 'github/a/b', 'p', NULL, 'person', 'issue/triage', '{}', '${hash}')`))
        .toBe("ConstraintError")
      expect(await refused(`UPDATE items SET triage = 'maybe'`)).toBe("ConstraintError")
      expect(await refused(`
        INSERT INTO triage_settings (repo_id, enabled_by, enabled_at, paused, paused_reason, daily_tokens)
        VALUES ('github/a/b', 'p', now(), true, NULL, 10)`)).toBe("ConstraintError")
      expect(await refused(`
        INSERT INTO triage_decisions (id, repo_id, item_id, number, via, decision, abstained)
        VALUES ('00000000-0000-4000-8000-000000000003', 'github/a/b', 'github/a/b#1', 1, 'flow', 'accept', 'budget')`))
        .toBe("ConstraintError")
    }))
})

describe("0019_spend_alerts", () => {
  test("marks every earlier call as carried, so the first alert reports only later spend; alert rows are bounded", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        runtime.runPromise(Effect.provide(effect, database))
      await on(through("0018"))
      await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`
          INSERT INTO model_usage (invocation_id, request_id, role, model_id, input_tokens, output_tokens, day,
            reserved_tokens, charged_tokens, expires_at, settled_at)
          VALUES ('earlier', 'r', 'agent', 'm', 10, 5, (now() AT TIME ZONE 'UTC')::date, 100, 15, now(), now())`))

      const applied = await on(through("0019"))

      expect(applied.map(([id, name]) => `${id}_${name}`)).toEqual(["19_spend_alerts"])
      const sql = <A extends object>(statement: string) =>
        on(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe<A>(statement)))
      expect(await sql(`SELECT spend_alert_id AS carried FROM model_usage`)).toEqual([{ carried: "before_spend_alerts" }])
      const refused = async (statement: string) =>
        (await on(Effect.flip(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(statement))))).reason._tag
      const alert = (overrides: string) => `
        INSERT INTO spend_alerts (id, window_start, window_end, calls, tokens, cost_usd, roles, day_tokens, budget)
        SELECT * FROM (SELECT 'a'::text, now(), now() + interval '15 minutes', 1, 10::bigint, 0.5::float8,
          '[]'::jsonb, 10::bigint, 100::bigint) v ${overrides}`
      await sql(alert(""))
      expect(await sql(`SELECT kind, audience FROM spend_alerts`)).toEqual([{ kind: "model", audience: "admin" }])
      expect(await refused(`UPDATE spend_alerts SET calls = 0`)).toBe("ConstraintError")
      expect(await refused(`UPDATE spend_alerts SET window_end = window_start`)).toBe("ConstraintError")
      expect(await refused(`UPDATE spend_alerts SET roles = '{}'`)).toBe("ConstraintError")
      expect(await refused(`UPDATE spend_alerts SET audience = 'everyone'`)).toBe("ConstraintError")
      expect(await refused(`UPDATE spend_alerts SET budget = 0`)).toBe("ConstraintError")
    }))
})

describe("0021_secrets", () => {
  test("keeps sealed values by repository and name, bounded bindings, and an audit that names its actor or its guest", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        runtime.runPromise(Effect.provide(effect, database))
      await on(through("0020"))

      const applied = await on(through("0021"))

      expect(applied.map(([id, name]) => `${id}_${name}`)).toEqual(["21_secrets"])
      const sql = <A extends object>(statement: string) =>
        on(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe<A>(statement)))
      const refused = async (statement: string) =>
        (await on(Effect.flip(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(statement))))).reason._tag
      const secret = (name: string, hosts: string, methods = "NULL") => `
        INSERT INTO secrets (repo_id, name, ciphertext, nonce, key_version, hosts, methods, updated_by)
        VALUES ('github/a/b', '${name}', 'c', 'n', 1, ${hosts}, ${methods}, 'p')`
      await sql(secret("API_KEY", "ARRAY['api.example.com']"))
      expect(await sql(`SELECT name, hosts, methods FROM secrets`)).toEqual([
        { name: "API_KEY", hosts: ["api.example.com"], methods: null },
      ])
      expect(await refused(secret("API_KEY", "ARRAY['other.example.com']"))).toBe("UniqueViolation")
      expect(await refused(secret("api_key", "ARRAY['a.com']"))).toBe("ConstraintError")
      expect(await refused(secret("EMPTY", "ARRAY[]::text[]"))).toBe("ConstraintError")
      expect(await refused(secret("NO_METHODS", "ARRAY['a.com']", "ARRAY[]::text[]"))).toBe("ConstraintError")
      expect(await refused(`UPDATE secrets SET key_version = 0`)).toBe("ConstraintError")
      await sql(`
        INSERT INTO secret_events (repo_id, action, names, actor_id, invocation_key)
        VALUES ('github/a/b', 'set', ARRAY['API_KEY'], 'p', 'k1')`)
      await sql(`
        INSERT INTO secret_events (repo_id, action, names, scope, host, method, outcome)
        VALUES ('github/a/b', 'use', ARRAY['API_KEY'], 'b:1', 'api.example.com', 'GET', 'forwarded')`)
      expect(await refused(`
        INSERT INTO secret_events (repo_id, action, names, actor_id, invocation_key)
        VALUES ('github/a/b', 'set', ARRAY['API_KEY'], 'p', 'k1')`)).toBe("UniqueViolation")
      expect(await refused(`INSERT INTO secret_events (repo_id, action) VALUES ('github/a/b', 'set')`))
        .toBe("ConstraintError")
      expect(await refused(`INSERT INTO secret_events (repo_id, action, host) VALUES ('github/a/b', 'use', 'a.com')`))
        .toBe("ConstraintError")
      expect(await refused(`
        INSERT INTO secret_events (repo_id, action, actor_id, invocation_key) VALUES ('github/a/b', 'read', 'p', 'k2')`))
        .toBe("ConstraintError")
    }))
})

describe("0022_todos", () => {
  test("a TODO is placed exactly while open; positions are unique per stack at each statement's end; bounds hold", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        runtime.runPromise(Effect.provide(effect, database))
      await on(through("0021"))

      const applied = await on(through("0022"))

      expect(applied.map(([id, name]) => `${id}_${name}`)).toEqual(["22_todos"])
      const sql = <A extends object>(statement: string) =>
        on(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe<A>(statement)))
      const refused = async (statement: string) =>
        (await on(Effect.flip(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(statement))))).reason._tag
      await sql(`INSERT INTO stacks (repo_id) VALUES ('github/a/b')`)
      expect(await sql(`SELECT next_number AS "next", version::int AS version, lanes, max_open AS "maxOpen" FROM stacks`))
        .toEqual([{ next: 1, version: 0, lanes: 1, maxOpen: 50 }])
      const todo = (n: number, fields = `'queued', ${n}, NULL`) => `
        INSERT INTO todos (id, repo_id, number, title, state, position, settled_at, created_by, created_login)
        VALUES ('00000000-0000-4000-8000-00000000000${n}', 'github/a/b', ${n}, 'T${n}', ${fields}, 'p', 'maya')`
      await sql(todo(1))
      await sql(todo(2))
      await sql(todo(3))
      // Closing a gap in one statement: each row passes through a position another holds.
      await sql(`UPDATE todos SET state = 'dropped', position = NULL, settled_at = now() WHERE number = 1`)
      await sql(`UPDATE todos SET position = position - 1 WHERE position IS NOT NULL`)
      expect(await sql(`SELECT number, position FROM todos ORDER BY number`)).toEqual([
        { number: 1, position: null },
        { number: 2, position: 1 },
        { number: 3, position: 2 },
      ])
      expect(await refused(`UPDATE todos SET position = 1 WHERE number = 3`)).toBe("UniqueViolation")
      expect(await refused(todo(4, `'queued', NULL, NULL`))).toBe("ConstraintError")
      expect(await refused(todo(5, `'merged', 3, now()`))).toBe("ConstraintError")
      expect(await refused(todo(6, `'dropped', NULL, NULL`))).toBe("ConstraintError")
      expect(await refused(todo(2, `'queued', 3, NULL`).replace("00000000002", "00000000009"))).toBe("UniqueViolation")
      expect(await refused(`UPDATE todos SET title = '  ' WHERE number = 2`)).toBe("ConstraintError")
      expect(await refused(`UPDATE todos SET state = 'paused' WHERE number = 2`)).toBe("ConstraintError")
      const request = (acceptance: string) => `
        INSERT INTO todo_requests (todo_id, revision, repo_id, prompt, acceptance, by_login)
        VALUES ('00000000-0000-4000-8000-000000000002', 1, 'github/a/b', 'Do it', ${acceptance}, 'maya')`
      await sql(request(`ARRAY['done']`))
      expect(await refused(request(`ARRAY['again']`))).toBe("UniqueViolation")
      expect(await refused(request(`array_fill('x'::text, ARRAY[21])`).replace(", 1, 'github", ", 2, 'github")))
        .toBe("ConstraintError")
      const op = (fields: string) => `
        INSERT INTO stack_ops (id, repo_id, actor_id, via, op, payload_hash, outcome, result)
        VALUES (gen_random_uuid(), 'github/a/b', 'p', ${fields}, '{}')`
      await sql(op(`'person', 'commit', '${"0".repeat(64)}', 'committed'`))
      expect(await refused(op(`'robot', 'commit', '${"0".repeat(64)}', 'committed'`))).toBe("ConstraintError")
      expect(await refused(op(`'person', 'rename', '${"0".repeat(64)}', 'committed'`))).toBe("ConstraintError")
      expect(await refused(op(`'person', 'commit', 'not-a-hash', 'committed'`))).toBe("ConstraintError")
      expect(await refused(op(`'person', 'commit', '${"0".repeat(64)}', 'done'`))).toBe("ConstraintError")
    }))
})

describe("0025_flow_source", () => {
  /** A `SKILL.md` as 0015's prompt flows stored it (`renderSkill`, before 0025). */
  const skill = (name: string, description: string, flows: ReadonlyArray<string>, instructions: string) =>
    [
      "---",
      `name: ${name}`,
      `description: ${JSON.stringify(description)}`,
      "capabilities: []",
      ...(flows.length === 0 ? [] : ["flows:", ...flows.map((flow) => `  - ${JSON.stringify(flow)}`)]),
      "---",
      "",
      instructions.trim(),
      "",
    ].join("\n")

  /** The compose Postgres migrated through 0024 in a schema of its own, `rows` inserted, then 0025 applied. */
  const migrate = (
    rows: ReadonlyArray<string>,
    use: (sql: <A extends object>(statement: string) => Promise<ReadonlyArray<A>>) => Promise<void>,
  ) =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        runtime.runPromise(Effect.provide(effect, database))
      const sql = <A extends object>(statement: string) =>
        on(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe<A>(statement)))
      await on(through("0024"))
      for (const row of rows) await sql(row)
      const applied = await on(through("0025"))
      expect(applied.map(([id, name]) => `${id}_${name}`)).toEqual(["25_flow_source"])
      await use(sql)
    })

  const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`
  const flowId = "00000000-0000-4000-8000-000000000001"
  const notes = {
    name: "release-notes",
    description: "Summarize merged pull requests: since \"the\" last tag.",
    flows: ["repo/read", "repo/tree"],
    instructions: "Read the repository.\n\nThen summarize what merged.",
  }
  const draft = (id: number, status: string, files: string) => `
    INSERT INTO flow_drafts (id, actor_id, scope, request, status, files, checks)
    VALUES ('00000000-0000-4000-8000-00000000010${id}', 'p', 'person', 'Notes', '${status}', ${files}::jsonb,
      '[{"check": "parses", "ok": true}]'::jsonb)`
  const files = (...entries: ReadonlyArray<readonly [string, string]>) =>
    quoted(JSON.stringify(entries.map(([path, text]) => ({ path, text }))))

  test("every revision and draft becomes flow source that reads back as drafted; placement is client", () =>
    migrate(
      [
        `INSERT INTO flows (id, owner_id, name, revision, description) VALUES ('${flowId}', 'p', 'release-notes', 3, 'N')`,
        `INSERT INTO flow_revisions (flow_id, revision, digest, source, created_by) VALUES
          ('${flowId}', 1, '${"0".repeat(64)}', ${quoted(skill(notes.name, notes.description, notes.flows, notes.instructions))}, 'p'),
          ('${flowId}', 2, '${"0".repeat(64)}', ${quoted(skill(notes.name, "Plain.", [], "Go."))}, 'p'),
          ('${flowId}', 3, '${digestSync("export default 1")}', 'export default 1', 'p')`,
        draft(1, "ready", files(["SKILL.md", skill(notes.name, notes.description, notes.flows, notes.instructions)])),
        draft(2, "ready", "'[]'"),
        draft(3, "saved", files(["notes.md", "Kept."], ["SKILL.md", skill("other", "Other.", [], "Do.")])),
      ],
      async (sql) => {
        expect(await sql(`SELECT placement FROM flows`)).toEqual([{ placement: "client" }])
        const revisions = await sql<{ revision: number; digest: string; source: string }>(
          `SELECT revision, digest, source FROM flow_revisions ORDER BY revision`,
        )
        const first = renderSource(notes)
        const second = renderSource({ name: notes.name, description: "Plain.", flows: [], instructions: "Go." })
        expect(revisions).toEqual([
          { revision: 1, digest: digestSync(first), source: first },
          { revision: 2, digest: digestSync(second), source: second },
          // Already source: untouched.
          { revision: 3, digest: digestSync("export default 1"), source: "export default 1" },
        ])
        const drafts = await sql<{ status: string; files: unknown; checks: unknown }>(
          `SELECT status, files, checks FROM flow_drafts ORDER BY id`,
        )
        expect(drafts).toEqual([
          { status: "ready", files: [{ path: "flow.ts", text: first }], checks: [{ check: "parses", ok: true }] },
          { status: "ready", files: [], checks: [{ check: "parses", ok: true }] },
          {
            status: "saved",
            files: [
              { path: "notes.md", text: "Kept." },
              { path: "flow.ts", text: renderSource({ name: "other", description: "Other.", flows: [], instructions: "Do." }) },
            ],
            checks: [{ check: "parses", ok: true }],
          },
        ])
        // Placement holds only its two values.
        await sql(`UPDATE flows SET placement = 'sandbox'`)
        await expect(sql(`UPDATE flows SET placement = 'everywhere'`)).rejects.toBeDefined()
      },
    ))

  test("a draft whose SKILL.md doesn't read keeps no file: it fails migrated unless it was saved", () =>
    migrate(
      [
        draft(1, "needs_you", files(["SKILL.md", "No frontmatter."])),
        draft(2, "ready", files(["SKILL.md", "---\nname: x\n---\n\nNo description.\n"])),
        draft(3, "ready", files(["SKILL.md", "---\nname: \ndescription: \"D.\"\n---\n\nNo name.\n"])),
        draft(4, "ready", files(["SKILL.md", "---\nname: x\ndescription: \"broken\n---\n\nGo.\n"])),
        draft(5, "ready", files(["SKILL.md", "---\nname: x\ndescription: \"D.\"\nflows:\n  - \"broken\n---\n\nGo.\n"])),
        draft(6, "saved", files(["SKILL.md", "No frontmatter."])),
        draft(7, "proposed", files(["SKILL.md", "No frontmatter."])),
      ],
      async (sql) => {
        const failed = { status: "failed", failure: "migrated", files: [], checks: [] }
        expect(await sql(`SELECT status, failure, files, checks FROM flow_drafts ORDER BY id`)).toEqual([
          failed,
          failed,
          failed,
          failed,
          failed,
          { status: "saved", failure: null, files: [], checks: [{ check: "parses", ok: true }] },
          { status: "proposed", failure: null, files: [], checks: [{ check: "parses", ok: true }] },
        ])
      },
    ))

  test("a revision that doesn't read fails the migration, naming its flow and revision, never its text", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        runtime.runPromise(Effect.provide(effect, database))
      await on(through("0024"))
      await on(Effect.flatMap(SqlClient.SqlClient, (client) =>
        client.unsafe(`INSERT INTO flows (id, owner_id, name, revision, description) VALUES ('${flowId}', 'p', 'x', 1, 'X')`)))
      await on(Effect.flatMap(SqlClient.SqlClient, (client) =>
        client.unsafe(`
          INSERT INTO flow_revisions (flow_id, revision, digest, source, created_by)
          VALUES ('${flowId}', 1, '${"0".repeat(64)}', '---\nsecret canary\n---\n', 'p')`)))
      const failure = await on(through("0025")).then(() => "applied", (error: unknown) => String(error))
      expect(failure).toContain(`0025_flow_source: flow ${flowId} revision 1 doesn't read`)
      expect(failure).not.toContain("canary")
    }))
})

describe("0028_clone_progress", () => {
  test("ready copies are reclaimable unless the App is known installed; a running clone is fetching; clone entries fit", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        runtime.runPromise(Effect.provide(effect, database))
      await on(through("0027"))
      await on(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO repositories (id, owner, name, status, head_sha, settled_at) VALUES
          ('github/a/plain', 'a', 'plain', 'ready', ${"a".repeat(40)}, now()),
          ('github/a/installed', 'a', 'installed', 'ready', ${"b".repeat(40)}, now())`
        yield* sql`INSERT INTO repositories (id, owner, name, status) VALUES ('github/a/running', 'a', 'running', 'cloning')`
        yield* sql`INSERT INTO repositories (id, owner, name, status, failure, settled_at) VALUES
          ('github/a/failed', 'a', 'failed', 'failed', 'not_found', now())`
        yield* sql`INSERT INTO github_repositories (repo_id, installation_id) VALUES ('github/a/installed', 77)`
      }))

      const applied = await on(through("0028"))

      expect(applied.map(([id, name]) => `${id}_${name}`)).toEqual(["28_clone_progress"])
      const rows = await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{ readonly id: string; readonly stage: string | null; readonly reclaimable: boolean }>`
          SELECT id, stage, reclaimable FROM repositories ORDER BY id`))
      expect(rows).toEqual([
        { id: "github/a/failed", stage: null, reclaimable: false },
        { id: "github/a/installed", stage: null, reclaimable: false },
        { id: "github/a/plain", stage: null, reclaimable: true },
        { id: "github/a/running", stage: "fetching", reclaimable: false },
      ])
      // A clone's feed entry has a run's states; the repository events stay updates; nothing else is a kind.
      const insert = (kind: string, state: string) =>
        on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql`INSERT INTO notifications (recipient, subject, kind, state, href)
            VALUES ('ann', ${`${kind}:${state}:${crypto.randomUUID()}`}, ${kind}, ${state}, '/a/b')`)).then(
            () => "taken",
            () => "refused",
          )
      expect(await insert("clone", "working")).toBe("taken")
      expect(await insert("clone", "failed")).toBe("taken")
      expect(await insert("clone", "update")).toBe("refused")
      expect(await insert("main", "update")).toBe("taken")
      expect(await insert("main", "done")).toBe("refused")
      expect(await insert("tour", "update")).toBe("refused")
      // A stage only names how far a clone has come.
      const staged = await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`UPDATE repositories SET stage = 'pushing' WHERE id = 'github/a/running'`)).then(() => "taken", () => "refused")
      expect(staged).toBe("refused")
    }))
})

describe("0043_docs_views", () => {
  test("adds the docs template to views, keeps the others, and still refuses anything else", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        runtime.runPromise(Effect.provide(effect, database))
      await on(through("0042"))
      const insert = (template: string) =>
        on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql`INSERT INTO views (id, template, props, conversation_id)
            SELECT ${crypto.randomUUID()}, ${template}, '{"url":"https://docs.example/a.md"}', id FROM conversations LIMIT 1`))
          .then(() => "taken", () => "refused")
      expect(await insert("docs")).toBe("refused")

      const applied = await on(through("0043"))

      expect(applied.map(([id, name]) => `${id}_${name}`)).toEqual(["43_docs_views"])
      expect(await insert("docs")).toBe("taken")
      expect(await insert("webpage")).toBe("taken")
      expect(await insert("link")).toBe("taken")
      expect(await insert("iframe")).toBe("refused")
    }))
})

describe("0048_github_projection_fences", () => {
  test("upgrades legacy deletions and uncertain merge counters without resurrecting projections", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(Effect.provide(effect, database))
      await on(through("0042"))
      const old = "2026-01-01T00:00:00Z"
      const gone = "2026-01-02T00:00:00Z"
      const id = "github/acme/widgets#1"
      const head = "a".repeat(40)
      const write = crypto.randomUUID()
      await on(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO items (id, repo_id, number, kind, github_id, title, body, state,
          created_at, updated_at, source_updated_at, fetched_at, deleted_at)
          VALUES (${id}, 'github/acme/widgets', 1, 'pull', 1, 'Gone', '', 'closed',
            ${old}::timestamptz, ${old}::timestamptz, ${old}::timestamptz, ${old}::timestamptz, ${gone}::timestamptz)`
        yield* sql`INSERT INTO comments (id, repo_id, item_id, github_id, body, created_at, updated_at,
          source_updated_at, fetched_at, deleted_at)
          VALUES ('comment-1', 'github/acme/widgets', ${id}, 1, '', ${old}::timestamptz, ${old}::timestamptz,
            ${old}::timestamptz, ${old}::timestamptz, ${gone}::timestamptz)`
        yield* sql`INSERT INTO pulls (item_id, repo_id, number, head_ref, head_sha, base_ref, base_sha,
          source_updated_at, fetched_at)
          VALUES (${id}, 'github/acme/widgets', 1, 'feature', ${head}, 'main', ${head}, ${old}::timestamptz, ${old}::timestamptz)`
        yield* sql`INSERT INTO pull_commits (item_id, position, repo_id, sha, headline)
          VALUES (${id}, 1, 'github/acme/widgets', ${head}, 'Old')`
        yield* sql`INSERT INTO reviews (id, repo_id, item_id, github_id, state, fetched_at)
          VALUES ('review-1', 'github/acme/widgets', ${id}, 1, 'COMMENTED', ${old}::timestamptz)`
        yield* sql`INSERT INTO github_writes (id, repo_id, actor_id, session_id, via, op, payload, payload_hash, attempts)
          VALUES (${write}::uuid, 'github/acme/widgets', 'maya', ${crypto.randomUUID()}::uuid, 'person', 'pr/merge',
            ${JSON.stringify({ op: "pr/merge", number: 1, headSha: head, baseSha: head, method: "squash" })}::jsonb,
            ${"a".repeat(64)}, 3)`
      }))
      await on(through("0048"))
      const rows = await on(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const [row] = yield* sql<{ readonly gone: number; readonly comment: number; readonly pulls: number;
          readonly commits: number; readonly reviews: number; readonly mergeUnknown: boolean; readonly attempts: number }>`
          SELECT (extract(epoch FROM gone_at) * 1000)::float8 AS gone,
            (SELECT (extract(epoch FROM fetched_at) * 1000)::float8 FROM comments WHERE id = 'comment-1') AS comment,
            (SELECT count(*)::int FROM pulls) AS pulls, (SELECT count(*)::int FROM pull_commits) AS commits,
            (SELECT count(*)::int FROM reviews) AS reviews,
            (SELECT merge_unknown FROM github_writes WHERE id = ${write}::uuid) AS "mergeUnknown",
            (SELECT attempts FROM github_writes WHERE id = ${write}::uuid) AS attempts
          FROM github_projection_fences WHERE item_id = ${id}`
        return row
      }))
      expect(rows).toEqual({ gone: Date.parse(gone), comment: Date.parse(gone), pulls: 0, commits: 0,
        reviews: 0, mergeUnknown: false, attempts: 3 })
    }))
})


describe("0049–0050 GitHub write upgrade", () => {
  test("retains old triage decisions and writes, adds unclaimed starts and removes only the obsolete merge flag", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(Effect.provide(effect, database))
      await on(through("0048"))
      const decision = crypto.randomUUID()
      const write = crypto.randomUUID()
      await on(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO triage_decisions (id, repo_id, item_id, number, via, decision)
          VALUES (${decision}::uuid, 'github/acme/widgets', 'github/acme/widgets#1', 1, 'flow', 'accept')`
        yield* sql`INSERT INTO github_writes (id, repo_id, actor_id, session_id, via, op, payload, payload_hash, attempts, merge_unknown)
          VALUES (${write}::uuid, 'github/acme/widgets', 'maya', ${crypto.randomUUID()}::uuid, 'person', 'pr/merge',
            ${JSON.stringify({ op: "pr/merge", number: 1, headSha: "a".repeat(40), baseSha: "b".repeat(40), method: "squash" })}::jsonb,
            ${"a".repeat(64)}, 3, true)`
      }))
      expect((await on(through("0049"))).map(([id, name]) => `${id}_${name}`)).toEqual(["49_triage_write_claims"])
      const claims = () => on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        SELECT decision, label_started_at AS label, comment_started_at AS comment FROM triage_decisions
        WHERE id = ${decision}::uuid`))
      expect(await claims()).toEqual([{ decision: "accept", label: null, comment: null }])
      await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        UPDATE triage_decisions SET label_started_at = now(), comment_started_at = now() WHERE id = ${decision}::uuid`))
      const started = await claims()
      expect((await on(through("0050"))).map(([id, name]) => `${id}_${name}`)).toEqual(["50_drop_merge_unknown"])
      expect(await claims()).toEqual(started)
      expect(await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        SELECT attempts, status, payload->>'op' AS op, to_jsonb(w) ? 'merge_unknown' AS obsolete
        FROM github_writes w WHERE id = ${write}::uuid`))).toEqual([
          { attempts: 3, status: "pending", op: "pr/merge", obsolete: false },
        ])
      expect(await on(through("0050"))).toEqual([])
    }))
})


describe("0052_agent_views", () => {
  test("adds forms and generated views, each with what it needs, and questions that name the view they came from", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        runtime.runPromise(Effect.provide(effect, database))
      await on(through("0051"))
      const existingDocs = crypto.randomUUID()
      await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`INSERT INTO views (id, template, props, conversation_id)
          SELECT ${existingDocs}, 'docs', '{"url":"https://docs.example/guide.md","text":"# Guide"}', id
          FROM conversations LIMIT 1`))
      const applied = await on(through("0052"))
      expect(await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`SELECT template, props->>'text' AS text FROM views WHERE id = ${existingDocs}`)))
        .toEqual([{ template: "docs", text: "# Guide" }])
      expect(applied.map(([id, name]) => `${id}_${name}`)).toEqual(["52_agent_views"])
      const [home] = await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{ readonly id: string }>`SELECT id FROM conversations LIMIT 1`))
      const insert = (template: string, columns: Record<string, unknown>) =>
        on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql`INSERT INTO views ${sql.insert({ id: crypto.randomUUID(), template, conversation_id: home!.id, ...columns })}`))
          .then(() => "taken", () => "refused")
      const json = (value: unknown) => JSON.stringify(value)
      // A page keeps only its props; a form needs its state; a generated view its title, state, code, HTML and events.
      expect(await insert("docs", { props: json({ url: "https://docs.example/guide.md" }) })).toBe("taken")
      expect(await insert("webpage", { props: json({ url: "https://example.com/" }) })).toBe("taken")
      expect(await insert("link", { props: json({ url: "https://example.com/" }), state: json({}) })).toBe("refused")
      expect(await insert("form", { props: json({ title: "Clone" }), state: json({ submitted: false }) })).toBe("taken")
      expect(await insert("form", { props: json({ title: "Clone" }) })).toBe("refused")
      const generated = {
        props: json({}),
        title: "Tic-tac-toe",
        state: json({ cells: [] }),
        code: "export default function View() { return null }",
        html: "<div></div>",
        interactions: json({ cell: { kind: "state" } }),
      }
      expect(await insert("generated", generated)).toBe("taken")
      expect(await insert("generated", { ...generated, html: null })).toBe("refused")
      expect(await insert("generated", { ...generated, size: "huge" })).toBe("refused")
      expect(await insert("chart", generated)).toBe("refused")
      // Only a question names a view, and its values are an object.
      const ask = (role: string, data: unknown) =>
        on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql`INSERT INTO messages (id, role, text, status, conversation_id, source, data)
            VALUES (${crypto.randomUUID()}, ${role}, 'Clone', 'done', ${home!.id},
              ${json({ viewId: crypto.randomUUID(), event: "submit" })}, ${json(data)})`)).then(() => "taken", () => "refused")
      expect(await ask("user", { url: "https://github.com/a/b" })).toBe("taken")
      expect(await ask("assistant", { url: "https://github.com/a/b" })).toBe("refused")
      expect(await ask("user", ["a"])).toBe("refused")
    }))
})


describe("0055_branch_ref_namespace", () => {
  test("preserves existing branches, conversations, personal history and shares, defaults their namespace and rejects unknown namespaces", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(Effect.provide(effect, database))
      await on(through("0052"))
      const branchId = crypto.randomUUID()
      const conversationId = crypto.randomUUID()
      await on(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO branches (id, repo_id, name, created_by)
          VALUES (${branchId}, 'github/acme/widgets', 'existing', 'owner')`
        yield* sql`INSERT INTO conversations (id, repo_id, branch_id)
          VALUES (${conversationId}, 'github/acme/widgets', ${branchId})`
        yield* sql`INSERT INTO branch_shares (branch_id, grantee, login, access, shared_by)
          VALUES (${branchId}, 'viewer', 'viewer-login', 'view', 'owner')`
        yield* sql`INSERT INTO conversation_people (conversation_id, person_id, owner, repo, branch, archived_at)
          VALUES (${conversationId}, 'owner', 'acme', 'widgets', 'existing', NULL),
            (${conversationId}, 'viewer', 'acme', 'widgets', 'existing', '2026-10-23T12:00:00Z')`
      }))
      const snapshot = (hasNamespace: boolean) => on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        SELECT to_jsonb(b) - ${hasNamespace ? "ref_namespace" : ""} - ${hasNamespace ? "ref_forge" : ""} AS branch, to_jsonb(c) AS conversation,
          (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.grantee) FROM branch_shares s WHERE s.branch_id = b.id) AS shares,
          (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.person_id) FROM conversation_people p WHERE p.conversation_id = c.id) AS people
        FROM branches b JOIN conversations c ON c.branch_id = b.id ORDER BY b.id`))
      const before = await snapshot(false)

      expect((await on(through("0055"))).map(([id, name]) => `${id}_${name}`)).toEqual(["53_repo_runs", "54_message_pins", "55_branch_ref_namespace"])
      expect(await snapshot(true)).toEqual(before)
      expect(await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        SELECT DISTINCT ref_namespace AS namespace, ref_forge AS forge FROM branches`))).toEqual([{ namespace: "default", forge: "deployment" }])
      await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        UPDATE branches SET ref_namespace = 'ephemeral' WHERE id = ${branchId}`))
      expect(await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        SELECT id, ref_namespace AS namespace FROM branches WHERE id = ${branchId}`)))
        .toEqual([{ id: branchId, namespace: "ephemeral" }])
      for (const namespace of ["unknown", null]) {
        const refused = await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          UPDATE branches SET ref_namespace = ${namespace} WHERE id = ${branchId}`).pipe(Effect.result))
        expect(refused._tag).toBe("Failure")
      }
      await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        UPDATE branches SET ref_forge = 'github' WHERE id = ${branchId}`))
      expect(await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        SELECT ref_forge AS forge FROM branches WHERE id = ${branchId}`))).toEqual([{ forge: "github" }])
      for (const forge of ["unknown", null]) {
        const refused = await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          UPDATE branches SET ref_forge = ${forge} WHERE id = ${branchId}`).pipe(Effect.result))
        expect(refused._tag).toBe("Failure")
      }
      const request = crypto.randomUUID()
      await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        INSERT INTO github_branch_requests (id, person_id, actor, repo_id, owner, name, ref, sha)
        VALUES (${request}, 'owner', '{"subject":{"kind":"person","id":"owner"},"role":"member"}'::jsonb,
          'github/acme/widgets', 'acme', 'widgets', 'draft', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`))
      for (const failure of ["exists", "not_found", "not_configured", "forbidden"]) {
        await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE github_branch_requests SET failure = ${failure} WHERE id = ${request}`))
      }
      for (const failure of ["outcome_unknown", "unavailable", "unknown"]) {
        const refused = await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          UPDATE github_branch_requests SET failure = ${failure} WHERE id = ${request}`).pipe(Effect.result))
        expect(refused._tag).toBe("Failure")
      }
      expect(await on(through("0055"))).toEqual([])
    }))
})


describe("0056_personal_models", () => {
  test("adds the people's own models, their audit and their ledger, and holds a row to its rules", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(Effect.provide(effect, database))
      await on(through("0055"))
      expect((await on(through("0056"))).map(([id, name]) => `${id}_${name}`)).toEqual(["56_personal_models"])
      const save = (overrides: Record<string, unknown> = {}) => {
        const row = {
          person: "p",
          protocol: "openai-chat",
          baseUrl: "https://api.example.com",
          modelId: "m",
          last4: "abcd",
          status: null as number | null,
          failedAt: null as string | null,
          ...overrides,
        }
        return on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          INSERT INTO personal_models (person_id, protocol, base_url, model_id, ciphertext, nonce, key_version, key_last4,
            failure_status, failed_at)
          VALUES (${row.person}, ${row.protocol}, ${row.baseUrl}, ${row.modelId}, 'c', 'n', 1, ${row.last4},
            ${row.status}, ${row.failedAt}::timestamptz)`).pipe(Effect.as("taken"), Effect.orElseSucceed(() => "refused")))
      }
      expect(await save()).toBe("taken")
      expect(await save()).toBe("refused")
      expect(await save({ person: "q", protocol: "anthropic-messages", status: 401, failedAt: "2026-10-24T00:00:00Z" })).toBe("taken")
      for (
        const refused of [
          { protocol: "openai-responses" },
          { baseUrl: "http://api.example.com" },
          { modelId: "" },
          { modelId: "m".repeat(82) },
          { last4: "abcde" },
          { status: 401 },
          { failedAt: "2026-10-24T00:00:00Z" },
          { status: 200, failedAt: "2026-10-24T00:00:00Z" },
        ]
      ) {
        expect(await save({ person: crypto.randomUUID(), ...refused }), JSON.stringify(refused)).toBe("refused")
      }
      const event = (action: string, key: string) =>
        on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          INSERT INTO personal_model_events (person_id, action, invocation_key) VALUES ('p', ${action}, ${key})`)
          .pipe(Effect.as("taken"), Effect.orElseSucceed(() => "refused")))
      expect(await event("set", "k1")).toBe("taken")
      expect(await event("delete", "k1")).toBe("refused")
      expect(await event("use", "k2")).toBe("refused")
      const ledger = (outcome: string | null, tokens = 0) =>
        on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          INSERT INTO personal_model_usage (invocation_id, request_id, person_id, role, model_id, input_tokens, outcome)
          VALUES (${crypto.randomUUID()}, 'r', 'p', 'agent', 'm', ${tokens}, ${outcome})`)
          .pipe(Effect.as("taken"), Effect.orElseSucceed(() => "refused")))
      expect(await ledger(null)).toBe("taken")
      expect(await ledger("success", 5)).toBe("taken")
      expect(await ledger("unknown")).toBe("refused")
      expect(await ledger(null, -1)).toBe("refused")
      expect(await on(through("0056"))).toEqual([])
    }))
})

describe("0057_model_usage_outcome", () => {
  test("adds how each call ended to the ledger, empty on rows settled before it, and holds a row to its rules", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(Effect.provide(effect, database))
      await on(through("0056"))
      const insert = (id: string) =>
        on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          INSERT INTO model_usage (invocation_id, request_id, role, model_id, input_tokens, output_tokens, day,
            reserved_tokens, charged_tokens, expires_at)
          VALUES (${id}, 'r', 'agent', 'm', 0, 0, (now() AT TIME ZONE 'UTC')::date, 10, 10, now() + interval '1 hour')`))
      await insert("before")
      expect((await on(through("0057"))).map(([id, name]) => `${id}_${name}`)).toEqual(["57_model_usage_outcome"])
      const [before] = await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ readonly outcome: string | null }>`
        SELECT outcome FROM model_usage WHERE invocation_id = 'before'`))
      expect(before).toEqual({ outcome: null })
      const end = (fields: { outcome?: string; errorCode?: string; httpStatus?: number }) =>
        on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          UPDATE model_usage SET outcome = ${fields.outcome ?? null}, error_code = ${fields.errorCode ?? null},
            http_status = ${fields.httpStatus ?? null}
          WHERE invocation_id = 'before'`).pipe(Effect.as("taken"), Effect.orElseSucceed(() => "refused")))
      expect(await end({ outcome: "refused", errorCode: "quota_exceeded", httpStatus: 402 })).toBe("taken")
      for (const outcome of ["answered", "aborted", "failed"]) expect(await end({ outcome })).toBe("taken")
      for (
        const refused of [
          { outcome: "success" },
          { httpStatus: 99 },
          { httpStatus: 600 },
          { errorCode: "x".repeat(65) },
        ]
      ) {
        expect(await end(refused), JSON.stringify(refused)).toBe("refused")
      }
      expect(await on(through("0057"))).toEqual([])
    }))
})

describe("0058_hosted_model", () => {
  test("adds the Admin's one hosted-inference setting and its audit, and holds a row to its rules", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(Effect.provide(effect, database))
      await on(through("0057"))
      expect((await on(through("0058"))).map(([id, name]) => `${id}_${name}`)).toEqual(["58_hosted_model"])
      const write = (statement: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, unknown>) =>
        on(Effect.flatMap(SqlClient.SqlClient, statement).pipe(Effect.as("taken"), Effect.orElseSucceed(() => "refused")))
      expect(await write((sql) => sql`INSERT INTO hosted_model (enabled, updated_by) VALUES (true, 'person-admin')`)).toBe("taken")
      // At most one row.
      expect(await write((sql) => sql`INSERT INTO hosted_model (enabled, updated_by) VALUES (false, 'person-admin')`)).toBe("refused")
      expect(await write((sql) => sql`INSERT INTO hosted_model (id, enabled, updated_by) VALUES (false, false, 'x')`)).toBe("refused")
      expect(await write((sql) => sql`INSERT INTO hosted_model_changes (invocation_key, enabled, changed_by) VALUES ('k', true, 'a')`)).toBe("taken")
      expect(await write((sql) => sql`INSERT INTO hosted_model_changes (invocation_key, enabled, changed_by) VALUES ('k', false, 'a')`)).toBe("refused")
      expect(await on(through("0058"))).toEqual([])
    }))
})

describe("0059_model_quota_failure", () => {
  test("keeps existing failures and accepts terminal quota failures, refusing unknown reasons", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(Effect.provide(effect, database))
      await on(through("0058"))
      const id = crypto.randomUUID()
      const questionId = crypto.randomUUID()
      await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        INSERT INTO messages (id, role, text, status, conversation_id)
        SELECT ${questionId}, 'user', 'hi', 'done', id FROM conversations LIMIT 1`))
      await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        INSERT INTO messages (id, role, text, status, failure, question_id, conversation_id)
        SELECT ${id}, 'assistant', '', 'failed', 'model_error', ${questionId}, conversation_id FROM messages WHERE id = ${questionId}`))
      expect((await on(through("0059"))).map(([id, name]) => `${id}_${name}`)).toEqual(["59_model_quota_failure"])
      const set = (failure: string) => on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        UPDATE messages SET failure = ${failure} WHERE id = ${id} RETURNING failure`).pipe(Effect.result))
      for (const reason of ["quota", "rate_limited", "model_error", "empty", "abandoned", "unfinished"]) {
        expect((await set(reason))._tag).toBe("Success")
      }
      expect((await set("unknown"))._tag).toBe("Failure")
      expect(await on(through("0059"))).toEqual([])
    }))
})

describe("0061_flow_placement_machine", () => {
  test("a hand edit that was sandbox runs in the realm now; code that needs a machine stays sandbox", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(Effect.provide(effect, database))
      await on(through("0060"))
      const drafted = renderSource({ name: "drafted", description: "Drafted.", flows: [], instructions: "Go." })
      const relabelled = drafted.replace(`"drafted/agent"`, `"drafted/answer"`)
      const machine = `import { readFile } from "node:fs/promises"\n${relabelled}`
      // Each flow at revision 2; revision 1 of the edited one was machine code, which its latest revision no longer is.
      const flows = [
        ["00000000-0000-4000-8000-000000000001", "client", drafted, drafted],
        ["00000000-0000-4000-8000-000000000002", "sandbox", machine, relabelled],
        ["00000000-0000-4000-8000-000000000003", "sandbox", relabelled, machine],
      ] as const
      await on(Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        for (const [id, placement, first, latest] of flows) {
          yield* sql`INSERT INTO flows (id, owner_id, name, revision, description, placement)
            VALUES (${id}, 'p', ${`flow-${id.slice(-1)}`}, 2, 'D.', ${placement})`
          for (const [revision, source] of [[1, first], [2, latest]] as const) {
            yield* sql`INSERT INTO flow_revisions (flow_id, revision, digest, source, created_by)
              VALUES (${id}, ${revision}, ${digestSync(source)}, ${source}, 'p')`
          }
        }
      }))
      expect((await on(through("0061"))).map(([id, name]) => `${id}_${name}`)).toEqual(["61_flow_placement_machine"])
      const placements = await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{ readonly id: string; readonly placement: string }>`SELECT id, placement FROM flows ORDER BY id`))
      expect(placements.map((row) => row.placement)).toEqual(["client", "client", "sandbox"])
      expect(await on(through("0061"))).toEqual([])
    }))
})

describe("0062_sandbox_budgets", () => {
  test("adds the sandbox limits and ledger, a terminal's wait, and the bell's spend kind, each held to its rules", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(Effect.provide(effect, database))
      const taken = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        on(effect.pipe(Effect.as("taken"), Effect.orElseSucceed(() => "refused")))
      await on(through("0061"))
      expect((await on(through("0062"))).map(([id, name]) => `${id}_${name}`)).toEqual(["62_sandbox_budgets"])

      const limits = (awake: number, perPerson: number, alert: number, audience = "admin") =>
        taken(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          INSERT INTO sandbox_limits (audience, awake, awake_per_person, monthly_alert_usd, updated_by)
          VALUES (${audience}, ${awake}, ${perPerson}, ${alert}, 'p')
          ON CONFLICT (audience) DO UPDATE SET awake = EXCLUDED.awake`))
      expect(await limits(20, 2, 100)).toBe("taken")
      expect(await limits(1000, 100, 0)).toBe("taken")
      for (const [awake, perPerson, alert, audience] of [
        [0, 2, 100, "admin"],
        [1001, 2, 100, "admin"],
        [20, 0, 100, "admin"],
        [20, 101, 100, "admin"],
        [20, 2, -1, "admin"],
        [20, 2, 1_000_001, "admin"],
        [20, 2, 100, "member"],
      ] as const) {
        expect(await limits(awake, perPerson, alert, audience), JSON.stringify([awake, perPerson, alert, audience])).toBe("refused")
      }

      const slot = (branch: string, generation: number | null, instance: string | null, kind = "branch") =>
        taken(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          INSERT INTO sandbox_generations (branch_id, generation, kind, instance)
          VALUES (${branch}, ${generation}, ${kind}, ${instance})`))
      expect(await slot("a", null, null)).toBe("taken")
      // One open slot per branch.
      expect(await slot("a", 1, "standard-1")).toBe("refused")
      expect(await slot("b", 1, "standard-1", "todo")).toBe("taken")
      expect(await slot("c", 1, null)).toBe("refused")
      expect(await slot("d", null, "basic")).toBe("refused")
      expect(await slot("e", 0, "basic")).toBe("refused")
      expect(await slot("f", 1, "basic", "terminal")).toBe("refused")
      expect(await taken(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        UPDATE sandbox_generations SET ended_at = started_at - interval '1 second' WHERE branch_id = 'b'`))).toBe("refused")
      expect(await taken(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        UPDATE sandbox_generations SET ended_at = now() WHERE branch_id = 'a'`))).toBe("taken")
      // A branch whose slot closed opens another.
      expect(await slot("a", 2, "standard-1")).toBe("taken")

      const columns = await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ name: string; type: string; nullable: string; fallback: string | null }>`
        SELECT column_name AS name, data_type AS type, is_nullable AS nullable, column_default AS fallback
        FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'terminal_sessions' AND column_name IN ('waiting', 'admitted_at')
        ORDER BY column_name`))
      expect(columns).toEqual([
        { name: "admitted_at", type: "timestamp with time zone", nullable: "YES", fallback: null },
        { name: "waiting", type: "boolean", nullable: "NO", fallback: "false" },
      ])

      const notice = (kind: string, state: string) =>
        taken(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          INSERT INTO notifications (recipient, subject, kind, state, href)
          VALUES (${crypto.randomUUID()}, ${`s-${kind}-${state}`}, ${kind}, ${state}, '/app/settings')`))
      expect(await notice("spend", "update")).toBe("taken")
      expect(await notice("spend", "working")).toBe("refused")
      expect(await notice("budget", "update")).toBe("refused")
      expect(await notice("release", "update")).toBe("taken")
      expect(await on(through("0062"))).toEqual([])
    }))
})

describe("0063_app_template_views", () => {
  test("adds a repository's view and its issues view, which keep only their props, and keeps every row it had", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(Effect.provide(effect, database))
      await on(through("0062"))
      const [home] = await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{ readonly id: string }>`SELECT id FROM conversations LIMIT 1`))
      const json = (value: unknown) => JSON.stringify(value)
      const insert = (template: string, columns: Record<string, unknown>) =>
        on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql`INSERT INTO views ${sql.insert({ id: crypto.randomUUID(), template, conversation_id: home!.id, ...columns })}`))
          .then(() => "taken", () => "refused")
      // Before it, neither template is a view.
      expect(await insert("repo", { props: json({ repo: "octocat/Spoon-Knife" }) })).toBe("refused")
      const form = { props: json({ title: "Clone" }), state: json({ submitted: false }) }
      expect(await insert("form", form)).toBe("taken")
      expect((await on(through("0063"))).map(([id, name]) => `${id}_${name}`)).toEqual(["63_app_template_views"])
      expect(await insert("repo", { props: json({ repo: "octocat/Spoon-Knife", path: "README.md", kind: "blob" }) }))
        .toBe("taken")
      expect(await insert("issues", { props: json({ repo: "octocat/Spoon-Knife" }) })).toBe("taken")
      // Like a page, they keep nothing beyond their props.
      expect(await insert("repo", { props: json({ repo: "octocat/Spoon-Knife" }), state: json({}) })).toBe("refused")
      expect(await insert("issues", { props: json({ repo: "octocat/Spoon-Knife" }), html: "<p></p>" })).toBe("refused")
      // The other templates keep their rules.
      expect(await insert("form", form)).toBe("taken")
      expect(await insert("form", { props: json({ title: "Clone" }) })).toBe("refused")
      expect(await insert("webpage", { props: json({ url: "https://example.com/" }) })).toBe("taken")
      expect(await insert("generated", { props: json({}), state: json({}) })).toBe("refused")
      expect(await insert("chart", { props: json({}) })).toBe("refused")
      expect(await on(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`SELECT template, count(*)::int AS count FROM views GROUP BY template ORDER BY template`))).toEqual([
          { template: "form", count: 2 },
          { template: "issues", count: 1 },
          { template: "repo", count: 1 },
          { template: "webpage", count: 1 },
        ])
      expect(await on(through("0063"))).toEqual([])
    }))
})

describe("0064_bug_reports", () => {
  test("adds bug reports, each held to its bounds, and the bell's bug kind", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(Effect.provide(effect, database))
      const taken = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        on(effect.pipe(Effect.as("taken"), Effect.orElseSucceed(() => "refused")))
      await on(through("0063"))
      expect((await on(through("0064"))).map(([id, name]) => `${id}_${name}`)).toEqual(["64_bug_reports"])

      const report = (fields: { readonly what?: string; readonly route?: string | null; readonly actedBy?: string | null; readonly traces?: string } = {}) =>
        taken(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          INSERT INTO bug_reports (id, reporter_id, acted_by, what, route, build, traces, browser, viewport)
          VALUES (${crypto.randomUUID()}, 'p', ${fields.actedBy ?? null}, ${fields.what ?? "It broke."},
            ${fields.route === undefined ? "/app" : fields.route}, 'b1', ${fields.traces ?? "[]"}::jsonb, 'Firefox', '1280x800')`))
      expect(await report()).toBe("taken")
      expect(await report({ what: "x".repeat(4000), route: "/".repeat(2048), actedBy: "agent" })).toBe("taken")
      expect(await report({ route: null, actedBy: "sandbox" })).toBe("taken")
      expect(await report({ what: "" })).toBe("refused")
      expect(await report({ what: "x".repeat(4001) })).toBe("refused")
      expect(await report({ route: "/".repeat(2049) })).toBe("refused")
      expect(await report({ actedBy: "person" })).toBe("refused")
      expect(await report({ traces: "{}" })).toBe("refused")
      const [defaults] = await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ traces: unknown; runs: unknown; failures: unknown; fresh: boolean }>`
        SELECT traces, runs, failures, created_at > now() - interval '1 minute' AS fresh FROM bug_reports
        WHERE route IS NULL`))
      expect(defaults).toEqual({ traces: [], runs: [], failures: [], fresh: true })
      const identity = await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ identity: string }>`
        SELECT relreplident AS identity FROM pg_class WHERE oid = 'bug_reports'::regclass`))
      expect(identity).toEqual([{ identity: "f" }])

      const notice = (kind: string, state: string) =>
        taken(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          INSERT INTO notifications (recipient, subject, kind, state, href)
          VALUES (${crypto.randomUUID()}, ${`s-${kind}-${state}`}, ${kind}, ${state}, '/app/bugs')`))
      expect(await notice("bug", "update")).toBe("taken")
      expect(await notice("bug", "working")).toBe("refused")
      expect(await notice("spend", "update")).toBe("taken")
      expect(await notice("release", "update")).toBe("taken")
      expect(await notice("report", "update")).toBe("refused")
      expect(await on(through("0064"))).toEqual([])
    }))
})

describe("0065_model_tiers", () => {
  test("keeps a saved model as the person's fast model, keys a person's models by protocol, and holds tiers to their rules", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(Effect.provide(effect, database))
      const taken = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        on(effect.pipe(Effect.as("taken"), Effect.orElseSucceed(() => "refused")))
      await on(through("0064"))
      await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        INSERT INTO personal_models (person_id, protocol, base_url, model_id, ciphertext, nonce, key_version, key_last4)
        VALUES ('p', 'openai-chat', 'https://api.example.com', 'm-1', 'c', 'n', 1, 'abcd')`))
      expect((await on(through("0065"))).map(([id, name]) => `${id}_${name}`)).toEqual(["65_model_tiers"])
      const rows = await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        SELECT person_id AS "personId", protocol, fast_model AS "fastModel", implement_model AS "implementModel",
          hard_model AS "hardModel" FROM personal_models`))
      expect(rows).toEqual([
        { personId: "p", protocol: "openai-chat", fastModel: "m-1", implementModel: null, hardModel: null },
      ])
      const save = (overrides: Record<string, unknown> = {}) => {
        const row = { person: "p", protocol: "anthropic-messages", fast: null, implement: null, hard: "h", ...overrides }
        return taken(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          INSERT INTO personal_models (person_id, protocol, base_url, fast_model, implement_model, hard_model, ciphertext,
            nonce, key_version, key_last4)
          VALUES (${row.person}, ${row.protocol}, 'https://api.example.com', ${row.fast}, ${row.implement}, ${row.hard},
            'c', 'n', 1, 'abcd')`))
      }
      // A second protocol is a second key; the same protocol twice is not.
      expect(await save()).toBe("taken")
      expect(await save()).toBe("refused")
      expect(await save({ person: "q", protocol: "openai-chat", fast: null, hard: null })).toBe("taken")
      for (const refused of [{ fast: "" }, { implement: "m".repeat(82) }, { hard: "" }]) {
        expect(await save({ person: crypto.randomUUID(), ...refused }), JSON.stringify(refused)).toBe("refused")
      }
      const ledger = (protocol: string | null, tier: string | null) =>
        taken(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          INSERT INTO personal_model_usage (invocation_id, request_id, person_id, role, model_id, protocol, tier)
          VALUES (${crypto.randomUUID()}, 'r', 'p', 'agent', 'm', ${protocol}, ${tier})`))
      expect(await ledger(null, null)).toBe("taken")
      expect(await ledger("anthropic-messages", "hard")).toBe("taken")
      expect(await ledger("openai-responses", "fast")).toBe("refused")
      expect(await ledger("openai-chat", "strong")).toBe("refused")
      const role = (name: string) =>
        taken(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          INSERT INTO model_roles (role, model, updated_by) VALUES (${name}, '{}'::jsonb, 'admin')`))
      expect(await role("review")).toBe("taken")
      expect(await role("plan")).toBe("taken")
      expect(await role("strong")).toBe("refused")
      expect(await on(through("0065"))).toEqual([])
    }))
})

describe("0066_timeline_summaries", () => {
  test("adds a message's summary with its revision, and claims one per message revision that leave with the message", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(Effect.provide(effect, database))
      const taken = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        on(effect.pipe(Effect.as("taken"), Effect.orElseSucceed(() => "refused")))
      await on(through("0065"))
      const id = crypto.randomUUID()
      await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        INSERT INTO messages (id, role, text, status, conversation_id)
        SELECT ${id}, 'user', 'hi', 'done', id FROM conversations LIMIT 1`))
      expect((await on(through("0066"))).map(([id, name]) => `${id}_${name}`)).toEqual(["66_timeline_summaries"])

      const summarize = (summary: string | null, revision: string | null) =>
        taken(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          UPDATE messages SET summary = ${summary}, summary_revision = ${revision} WHERE id = ${id}`))
      expect(await summarize("Release regression found", "r1")).toBe("taken")
      expect(await summarize(null, null)).toBe("taken")
      for (const [summary, revision] of [["Lone summary", null], [null, "r1"], ["", "r1"], ["x".repeat(97), "r1"], ["ok", "r".repeat(129)]] as const) {
        expect(await summarize(summary, revision), JSON.stringify([summary, revision])).toBe("refused")
      }

      const claim = (revision: string, reason: string) =>
        taken(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          INSERT INTO timeline_summaries (message_id, revision, person_id, reason) VALUES (${id}, ${revision}, 'p', ${reason})`))
      expect(await claim("r1", "long_answer")).toBe("taken")
      // One claim per message revision, whoever asks.
      expect(await claim("r1", "multiline_answer")).toBe("refused")
      expect(await claim("r2", "multiline_answer")).toBe("taken")
      expect(await claim("r3", "words")).toBe("refused")
      expect(await taken(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        INSERT INTO timeline_summaries (message_id, revision, person_id, reason)
        VALUES (${crypto.randomUUID()}, 'r1', 'p', 'long_answer')`))).toBe("refused")
      await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DELETE FROM messages WHERE id = ${id}`))
      expect(await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT count(*)::int AS n FROM timeline_summaries`)))
        .toEqual([{ n: 0 }])
      expect(await on(through("0066"))).toEqual([])
    }))
})

describe("0067_bug_report_errors", () => {
  test("gives every report its error records, an array, empty for one filed before", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(Effect.provide(effect, database))
      const taken = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        on(effect.pipe(Effect.as("taken"), Effect.orElseSucceed(() => "refused")))
      await on(through("0066"))
      const before = crypto.randomUUID()
      await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        INSERT INTO bug_reports (id, reporter_id, what, build, browser, viewport)
        VALUES (${before}, 'p', 'Before.', 'b1', 'Firefox', '1280x800')`))
      expect((await on(through("0067"))).map(([id, name]) => `${id}_${name}`)).toEqual(["67_bug_report_errors"])
      const [old] = await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ errors: unknown }>`
        SELECT errors FROM bug_reports WHERE id = ${before}`))
      expect(old).toEqual({ errors: [] })
      const report = (errors: string) =>
        taken(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          INSERT INTO bug_reports (id, reporter_id, what, build, errors, browser, viewport)
          VALUES (${crypto.randomUUID()}, 'p', 'It broke.', 'b1', ${errors}::jsonb, 'Firefox', '1280x800')`))
      expect(await report('[{"at":"2026-10-25T20:00:00.000Z","kind":"http","name":"GET /api/runs","code":"503","traceId":null}]'))
        .toBe("taken")
      expect(await report("{}")).toBe("refused")
      expect(await on(through("0067"))).toEqual([])
    }))
})

describe("0068_branch_publish", () => {
  test("takes Publish and Update branch as git writes, and holds a branch's one publication to its rules", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(Effect.provide(effect, database))
      await on(through("0067"))
      expect((await on(through("0068"))).map(([id, name]) => `${id}_${name}`)).toEqual(["68_branch_publish"])
      const attempt = (statement: Effect.Effect<unknown, unknown, SqlClient.SqlClient>) =>
        on(statement.pipe(Effect.as("taken"), Effect.orElseSucceed(() => "refused")))
      const hash = "0".repeat(64)
      const write = (op: string, failure: string | null = null, branch: string | null = crypto.randomUUID()) =>
        attempt(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          INSERT INTO github_writes (id, repo_id, actor_id, session_id, via, op, payload, payload_hash, status, failure, branch_id, settled_at)
          VALUES (${crypto.randomUUID()}, 'github/acme/widgets', 'p', ${crypto.randomUUID()}, 'person', ${op}, '{}',
            ${hash}, ${failure === null ? "pending" : "refused"}, ${failure}, ${branch}::uuid, ${failure === null ? null : new Date().toISOString()}::timestamptz)`))
      expect(await write("branch/publish")).toBe("taken")
      expect(await write("branch/update")).toBe("taken")
      expect(await write("branch/push")).toBe("refused")
      for (const failure of ["empty_change", "too_large", "not_published", "base_missing", "conflict", "merged"]) {
        expect(await write("branch/publish", failure), failure).toBe("taken")
      }
      expect(await write("branch/publish", "stale")).toBe("refused")
      expect(await write("branch/publish", "published")).toBe("refused")
      // A Publish or an Update names its branch; no other write does.
      expect(await write("branch/update", null, null)).toBe("refused")
      expect(await write("issue/create")).toBe("refused")
      expect(await write("issue/create", null, null)).toBe("taken")
      // One Publish of a branch on its way at a time; a settled one never blocks the next.
      const publishOf = (branch: string, status: string) =>
        attempt(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          INSERT INTO github_writes (id, repo_id, actor_id, session_id, via, op, payload, payload_hash, status, failure, branch_id, settled_at)
          VALUES (${crypto.randomUUID()}, 'github/acme/widgets', 'p', ${crypto.randomUUID()}, 'person', 'branch/publish',
            '{}', ${hash}, ${status}, ${status === "refused" ? "empty_change" : null}, ${branch}::uuid,
            ${status === "pending" ? null : new Date().toISOString()}::timestamptz)`))
      const once = crypto.randomUUID()
      expect(await publishOf(once, "refused")).toBe("taken")
      expect(await publishOf(once, "done")).toBe("taken")
      expect(await publishOf(once, "pending")).toBe("taken")
      expect(await publishOf(once, "pending")).toBe("refused")
      expect(await publishOf(once, "done")).toBe("taken")
      const branchId = crypto.randomUUID()
      await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        INSERT INTO branches (id, repo_id, name, created_by) VALUES (${branchId}, 'github/acme/widgets', 'try-1', 'p')`))
      const sha = "a".repeat(40)
      const publish = (overrides: Record<string, unknown> = {}) => {
        const row = { branch: branchId, ref: "try-1-0123456789ab", baseSha: sha, headSha: sha, pr: 7, state: null as string | null, pushed: "{}", pushedSha: sha, ...overrides }
        return attempt(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          INSERT INTO branch_publications (branch_id, repo_id, github_ref, base_ref, base_sha, head_sha, pr_number, write_id, update_state, pushed, pushed_sha)
          VALUES (${row.branch}, 'github/acme/widgets', ${row.ref}, 'main', ${row.baseSha}, ${row.headSha}, ${row.pr},
            ${crypto.randomUUID()}, ${row.state}, ${row.pushed}::jsonb, ${row.pushedSha})`))
      }
      expect(await publish({ branch: crypto.randomUUID() })).toBe("refused")
      for (const refused of [{ ref: "" }, { baseSha: "main" }, { headSha: "A".repeat(40) }, { pr: 0 }, { state: "behind" }, { pushed: "[]" }, { pushedSha: "x" }]) {
        expect(await publish(refused), JSON.stringify(refused)).toBe("refused")
      }
      expect(await publish({ state: "conflict" })).toBe("taken")
      expect(await publish()).toBe("refused")
      expect(await on(through("0068"))).toEqual([])
    }))
})

describe("0069_branch_resync", () => {
  test("takes Resync as a branch's write, one pending per branch, and keeps how the working copy follows GitHub", () =>
    emptySchema(async (url) => {
      const database = Database.layer(Effect.succeed(Redacted.make(url)))
      const on = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(Effect.provide(effect, database))
      await on(through("0068"))
      expect((await on(through("0069"))).map(([id, name]) => `${id}_${name}`)).toEqual(["69_branch_resync"])
      const attempt = (statement: Effect.Effect<unknown, unknown, SqlClient.SqlClient>) =>
        on(statement.pipe(Effect.as("taken"), Effect.orElseSucceed(() => "refused")))
      const hash = "0".repeat(64)
      const write = (op: string, branch: string | null, status = "pending") =>
        attempt(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          INSERT INTO github_writes (id, repo_id, actor_id, session_id, via, op, payload, payload_hash, status, failure, branch_id, settled_at)
          VALUES (${crypto.randomUUID()}, 'github/acme/widgets', 'p', ${crypto.randomUUID()}, 'person', ${op}, '{}',
            ${hash}, ${status}, ${status === "refused" ? "conflict" : null}, ${branch}::uuid,
            ${status === "pending" ? null : new Date().toISOString()}::timestamptz)`))
      const once = crypto.randomUUID()
      expect(await write("branch/resync", null)).toBe("refused")
      expect(await write("branch/resync", once)).toBe("taken")
      expect(await write("branch/resync", once)).toBe("refused")
      expect(await write("branch/resync", once, "refused")).toBe("taken")
      // A Publish and an Update keep their own rules beside it.
      expect(await write("branch/publish", once)).toBe("taken")
      expect(await write("branch/update", once)).toBe("taken")
      expect(await write("branch/sync", once)).toBe("refused")
      const branchId = crypto.randomUUID()
      await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        INSERT INTO branches (id, repo_id, name, created_by) VALUES (${branchId}, 'github/acme/widgets', 'try-1', 'p')`))
      const sha = "a".repeat(40)
      await on(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
        INSERT INTO branch_publications (branch_id, repo_id, github_ref, base_ref, base_sha, head_sha, pr_number, write_id, pushed_sha)
        VALUES (${branchId}, 'github/acme/widgets', 'try-1-0123456789ab', 'main', ${sha}, ${sha}, 7, ${crypto.randomUUID()}, ${sha})`))
      const set = (fields: Record<string, string | null>) =>
        attempt(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`
          UPDATE branch_publications SET synced_sha = ${fields.syncedSha ?? null}, sync_state = ${fields.state ?? null},
            sync_conflicts = ${fields.conflicts ?? null}::jsonb, syncing = ${fields.syncing ?? null}::jsonb
          WHERE branch_id = ${branchId}`))
      expect(await set({ syncedSha: sha, state: "synced" })).toBe("taken")
      expect(await set({ state: "conflict", conflicts: '["a.ts"]', syncing: '{"a.ts":"x"}' })).toBe("taken")
      expect(await set({})).toBe("taken")
      const refusals: ReadonlyArray<Record<string, string>> = [{ syncedSha: "main" }, { state: "behind" }, { conflicts: '{"a":1}' }, { syncing: "[]" }]
      for (const refused of refusals) {
        expect(await set(refused), JSON.stringify(refused)).toBe("refused")
      }
      expect(await on(through("0069"))).toEqual([])
    }))
})
