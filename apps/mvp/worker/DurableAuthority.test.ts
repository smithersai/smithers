import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { testFile } from "./test/harness.ts"
import * as Personal from "./personal/Store.ts"
import * as Secrets from "./secrets/Store.ts"

const runtime = testFile("durable_authority")
const sql = (query: string) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(query)))
test.each(["put", "delete", "link", "secret put", "secret delete"].flatMap((op) =>
  ["session", "alias", "expiry"].map((end) => [op, end] as const)))("delayed %s refuses ended %s authority and replay", async (op, end) => {
  const personId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  await sql(`INSERT INTO people (id, github_id, github_login) VALUES ('${personId}', ${Math.floor(Math.random() * 1e12)}, 'delayed')`)
  await sql(`INSERT INTO sessions (id, person_id, token_digest, role, role_checked_at, expires_at)
    VALUES ('${sessionId}', '${personId}', '${sessionId}', 'admin', now(), now() + interval '1 day')`)
  const alias = crypto.randomUUID()
  await sql(`INSERT INTO host_sessions (id, token_digest, parent_id, host) VALUES ('${alias}', '${alias}', '${sessionId}', 'alias.example.test')`)
  const authority = { personId, sessionId, alias }
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
  await sql(end === "alias" ? `UPDATE host_sessions SET revoked_at = now() WHERE id = '${alias}'`
    : end === "expiry" ? `UPDATE sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE id = '${sessionId}'`
    : `UPDATE sessions SET revoked_at = now(), revoked_reason = 'sign_out' WHERE id = '${sessionId}'`)
  const personal = { personId, invocationKey, authority }
  const secret = { repoId: personId, name: "KEY", actorId: personId, invocationKey, authority }
  const effect = op === "put" ? Personal.put({ ...personal, connections: [{
      id: kept, kind: "api_key", active: true, protocol: "openai-chat", baseUrl: "https://example.test", models: {}, sealed,
    }] })
    : op === "delete" ? Personal.remove(personal)
    : op === "link" ? Personal.link({ ...personal, id: late, sealed, generation })
    : op === "secret put" ? Secrets.put({ ...secret, ...sealed, hosts: ["example.test"], methods: undefined })
    : Secrets.remove(secret)
  expect(await runtime.runPromise(effect)).toBe("stale")
  expect(await runtime.runPromise(effect)).toBe("stale")
  expect(await sql(`SELECT id FROM personal_models WHERE person_id = '${personId}'`)).toEqual([{ id: kept }])
  expect(await sql(`SELECT name FROM secrets WHERE repo_id = '${personId}'`)).toEqual([{ name: "KEY" }])
})
