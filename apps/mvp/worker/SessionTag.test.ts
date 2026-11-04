import { Effect, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import * as Keys from "./SessionKeys.ts"
import * as Store from "./SessionStore.ts"
import { testFile } from "./test/harness.ts"
import { configured, cookie, signInHarness } from "./test/signIn.ts"

const runtime = testFile("session_tag")
const query = <A extends object>(f: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, f))
beforeEach(() => query(sql => sql`TRUNCATE sessions, sign_in_attempts, people CASCADE`))
type Answer = { signedIn: boolean; session: string }

test("the session tag is random persisted data independent of the row id", async () => {
  const h = await signInHarness(runtime)
  const first = await h.signInAs()
  const [row] = await query(sql => sql<{ id: string; tag: string }>`SELECT id, session_tag AS tag FROM sessions`)
  const answer = await h.session(first.cookies) as Answer
  expect(answer.session).toBe(row!.tag)
  expect(answer.session).not.toBe(Keys.digest(row!.id).slice(0, 32))
  expect(answer.session).toMatch(/^[a-f0-9]{32}$/)
  expect(JSON.stringify(answer)).not.toContain(row!.id)
  await query(sql => sql`UPDATE sessions SET started_at = now(), expires_at = now() + interval '28 days'`)
  expect((await h.session(first.cookies) as Answer).session).toBe(answer.session)
  const second = await h.signInAs()
  expect((await h.session(second.cookies) as Answer).session).not.toBe(answer.session)
  expect(await h.session()).not.toHaveProperty("session")
})

test("an alias host returns its own row's tag and never the parent's", async () => {
  const h = await signInHarness(runtime, { config: { ...configured, APP_DOMAIN: "smithers.test", APP_ALIASES: "alias.test=/" } })
  const home = await h.signInAs()
  const [row] = await query(sql => sql<{ id: string; tag: string }>`SELECT id, session_tag AS tag FROM sessions`)
  const id = crypto.randomUUID()
  const token = "opaque-alias-token"
  await runtime.runPromise(Store.createHostSession({ id, tokenDigest: Keys.digest(token), parentId: row!.id, host: "alias.test" }))
  const keys = await runtime.runPromise(Keys.make(Redacted.make(configured.SESSION_SECRET!)))
  const response = await h.at("http://alias.test/api/auth/session", { headers: { cookie: cookie({ smithers_session: await runtime.runPromise(keys.sign("session", token)) }) } })
  const answer = await response.json() as Answer
  const [alias] = await query(sql => sql<{ tag: string }>`SELECT session_tag AS tag FROM host_sessions WHERE id = ${id}`)
  expect(answer.session).toBe(alias!.tag)
  expect(answer.session).not.toBe(Keys.digest(id).slice(0, 32))
  expect(answer.session).not.toBe((await h.session(home.cookies) as Answer).session)
  expect(JSON.stringify(answer)).not.toContain(id)
  expect(JSON.stringify(answer)).not.toContain(row!.id)
})
