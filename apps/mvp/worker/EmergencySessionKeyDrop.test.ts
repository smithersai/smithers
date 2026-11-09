import { Deferred, Effect, Exit, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import * as Rotation from "./SessionSigningKeys.ts"
import * as Flows from "./flows/SessionSigningKeys.ts"
import * as Store from "./SessionStore.ts"
import * as Prior from "./SessionPrior.ts"
import * as TestDatabase from "../db/TestDatabase.ts"
import { testFile } from "./test/harness.ts"
import { runFlow } from "./test/flowHost.ts"
import { configured, SECRET, setCookies, signInHarness } from "./test/signIn.ts"
import { sourceText } from "../../../packages/repo-targets/test-utils/source-readers.mjs"

const runtime = testFile("emergency_key_drop")
const query = <A extends object>(f: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, f))
beforeEach(async () => {
  await query(sql => sql`TRUNCATE people, sessions, sign_in_attempts CASCADE`)
  await query(sql => sql`DELETE FROM session_signing_keys`)
  await query(sql => sql`INSERT INTO session_signing_keys (key_id, state, promoted_at) VALUES ('legacy', 'issuer', now())`)
})
const NEXT = "emergency-replacement-secret".padEnd(64, "2")
const secrets = { legacy: Redacted.make(SECRET), next: Redacted.make(NEXT) }
const config = { ...configured, SESSION_SECRETS: JSON.stringify({ legacy: SECRET, next: NEXT }), SESSION_SEAL_SECRET: SECRET }
const fixture = async () => {
  const h = await signInHarness(runtime, { config })
  const signed = await h.signInAs()
  const [row] = await query(sql => sql<{ id: string; tag: string }>`SELECT id, session_tag AS tag FROM sessions ORDER BY created_at DESC LIMIT 1`)
  await runtime.runPromise(Rotation.gate({ legacy: secrets.legacy }, secrets.legacy))
  const alias = crypto.randomUUID()
  await runtime.runPromise(Store.createHostSession({ id: alias, tokenDigest: alias, parentId: row!.id, host: "alias.test" }))
  const [a] = await query(sql => sql<{ tag: string }>`SELECT session_tag AS tag FROM host_sessions WHERE id = ${alias}`)
  await runtime.runPromise(Rotation.stage("next", secrets.next))
  return { h, signed, ...row!, alias, aliasTag: a!.tag }
}
const rotate = async () => {
  await runtime.runPromise(Rotation.promote("next"))
  await runtime.runPromise(Rotation.cease("legacy"))
}

test("emergency revocation refuses before the post-cessation fence and changes no session", async () => {
  expect(typeof Rotation.compromise).toBe("function")
  const f = await fixture()
  const pending = await runtime.runPromise(Rotation.prepareEmergency("legacy", "next", secrets.next))
  expect(pending).toEqual(["legacy"])
  await runtime.runPromise(Rotation.cease("legacy"))
  expect(Exit.isFailure(await runtime.runPromise(Effect.exit(Rotation.compromise("legacy"))))).toBe(true)
  expect(await runtime.runPromise(Prior.read(f.tag))).toBe("live")
  expect(await runtime.runPromise(Prior.read(f.aliasTag))).toBe("live")
  expect(await query(sql => sql`SELECT state FROM session_signing_keys WHERE key_id = 'legacy'`)).toEqual([{ state: "verifier" }])
})

test("the gate's compromised exception requires zero raw live rows, including aliases of re-keyed parents", async () => {
  expect(typeof Rotation.compromise).toBe("function")
  const f = await fixture()
  const second = await f.h.signInAs()
  const [parent] = await query(sql => sql<{ id: string; tag: string }>`SELECT id, session_tag AS tag FROM sessions ORDER BY created_at DESC LIMIT 1`)
  const alias = crypto.randomUUID()
  await runtime.runPromise(Store.createHostSession({ id: alias, tokenDigest: alias, parentId: parent!.id, host: "alias.test" }))
  const [a] = await query(sql => sql<{ tag: string }>`SELECT session_tag AS tag FROM host_sessions WHERE id = ${alias}`)
  await rotate()
  await query(sql => sql`UPDATE sessions SET cookie_key = 'next' WHERE id = ${parent!.id}`)
  await query(sql => sql`UPDATE session_signing_keys SET state = 'compromised', ceased_at = now() - interval '31 seconds' WHERE key_id = 'legacy'`)
  expect(Exit.isFailure(await runtime.runPromise(Effect.exit(Rotation.gate({ next: secrets.next }, secrets.legacy))))).toBe(true)
  await runtime.runPromise(Rotation.compromise("legacy"))
  for (const tag of [f.tag, f.aliasTag, a!.tag]) expect(await runtime.runPromise(Prior.read(tag))).toBe("ended")
  expect(await runtime.runPromise(Prior.read(parent!.tag))).toBe("live")
  expect(Exit.isSuccess(await runtime.runPromise(Effect.exit(Rotation.gate({ next: secrets.next }, secrets.legacy))))).toBe(true)
  expect(await query(sql => sql`SELECT id FROM github_token_cleanups WHERE session_id = ${f.id} AND sealed_access IS NOT NULL`)).toHaveLength(1)
  expect(setCookies(second.response).smithers_session).toBeDefined()
})

