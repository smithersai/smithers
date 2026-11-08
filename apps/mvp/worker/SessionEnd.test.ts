import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import * as Store from "./SessionStore.ts"
import { testFile } from "./test/harness.ts"
import { signInHarness } from "./test/signIn.ts"

const runtime = testFile("session_ends")
const query = <A extends object>(f: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, f))
beforeEach(() => query(sql => sql`TRUNCATE people, sessions, sign_in_attempts CASCADE`))
const fixture = async () => {
  const h = await signInHarness(runtime)
  const signed = await h.signInAs()
  const [row] = await query(sql => sql<{ id: string; tag: string; person: string }>`SELECT id, session_tag AS tag, person_id AS person FROM sessions`)
  const alias = crypto.randomUUID()
  await runtime.runPromise(Store.createHostSession({ id: alias, tokenDigest: alias, parentId: row!.id, host: "alias.test" }))
  return { h, signed, ...row!, alias }
}

for (const reason of ["sign_out", "github_refused", "unreadable"] as const) test(`endSession atomically moves tokens and records home and alias ends: ${reason}`, async () => {
  const f = await fixture()
  expect(Option.isSome(await runtime.runPromise(Store.revoke({ id: f.id }, reason)))).toBe(true)
  const [ended] = await query(sql => sql<{ revoked: boolean; access: unknown; refresh: unknown }>`SELECT revoked_at IS NOT NULL AS revoked, github_access AS access, github_refresh AS refresh FROM sessions WHERE id = ${f.id}`)
  expect(ended).toEqual({ revoked: true, access: null, refresh: null })
  const cleanups = await query(sql => sql`SELECT sealed_access, sealed_refresh FROM github_token_cleanups WHERE session_id = ${f.id}`)
  expect(cleanups).toHaveLength(1)
  expect(cleanups[0]!.sealed_access).not.toBeNull()
  const receipts = await query(sql => sql`SELECT session_tag, ended_at, reason FROM session_end_receipts WHERE session_tag IN (SELECT session_tag FROM sessions WHERE id = ${f.id} UNION ALL SELECT session_tag FROM host_sessions WHERE id = ${f.alias})`)
  expect(receipts).toHaveLength(2)
  expect(receipts.map(row => row.reason)).toEqual([reason, reason])
  expect(JSON.stringify(receipts)).not.toContain(f.person)
  expect(JSON.stringify(receipts)).not.toContain("octocat")
  expect(Option.isNone(await runtime.runPromise(Store.revoke({ id: f.id }, reason)))).toBe(true)
  expect(await query(sql => sql`SELECT id FROM github_token_cleanups WHERE session_id = ${f.id}`)).toHaveLength(1)
})

test("a stale role refusal leaves the newer generation and its alias live", async () => {
  const f = await fixture()
  await query(sql => sql`UPDATE sessions SET github_token_gen = 2 WHERE id = ${f.id}`)
  expect(Option.isNone(await runtime.runPromise(Store.revokeIf(f.id, "github_refused", 1)))).toBe(true)
  expect(await f.h.session(f.signed.cookies)).toMatchObject({ signedIn: true })
  expect(await query(sql => sql`SELECT id FROM host_sessions WHERE id = ${f.alias} AND revoked_at IS NULL`)).toHaveLength(1)
})

