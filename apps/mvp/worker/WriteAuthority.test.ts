// A write's retained sign-in authority (worker/WriteAuthority.vibe), judged inside the writing transaction against this
// file's own schema of the compose Postgres.
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { testFile } from "./test/harness.ts"
import * as WriteAuthority from "./WriteAuthority.vibe"
import { SigningKeyIds } from "./SessionStore.vibe"

const runtime = testFile("write_authority")
const sql = (query: string) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(query)))
const inTransaction = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.withTransaction(effect))
    .pipe(Effect.provideService(SigningKeyIds, ["legacy"])))

const signedIn = async () => {
  const personId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  await sql(`INSERT INTO people (id, github_id, github_login) VALUES ('${personId}', ${Math.floor(Math.random() * 1e12)}, 'writer')`)
  await sql(`INSERT INTO sessions (id, person_id, token_digest, role, role_checked_at, expires_at)
    VALUES ('${sessionId}', '${personId}', '${sessionId}', 'admin', now(), now() + interval '1 day')`)
  return { personId, sessionId }
}

test("an alias whose host session row is gone holds no authority, though its parent session is live", async () => {
  const session = await signedIn()
  expect(await inTransaction(WriteAuthority.holds(session))).toBe(true)
  expect(await inTransaction(WriteAuthority.holds({ ...session, alias: crypto.randomUUID() }))).toBe(false)
})

test("admission: explicit local authority holds, a missing legacy authority fails closed, a session is judged", async () => {
  expect(await inTransaction(WriteAuthority.admitted(null))).toBe(true)
  expect(await inTransaction(WriteAuthority.admitted(undefined))).toBe(false)
  const session = await signedIn()
  expect(await inTransaction(WriteAuthority.admitted(session))).toBe(true)
  await sql(`UPDATE sessions SET revoked_at = now(), revoked_reason = 'sign_out' WHERE id = '${session.sessionId}'`)
  expect(await inTransaction(WriteAuthority.admitted(session))).toBe(false)
})
