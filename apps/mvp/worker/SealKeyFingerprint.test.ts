import { createHmac } from "node:crypto"
import { Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import * as Rotation from "./SessionSigningKeys.ts"
import * as Store from "./SessionStore.ts"
import { testFile } from "./test/harness.ts"
import { SECRET, signInHarness } from "./test/signIn.ts"

const runtime = testFile("seal_key_fingerprint")
const secret = Redacted.make(SECRET)
const changed = Redacted.make("changed-seal-secret".padEnd(64, "x"))
const map = { legacy: secret }
const query = <A extends object>(f: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, f))
const state = () => query(sql => sql`SELECT to_jsonb(s) AS row FROM sessions s
  UNION ALL SELECT to_jsonb(c) AS row FROM github_token_cleanups c`)
beforeEach(async () => {
  await query(sql => sql`TRUNCATE sessions, people, sign_in_attempts CASCADE`)
  await query(sql => sql`DELETE FROM session_signing_keys`)
  await query(sql => sql`INSERT INTO session_signing_keys (key_id, state, promoted_at) VALUES ('legacy', 'issuer', now())`)
  await query(sql => sql`UPDATE session_seal_key SET fingerprint = NULL WHERE id`)
})

test("publication refuses a changed seal with correctly pinned signing keys and leaves sessions and cleanup unchanged", async () => {
  await runtime.runPromise(Rotation.gate(map, secret))
  const h = await signInHarness(runtime)
  await h.signInAs()
  const [old] = await query(sql => sql<{ id: string }>`SELECT id FROM sessions`)
  await runtime.runPromise(Store.revoke({ id: old!.id }, "sign_out"))
  const signed = await h.signInAs()
  const before = await state()
  expect(await query(sql => sql`SELECT id FROM github_token_cleanups`)).toHaveLength(1)
  expect(await runtime.runPromise(Effect.result(Rotation.gate(map, changed)))).toMatchObject({
    _tag: "Failure", failure: { reason: "seal_fingerprint" },
  })
  expect(await state()).toEqual(before)
  await runtime.runPromise(Rotation.gate(map, secret))
  expect(await state()).toEqual(before)
  expect(await h.session(signed.cookies)).toMatchObject({ signedIn: true })
})

test("a fresh publication pins its seal once and refuses later changes even with zero sessions", async () => {
  await query(sql => sql`TRUNCATE sessions, people, sign_in_attempts CASCADE`)
  await runtime.runPromise(Rotation.gate(map, changed))
  const fingerprint = createHmac("sha256", Redacted.value(changed)).update("smithers session seal check v1").digest("hex")
  expect(await query(sql => sql`SELECT fingerprint FROM session_seal_key`)).toEqual([{ fingerprint }])
  await runtime.runPromise(Rotation.gate(map, changed))
  expect(await runtime.runPromise(Effect.result(Rotation.gate(map, secret)))).toMatchObject({
    _tag: "Failure", failure: { reason: "seal_fingerprint" },
  })
})

test("first publication pins the held seal with live rows even if it differs from the old secret", async () => {
  const h = await signInHarness(runtime)
  await h.signInAs()
  const before = await state()
  await runtime.runPromise(Rotation.gate(map, changed))
  const fingerprint = createHmac("sha256", Redacted.value(changed)).update("smithers session seal check v1").digest("hex")
  expect(await query(sql => sql`SELECT fingerprint FROM session_seal_key`)).toEqual([{ fingerprint }])
  expect(await state()).toEqual(before)
  expect(await runtime.runPromise(Effect.result(Rotation.gate(map, secret)))).toMatchObject({
    _tag: "Failure", failure: { reason: "seal_fingerprint" },
  })
})

test("first publication pins the seal with retained cleanup ciphertext", async () => {
  await runtime.runPromise(Rotation.gate(map, secret))
  const h = await signInHarness(runtime)
  await h.signInAs()
  const [row] = await query(sql => sql<{ id: string }>`SELECT id FROM sessions`)
  await runtime.runPromise(Store.revoke({ id: row!.id }, "sign_out"))
  await query(sql => sql`DELETE FROM people`)
  await query(sql => sql`UPDATE session_seal_key SET fingerprint = NULL WHERE id`)
  const before = await state()
  expect(before.length).toBeGreaterThan(0)
  await runtime.runPromise(Rotation.gate(map, changed))
  expect(await query(sql => sql`SELECT fingerprint FROM session_seal_key`)).toEqual([{ fingerprint: await runtime.runPromise(Rotation.sealFingerprint(changed)) }])
  expect(await state()).toEqual(before)
})

test("first publication pins the seal with a pending sign-in", async () => {
  const h = await signInHarness(runtime)
  await h.start()
  const before = await query(sql => sql`SELECT verifier FROM sign_in_attempts`)
  expect(before).toHaveLength(1)
  await runtime.runPromise(Rotation.gate(map, changed))
  expect(await query(sql => sql`SELECT fingerprint FROM session_seal_key`)).toEqual([{ fingerprint: await runtime.runPromise(Rotation.sealFingerprint(changed)) }])
  expect(await query(sql => sql`SELECT verifier FROM sign_in_attempts`)).toEqual(before)
  expect(await query(sql => sql`SELECT fingerprint FROM session_signing_keys`)).toEqual([{ fingerprint: await runtime.runPromise(Rotation.fingerprint(secret)) }])
})
