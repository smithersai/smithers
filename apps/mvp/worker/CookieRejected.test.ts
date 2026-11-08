import { Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import * as Keys from "./SessionKeys.ts"
import { testFile } from "./test/harness.ts"
import { SECRET, signInHarness } from "./test/signIn.ts"

const runtime = testFile("cookie_rejected")
const query = <A extends object>(f: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, f))
beforeEach(() => query(sql => sql`TRUNCATE sessions, sign_in_attempts, people CASCADE`))

test("present cookies that fail verification or live resolution are counted once, and absent cookies are not", async () => {
  const h = await signInHarness(runtime)
  const count = () => h.snapshot().filter(entry => entry.id === "smithers_auth_session" && entry.attributes?.outcome === "cookie_rejected")
    .reduce((n, entry) => n + (entry.state as { count: number }).count, 0)
  await h.session()
  expect(count()).toBe(0)
  await h.session({ smithers_session: "invalid-cookie-sentinel" })
  expect(count()).toBe(1)
  const keys = await runtime.runPromise(Keys.make(Redacted.make(SECRET)))
  await h.session({ smithers_session: await runtime.runPromise(keys.sign("session", "nonexistent-session")) })
  expect(count()).toBe(2)
  const signed = await h.signInAs()
  await h.session(signed.cookies)
  expect(count()).toBe(2)
  await query(sql => sql`UPDATE sessions SET expires_at = now() - interval '1 second'`)
  await h.session(signed.cookies)
  expect(count()).toBe(3)
  await query(sql => sql`UPDATE sessions SET expires_at = now() + interval '30 days', started_at = now() - interval '401 days'`)
  await h.session(signed.cookies)
  expect(count()).toBe(4)
  await query(sql => sql`UPDATE sessions SET started_at = now(), revoked_at = now()`)
  await h.session(signed.cookies)
  expect(count()).toBe(5)
  const records = JSON.stringify(h.line("auth.session"))
  expect(records).not.toContain("invalid-cookie-sentinel")
  expect(records).not.toContain("nonexistent-session")
  expect(records).not.toContain(signed.cookies.smithers_session!)
})
