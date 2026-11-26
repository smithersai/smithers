import { Cause, Effect, Exit, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as Flows from "../Flows.ts"
import * as Keys from "../SessionKeys.vibe"
import { runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import { SECRET, signInHarness } from "../test/signIn.ts"
import * as Cleanup from "./RevokeReplacedGitHubToken.vibe"

const runtime = testFile("replaced_tokens")
const query = <A extends object>(f: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, f))
beforeEach(async () => { await query(sql => sql`TRUNCATE sessions, sign_in_attempts, people, github_token_cleanups CASCADE`) })
const setup = async () => {
  const h = await signInHarness(runtime)
  const first = await h.signInAs()
  const started = await h.start()
  await h.callback(h.github.approve(started.location), { ...first.cookies, smithers_sign_in: started.cookies.smithers_sign_in!.value })
  const [row] = await query(sql => sql<{ id: string }>`SELECT id FROM github_token_cleanups`)
  expect(row).toBeDefined()
  const services = { keys: await runtime.runPromise(Keys.make(Redacted.make(SECRET))), github: h.github.service }
  const database = (await runtime.runPromise(TestDatabase.Scratch)).database
  return { h, first, id: row!.id, services, database }
}

test("the durable cleanup flow clears ciphertext, retains the digest, and never ends the session", async () => {
  const s = await setup()
  const result = await runFlow(Cleanup.RevokeReplacedGitHubToken, { cleanupId: s.id }, Cleanup.registration(s.database, s.services))
  expect(result.exit).toEqual(Exit.succeed({ outcome: "revoked" }))
  expect(s.h.github.accepts(s.h.github.issued[0]!.accessToken)).toBe(false)
  expect(s.h.github.accepts(s.h.github.issued[1]!.accessToken)).toBe(true)
  expect(await query(sql => sql`SELECT pair_digest FROM github_token_cleanups WHERE id = ${s.id} AND finished_at IS NOT NULL AND sealed_access IS NULL AND sealed_refresh IS NULL`)).toHaveLength(1)
  expect(await s.h.session(s.first.cookies)).toMatchObject({ signedIn: true })
  const before = s.h.github.calls.filter(c => c === "revoke").length
  expect(await runtime.runPromise(Cleanup.revoke(s.id, s.services))).toEqual({ outcome: "none" })
  expect(s.h.github.calls.filter(c => c === "revoke")).toHaveLength(before)
})

test.each(["unavailable", "misconfigured"] as const)("a %s GitHub failure preserves the sealed pair until recovery", async reason => {
  const s = await setup()
  s.h.github.faults.revoke = reason
  const failed = await runtime.runPromiseExit(Cleanup.revoke(s.id, s.services))
  expect(Exit.isFailure(failed)).toBe(true)
  expect(await query(sql => sql`SELECT id FROM github_token_cleanups WHERE id = ${s.id} AND sealed_access IS NOT NULL AND finished_at IS NULL`)).toHaveLength(1)
  delete s.h.github.faults.revoke
  expect(await runtime.runPromise(Cleanup.revoke(s.id, s.services))).toEqual({ outcome: "revoked" })
  expect(await s.h.session(s.first.cookies)).toMatchObject({ signedIn: true })
})

test("an unreadable seal is retained, so restoring the pinned key can recover cleanup", async () => {
  const s = await setup()
  const other = await runtime.runPromise(Keys.make(Redacted.make("other-secret".padEnd(64, "4"))))
  const result = await runtime.runPromiseExit(Cleanup.revoke(s.id, { ...s.services, keys: other }))
  expect(Exit.isFailure(result) ? Cause.squash(result.cause) : null).toMatchObject({ reason: "unreadable" })
  expect(await query(sql => sql`SELECT id FROM github_token_cleanups WHERE id = ${s.id} AND finished_at IS NULL`)).toHaveLength(1)
  await runtime.runPromise(Cleanup.revoke(s.id, s.services))
})

test("a crash after GitHub revokes but before the tombstone commits replays an already-gone token successfully", async () => {
  const s = await setup()
  s.h.github.revoke(s.h.github.issued[0]!.accessToken)
  expect(await runtime.runPromise(Cleanup.revoke(s.id, s.services))).toEqual({ outcome: "revoked" })
  expect(await s.h.session(s.first.cookies)).toMatchObject({ signedIn: true })
})

test("the durable sweeper restarts only aged unfinished rows under cleanup execution ids", async () => {
  const s = await setup()
  await query(sql => sql`UPDATE github_token_cleanups SET created_at = now() - interval '6 minutes'`)
  const starts: Array<{ id: string; cleanupId: string }> = []
  const registration = Cleanup.registration(s.database, s.services).pipe(Layer.provide(Layer.succeed(Flows.FlowStarter, {
    start: (_flow, request) => Effect.sync(() => { starts.push({ id: request.executionId, cleanupId: (request.payload as { cleanupId: string }).cleanupId }) }),
  })))
  const result = await runFlow(Cleanup.SweepReplacedGitHubTokens, { from: 0, until: 300000 }, registration)
  expect(result.exit).toEqual(Exit.succeed({ pending: 1 }))
  expect(starts).toEqual([{ id: Cleanup.executionId(s.id), cleanupId: s.id }])
  await runtime.runPromise(Cleanup.revoke(s.id, s.services))
  expect(await runtime.runPromise(Cleanup.sweep())).toEqual([])
})

test("rejects malformed ciphertext and finishes a cleanup with no access token", async () => {
  const s = await setup()
  const revokes = () => s.h.github.calls.filter(call => call === "revoke").length
  const before = revokes()
  await query(sql => sql`UPDATE github_token_cleanups SET sealed_access = '{}'::jsonb WHERE id = ${s.id}`)
  const malformed = await runtime.runPromiseExit(Cleanup.revoke(s.id, s.services))
  expect(Exit.isFailure(malformed) && Cause.squash(malformed.cause)).toMatchObject({ reason: "unreadable" })
  expect(await query(sql => sql`SELECT id FROM github_token_cleanups WHERE id = ${s.id} AND finished_at IS NULL`)).toHaveLength(1)
  await query(sql => sql`UPDATE github_token_cleanups SET sealed_access = NULL WHERE id = ${s.id}`)
  expect(await runtime.runPromise(Cleanup.revoke(s.id, s.services))).toEqual({ outcome: "revoked" })
  expect(await query(sql => sql`SELECT id FROM github_token_cleanups
    WHERE id = ${s.id} AND finished_at IS NOT NULL AND sealed_refresh IS NULL`)).toHaveLength(1)
  expect(revokes()).toBe(before)
})

test.each(["unavailable", "misconfigured", "unreadable", "database"] as const)(
  "the registered cleanup retries a transient %s failure before clearing the receipt",
  async (fault) => {
    const s = await setup()
    const wrongKeys = await runtime.runPromise(Keys.make(Redacted.make("other-secret".padEnd(64, "4"))))
    let opens = 0
    let databaseAttempts = 0
    const keys = s.services.keys
    const services = {
      ...s.services,
      keys: {
        ...keys,
        open: (...args: Parameters<typeof keys.open>) => Effect.suspend(() =>
          (++opens === 1 && fault === "unreadable" ? wrongKeys : keys).open(...args)),
      },
    }
    const database = Layer.unwrap(Effect.suspend(() =>
      ++databaseAttempts === 1 && fault === "database" ? Effect.fail("database unavailable") : Effect.succeed(s.database)))
    if (fault === "unavailable" || fault === "misconfigured") s.h.github.failOnce.revoke = fault
    const before = s.h.github.calls.filter(call => call === "revoke").length
    const ran = await runFlow(Cleanup.RevokeReplacedGitHubToken, { cleanupId: s.id }, Cleanup.registration(database, services))
    expect(ran.exit).toEqual(Exit.succeed({ outcome: "revoked" }))
    expect(databaseAttempts).toBe(2)
    expect(opens).toBe(fault === "database" ? 1 : 2)
    expect(s.h.github.calls.filter(call => call === "revoke").length - before)
      .toBe(fault === "unavailable" || fault === "misconfigured" ? 2 : 1)
    expect(await query(sql => sql`SELECT id FROM github_token_cleanups
      WHERE id = ${s.id} AND finished_at IS NOT NULL AND sealed_access IS NULL AND sealed_refresh IS NULL`)).toHaveLength(1)
  },
)
