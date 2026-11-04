import { createHmac } from "node:crypto"
import { Effect, Exit, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import * as Rotation from "./SessionSigningKeys.ts"
import { testFile } from "./test/harness.ts"
import { SECRET, signInHarness } from "./test/signIn.ts"

const runtime = testFile("key_fingerprint")
const query = <A extends object>(f: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, f))
const secret = Redacted.make(SECRET)
const candidate = Redacted.make("wrong-candidate".padEnd(64, "x"))
const map = { legacy: secret }
const fp = (value: string) => createHmac("sha256", value).update("smithers session key check v1").digest("hex")
const snapshot = () => query(sql => sql`SELECT key_id, fingerprint FROM session_signing_keys ORDER BY key_id`)
beforeEach(async () => {
  const seal = createHmac("sha256", SECRET).update("smithers session seal check v1").digest("hex")
  await query(sql => sql`UPDATE session_seal_key SET fingerprint = ${seal} WHERE id`)
})

test("first publication pins existing legacy rows and later publications require the same secret", async () => {
  const h = await signInHarness(runtime)
  await h.signInAs()
  await runtime.runPromise(Rotation.gate(map, secret))
  expect(await snapshot()).toEqual([{ key_id: "legacy", fingerprint: fp(SECRET) }])
  expect(Exit.isSuccess(await runtime.runPromise(Effect.exit(Rotation.gate(map, secret))))).toBe(true)
  expect(Exit.isFailure(await runtime.runPromise(Effect.exit(Rotation.gate({ legacy: candidate }, secret))))).toBe(true)
  expect(Exit.isFailure(await runtime.runPromise(Effect.exit(Rotation.gate({ ...map, unknown: candidate }, secret))))).toBe(true)
})

test("staging records the exact HMAC and never initializes an existing NULL reference", async () => {
  await runtime.runPromise(Rotation.stage("next", candidate))
  expect(await query(sql => sql`SELECT fingerprint FROM session_signing_keys WHERE key_id = 'next'`)).toEqual([{ fingerprint: fp(Redacted.value(candidate)) }])
  await query(sql => sql`UPDATE session_signing_keys SET fingerprint = NULL WHERE key_id = 'next'`)
  expect(Exit.isFailure(await runtime.runPromise(Effect.exit(Rotation.stage("next", candidate))))).toBe(true)
  expect(await query(sql => sql`SELECT fingerprint FROM session_signing_keys WHERE key_id = 'next'`)).toEqual([{ fingerprint: null }])
})