test("the operator's durable emergency command promotes, ceases, fences and ends before allowing omission", async () => {
  expect(Flows.EmergencyDropSigningKey).toBeDefined()
  const f = await fixture()
  await rotate()
  await query(sql => sql`UPDATE session_signing_keys SET ceased_at = now() - interval '31 seconds' WHERE key_id = 'legacy'`)
  const scratch = await runtime.runPromise(TestDatabase.Scratch)
  const result = await runFlow(Flows.EmergencyDropSigningKey, { keyId: "legacy", replacementId: "next" }, Flows.registration(scratch.database, secrets))
  expect(Exit.isSuccess(result.exit)).toBe(true)
  expect(await runtime.runPromise(Prior.read(f.tag))).toBe("ended")
  expect(await query(sql => sql`SELECT state FROM session_signing_keys WHERE key_id = 'legacy'`)).toEqual([{ state: "compromised" }])
  expect(sourceText(new URL("../ops/auth/session-keys.ts", import.meta.url))).toContain('"emergency-drop"')
})

test("an insert with an old issuer snapshot paused across the entire emergency sequence never commits a live K row", async () => {
  expect(typeof Rotation.compromise).toBe("function")
  const f = await fixture()
  const lock = crypto.getRandomValues(new Uint32Array(1))[0]! >>> 1
  const release = Deferred.makeUnsafe<void>(), held = Deferred.makeUnsafe<void>()
  const blocker = runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql.withTransaction(Effect.gen(function* () {
    yield* sql`SELECT pg_advisory_xact_lock(${lock}::bigint)`
    yield* Deferred.succeed(held, undefined)
    yield* Deferred.await(release)
  }))))
  await Effect.runPromise(Deferred.await(held))
  await query(sql => sql.unsafe(`CREATE FUNCTION pause_old_issuer_insert() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN IF NEW.cookie_key = 'legacy' THEN PERFORM pg_advisory_xact_lock(${lock}::bigint); END IF; RETURN NEW; END $body$`))
  await query(sql => sql`CREATE TRIGGER pause_old_issuer_insert BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION pause_old_issuer_insert()`)
  const pending = f.h.signInAs()
  try {
    // Observe the real server lock, proving INSERT's snapshot already selected K before promotion.
    let waiting = false
    const until = performance.now() + 4000
    while (!waiting && performance.now() < until) {
      const [row] = await query(sql => sql<{ waiting: boolean }>`SELECT EXISTS(SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND classid = 0 AND objid = ${lock}::oid AND NOT granted) AS waiting`)
      waiting = row!.waiting
    }
    expect(waiting).toBe(true)
    await rotate()
    expect(Exit.isFailure(await runtime.runPromise(Effect.exit(Rotation.compromise("legacy"))))).toBe(true)
    // This is the specified time fence, not a retry delay: the server's issuance timeouts must elapse inside it.
    await query(sql => sql`SELECT pg_sleep(greatest(0, extract(epoch FROM ceased_at + interval '30 seconds' - clock_timestamp())) + 0.05)
      FROM session_signing_keys WHERE key_id = 'legacy'`)
    await runtime.runPromise(Rotation.compromise("legacy"))
    expect(Exit.isSuccess(await runtime.runPromise(Effect.exit(Rotation.gate({ next: secrets.next }, secrets.legacy))))).toBe(true)
  } finally {
    Effect.runSync(Deferred.succeed(release, undefined))
    await blocker
    await query(sql => sql`DROP TRIGGER pause_old_issuer_insert ON sessions`)
    await query(sql => sql`DROP FUNCTION pause_old_issuer_insert()`)
  }
  const signed = await pending
  expect(setCookies(signed.response).smithers_session).toBeUndefined()
  expect(await query(sql => sql`SELECT id FROM sessions WHERE cookie_key = 'legacy' AND revoked_at IS NULL`)).toHaveLength(0)
  expect(await runtime.runPromise(Prior.read(f.tag))).toBe("ended")
}, 60_000)
