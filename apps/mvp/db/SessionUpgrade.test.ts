import { TestSchemas } from "@smthrs/database"
import { Effect, Redacted } from "effect"
import { Migrator, SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import * as Rotation from "../worker/SessionSigningKeys.ts"
import * as Database from "./Database.ts"
import * as TestDatabase from "./TestDatabase.ts"

const sessionSteps = [
  "session_deadlines", "session_signing_keys", "session_reauthentication", "session_tags",
  "session_ends", "session_key_fingerprints", "compromised_session_keys", "session_seal_fingerprint",
]

test("every published migration has a unique numeric identity", () => {
  const ids = Object.keys(Database.migrations).map((name) => Number(name.slice(0, 4)))
  expect(new Set(ids).size).toBe(ids.length)
})

test("upgrades main's issue-tree schema without skipping session migrations or replacing existing rows", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const server = yield* TestDatabase.serverUrl
    const schema = TestSchemas.schemaName("session_upgrade")
    const admin = Database.layer(Effect.succeed(Redacted.make(server.toString())))
    yield* Effect.acquireRelease(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql`CREATE SCHEMA ${sql(schema)}`).pipe(Effect.provide(admin)),
      () => Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DROP SCHEMA ${sql(schema)} CASCADE`).pipe(
        Effect.provide(admin), Effect.orDie,
      ),
    )
    const connection = new URL(server)
    connection.searchParams.set("options", `-c search_path=${schema}`)
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      // Main has already published 0108_issue_tree. None of this lane's session steps has run there.
      const published = Object.fromEntries(Object.entries(Database.migrations).filter(([name]) =>
        Number(name.slice(0, 4)) <= 108 && !sessionSteps.includes(name.slice(5))))
      const initial = yield* Migrator.make({})({ loader: Migrator.fromRecord(published) })
      expect(initial.at(-1)).toEqual([108, "issue_tree"])
      const [person, session, alias] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
      yield* sql`INSERT INTO people (id, github_id, github_login) VALUES (${person}, 1, 'upgrade')`
      yield* sql`INSERT INTO sessions (id, token_digest, person_id, role, role_checked_at, created_at, expires_at)
        VALUES (${session}, 'upgrade-home', ${person}, 'member', now(), now() - interval '1 day', now() + interval '1 day')`
      yield* sql`INSERT INTO host_sessions (id, token_digest, parent_id, host, created_at)
        VALUES (${alias}, 'upgrade-alias', ${session}, 'alias.example.test', now() - interval '12 hours')`
      yield* sql`INSERT INTO issue_relations (child_id, child_repo_id, parent_id, parent_repo_id, observed_at)
        VALUES ('github/upgrade/repo#2', 'github/upgrade/repo', 'github/upgrade/repo#1', 'github/upgrade/repo', now())`

      expect(yield* Database.migrate).toEqual(sessionSteps.map((name, index) => [109 + index, name]))
      expect(yield* Database.migrate).toEqual([])
      expect(yield* sql`SELECT child_id, parent_id FROM issue_relations`).toEqual([
        { child_id: "github/upgrade/repo#2", parent_id: "github/upgrade/repo#1" },
      ])
      const home = yield* sql`SELECT id, started_at = created_at AS original_start, cookie_key,
        github_token_gen, github_pair_digest, session_tag FROM sessions WHERE id = ${session}`
      const host = yield* sql`SELECT id, parent_id, started_at = created_at AS original_start, cookie_key,
        session_tag FROM host_sessions WHERE id = ${alias}`
      expect(home).toEqual([{ id: session, original_start: true, cookie_key: "legacy", github_token_gen: 0,
        github_pair_digest: null, session_tag: expect.stringMatching(/^[a-f0-9]{32}$/) }])
      expect(host).toEqual([{ id: alias, parent_id: session, original_start: true, cookie_key: "legacy",
        session_tag: expect.stringMatching(/^[a-f0-9]{32}$/) }])
      expect(home[0]!.session_tag).not.toBe(host[0]!.session_tag)
      expect(yield* sql`SELECT key_id, state, fingerprint FROM session_signing_keys`).toEqual([
        { key_id: "legacy", state: "issuer", fingerprint: null },
      ])
      expect(yield* sql`SELECT id, fingerprint FROM session_seal_key`).toEqual([{ id: true, fingerprint: null }])
      expect(yield* sql`SELECT * FROM session_end_receipts`).toEqual([])
      expect(yield* sql`SELECT * FROM github_token_cleanups`).toEqual([])
      expect(yield* sql`SELECT * FROM person_role_receipts`).toEqual([])
      const secret = Redacted.make("upgrade-deployment-secret".padEnd(64, "x"))
      const changed = Redacted.make("different-deployment-secret".padEnd(64, "x"))
      expect(yield* Effect.result(Rotation.gate({ legacy: secret }, secret))).toMatchObject({ _tag: "Success" })
      expect(yield* sql`SELECT fingerprint FROM session_signing_keys`).toEqual([{ fingerprint: yield* Rotation.fingerprint(secret) }])
      expect(yield* sql`SELECT fingerprint FROM session_seal_key`).toEqual([{ fingerprint: yield* Rotation.sealFingerprint(secret) }])
      expect(yield* sql`SELECT id FROM sessions WHERE revoked_at IS NULL`).toEqual([{ id: session }])
      expect(yield* sql`SELECT id FROM host_sessions WHERE revoked_at IS NULL`).toEqual([{ id: alias }])
      expect(yield* Effect.result(Rotation.gate({ legacy: changed }, secret))).toMatchObject({
        _tag: "Failure", failure: { reason: "fingerprint" },
      })
      expect(yield* Effect.result(Rotation.gate({ legacy: secret }, changed))).toMatchObject({
        _tag: "Failure", failure: { reason: "seal_fingerprint" },
      })
    }).pipe(Effect.provide(Database.layer(Effect.succeed(Redacted.make(connection.toString())))))
  })))
}, 60_000)
