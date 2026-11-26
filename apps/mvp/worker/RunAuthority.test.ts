// The locks a run start or stop takes before it judges its authority (worker/RunAuthority.vibe), on real Postgres: the
// person's row, the session's, and the alias's. Each missing row refuses as `authentication` before any role is read.
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import type { Actor } from "./Actor.vibe"
import { stillAdmitted } from "./RunAuthority.vibe"
import { testFile } from "./test/harness.ts"

const runtime = testFile("run_authority")
const sql = (query: string) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(query)))

/** A person with a live session and an alias under it. */
const signedIn = async () => {
  const personId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  const alias = crypto.randomUUID()
  await sql(`INSERT INTO people (id, github_id, github_login) VALUES ('${personId}', ${Math.floor(Math.random() * 1e12)}, 'locked')`)
  await sql(`INSERT INTO sessions (id, person_id, token_digest, role, role_checked_at, expires_at)
    VALUES ('${sessionId}', '${personId}', '${sessionId}', 'member', now(), now() + interval '1 day')`)
  await sql(`INSERT INTO host_sessions (id, token_digest, parent_id, host) VALUES ('${alias}', '${alias}', '${sessionId}', 'alias.example.test')`)
  return { personId, sessionId, alias }
}

const judge = (actor: Actor) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) =>
    client.withTransaction(stillAdmitted(actor, { role: "member", held: Option.none() }))))

test.each(["person", "session", "alias"] as const)("a missing %s row refuses as authentication", async (missing) => {
  const { personId, sessionId, alias } = await signedIn()
  const actor: Actor = {
    subject: { kind: "person", id: missing === "person" ? crypto.randomUUID() : personId },
    role: "member",
    session: missing === "session" ? crypto.randomUUID() : sessionId,
    alias: missing === "alias" ? crypto.randomUUID() : alias,
  }
  expect(await judge(actor)).toBe("authentication")
})