test("sweeping unread expiry clears tokens, ends aliases, and retains the newest demotion after erasure", async () => {
  const f = await fixture()
  await query(sql => sql`UPDATE sessions SET role = 'guest', role_generation = 9999, expires_at = now() - interval '31 days' WHERE id = ${f.id}`)
  await f.h.signInAs()
  await query(sql => sql`UPDATE sessions SET role = 'admin', role_generation = 1 WHERE id <> ${f.id}`)
  await runtime.runPromise(Store.sweepEnds())
  expect(await query(sql => sql`SELECT id FROM sessions WHERE id = ${f.id}`)).toHaveLength(0)
  expect(await query(sql => sql`SELECT id FROM host_sessions WHERE id = ${f.alias}`)).toHaveLength(0)
  const receipts = await query(sql => sql`SELECT reason FROM session_end_receipts WHERE session_tag = ${f.tag}`)
  expect(receipts).toEqual([{ reason: "expired" }])
  expect(await query(sql => sql`SELECT id FROM github_token_cleanups WHERE session_id = ${f.id} AND sealed_access IS NOT NULL`)).toHaveLength(1)
  const [role] = await query(sql => sql`SELECT ${Store.latestRole(sql, sql`${f.person}::uuid`)} AS role`)
  expect(role!.role).toBe("guest")
  await query(sql => sql`UPDATE session_end_receipts SET ended_at = now() - interval '400 days' - interval '1 second' WHERE session_tag = ${f.tag}`)
  await runtime.runPromise(Store.sweepEnds())
  expect(await query(sql => sql`SELECT session_tag FROM session_end_receipts WHERE session_tag = ${f.tag}`)).toHaveLength(0)
})

test("ending rolls back the row, aliases, cleanup and receipts together", async () => {
  const f = await fixture()
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql.withTransaction(Effect.gen(function* () {
    yield* Store.revoke({ id: f.id }, "sign_out")
    return yield* Effect.fail("rollback")
  })).pipe(Effect.ignore)))
  expect(await f.h.session(f.signed.cookies)).toMatchObject({ signedIn: true })
  expect(await query(sql => sql`SELECT id FROM github_token_cleanups WHERE session_id = ${f.id}`)).toHaveLength(0)
  expect(await query(sql => sql`SELECT session_tag FROM session_end_receipts WHERE session_tag = ${f.tag}`)).toHaveLength(0)
})

test("an alias terminal path finalizes an already expired parent and its credentials at the parent's actual end", async () => {
  const f = await fixture()
  await query(sql => sql`UPDATE sessions SET expires_at = now() - interval '1 day' WHERE id = ${f.id}`)
  expect(Option.isSome(await runtime.runPromise(Store.revokeHost(f.alias, "alias.test")))).toBe(true)
  expect(await query(sql => sql`SELECT id FROM sessions WHERE id = ${f.id} AND revoked_reason = 'expired'
    AND revoked_at = expires_at AND github_access IS NULL AND github_refresh IS NULL`)).toHaveLength(1)
  expect(await query(sql => sql`SELECT c.id FROM github_token_cleanups c WHERE c.session_id = ${f.id} AND sealed_access IS NOT NULL`)).toHaveLength(1)
  expect(await query(sql => sql`SELECT r.session_tag FROM session_end_receipts r JOIN sessions s ON s.id = ${f.id}
    WHERE r.reason = 'expired' AND r.ended_at = s.expires_at AND r.session_tag IN (s.session_tag,
      (SELECT session_tag FROM host_sessions WHERE id = ${f.alias}))`)).toHaveLength(2)
})


test("repeated sweeps do not rewrite unchanged ended home or alias rows", async () => {
  const f = await fixture()
  await runtime.runPromise(Store.revoke({ id: f.id }, "sign_out"))
  const versions = () => query(sql => sql`SELECT id, ctid::text, xmin::text FROM sessions WHERE id = ${f.id}
    UNION ALL SELECT id, ctid::text, xmin::text FROM host_sessions WHERE id = ${f.alias}`)
  const ended = await versions()
  await runtime.runPromise(Store.sweepEnds())
  await runtime.runPromise(Store.sweepEnds())
  expect(await versions()).toEqual(ended)
  expect(await query(sql => sql`SELECT id FROM github_token_cleanups WHERE session_id = ${f.id}`)).toHaveLength(1)
  expect(await query(sql => sql`SELECT reason FROM session_end_receipts WHERE session_tag = ${f.tag}`)).toEqual([{ reason: "sign_out" }])
})
