import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { testFile } from "./test/harness.ts"
import * as Personal from "./personal/Store.ts"
import * as Secrets from "./secrets/Store.ts"
import * as WriteAuthority from "./WriteAuthority.ts"
import { SigningKeyIds } from "./SessionStore.ts"

const runtime = testFile("durable_authority")
const sql = (query: string) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(query)))
test.each(["put", "delete", "link", "secret put", "secret delete"].flatMap((op) =>
  ["session", "alias", "expiry", "home rekey", "alias rekey"].map((end) => [op, end] as const)))("delayed %s refuses ended %s authority and replay", async (op, end) => {
  const personId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  await sql(`INSERT INTO people (id, github_id, github_login) VALUES ('${personId}', ${Math.floor(Math.random() * 1e12)}, 'delayed')`)
  await sql(`INSERT INTO sessions (id, person_id, token_digest, role, role_checked_at, expires_at)
    VALUES ('${sessionId}', '${personId}', '${sessionId}', 'admin', now(), now() + interval '1 day')`)
  const alias = crypto.randomUUID()
  await sql(`INSERT INTO host_sessions (id, token_digest, parent_id, host) VALUES ('${alias}', '${alias}', '${sessionId}', 'alias.example.test')`)
  // Decode the recorded pre-key-binding shape. Its missing key is legacy authority, never a wildcard.
  const authority = Schema.decodeUnknownSync(WriteAuthority.Session)(JSON.parse(JSON.stringify({
    personId, sessionId, ...(end === "home rekey" ? {} : { alias }), scope: { _tag: "Deployment" },
  })))
  expect(authority.cookieKey).toBeUndefined()
  const holds = (value: WriteAuthority.Session) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient,
    client => client.withTransaction(WriteAuthority.holds(value))).pipe(Effect.provideService(SigningKeyIds, ["legacy", "next"])))
  expect(await holds(authority)).toBe(true)
  const kept = crypto.randomUUID()
  const late = crypto.randomUUID()
  const invocationKey = crypto.randomUUID()
  const sealed = { ciphertext: "ciphertext", nonce: "nonce", keyVersion: 1, keyLast4: "abcd" }
  // Seed a live target so a revoked delete cannot silently remove it.
  await runtime.runPromise(Personal.put({ personId, invocationKey: `seed:${invocationKey}`, connections: [{
    id: kept, kind: "api_key", active: true, protocol: "openai-chat", baseUrl: "https://example.test", models: {}, sealed,
  }] }))
  await runtime.runPromise(Secrets.put({ repoId: personId, name: "KEY", ...sealed, hosts: ["example.test"], methods: undefined,
    actorId: personId, invocationKey: `seed-secret:${invocationKey}` }))
  const generation = await runtime.runPromise(Personal.linkGeneration(personId))
  await sql(end === "home rekey" ? `UPDATE sessions SET cookie_key = 'next' WHERE id = '${sessionId}'`
    : end === "alias rekey" ? `UPDATE host_sessions SET cookie_key = 'next' WHERE id = '${alias}'`
    : end === "alias" ? `UPDATE host_sessions SET revoked_at = now() WHERE id = '${alias}'`
    : end === "expiry" ? `UPDATE sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE id = '${sessionId}'`
    : `UPDATE sessions SET revoked_at = now(), revoked_reason = 'sign_out' WHERE id = '${sessionId}'`)
  const personal = { personId, invocationKey, authority }
  const secret = { repoId: personId, name: "KEY", actorId: personId, invocationKey, authority }
  if (end.endsWith("rekey")) expect(await holds({ ...authority, cookieKey: "next" })).toBe(true)
  const effect = (op === "put" ? Personal.put({ ...personal, connections: [{
      id: kept, kind: "api_key", active: true, protocol: "openai-chat", baseUrl: "https://example.test", models: {}, sealed,
    }] })
    : op === "delete" ? Personal.remove(personal)
    : op === "link" ? Personal.link({ ...personal, id: late, sealed, generation })
    : op === "secret put" ? Secrets.put({ ...secret, ...sealed, hosts: ["example.test"], methods: undefined })
    : Secrets.remove(secret)).pipe(Effect.provideService(SigningKeyIds, ["legacy", "next"]))
  expect(await runtime.runPromise(effect)).toBe("stale")
  expect(await runtime.runPromise(effect)).toBe("stale")
  expect(await sql(`SELECT id FROM personal_models WHERE person_id = '${personId}'`)).toEqual([{ id: kept }])
  expect(await sql(`SELECT name FROM secrets WHERE repo_id = '${personId}'`)).toEqual([{ name: "KEY" }])
})


test.each(["put", "delete"] as const)("secret %s queued before live-session demotion is refused", async (op) => {
  const personId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  await sql(`INSERT INTO people (id, github_id, github_login) VALUES ('${personId}', ${Math.floor(Math.random() * 1e12)}, 'demoted')`)
  await sql(`INSERT INTO sessions (id, person_id, token_digest, role, role_checked_at, expires_at)
    VALUES ('${sessionId}', '${personId}', '${sessionId}', 'admin', now(), now() + interval '1 day')`)
  const authority = { personId, sessionId, scope: { _tag: "Deployment" as const } }
  const sealed = { ciphertext: "before", nonce: "nonce", keyVersion: 1 }
  await runtime.runPromise(Secrets.put({ repoId: personId, name: "KEY", ...sealed, hosts: ["example.test"], methods: undefined,
    actorId: personId, invocationKey: crypto.randomUUID() }))
  const write = { repoId: personId, name: "KEY", actorId: personId, invocationKey: crypto.randomUUID(), authority }
  const queued = op === "put" ? Secrets.put({ ...write, ...sealed, ciphertext: "after", hosts: ["example.test"], methods: undefined }) : Secrets.remove(write)
  await sql(`UPDATE sessions SET role = 'member', role_checked_at = clock_timestamp() WHERE id = '${sessionId}'`)
  expect(await runtime.runPromise(queued)).toBe("stale")
  expect(await runtime.runPromise(queued)).toBe("stale")
  expect(await sql(`SELECT ciphertext FROM secrets WHERE repo_id = '${personId}'`)).toEqual([{ ciphertext: "before" }])
})
