import { Effect, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import * as Store from "./SessionStore.ts"
import * as Keys from "./SessionKeys.ts"
import * as Notifications from "./Notifications.ts"
import * as GitHubStore from "./github/Store.ts"
import * as SandboxSpend from "./flows/SandboxSpend.ts"
import { testFile } from "./test/harness.ts"
import { configured, cookie, setCookies, signInHarness } from "./test/signIn.ts"

const runtime = testFile("session_lifetime")
const query = <A extends object>(f: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, f))
type Answer = { signedIn: boolean; expiresAt: number; deadline: number; serverNow: number }
const DAY = 86_400_000
beforeEach(() => query(sql => sql`TRUNCATE sessions, sign_in_attempts, people CASCADE`))

const setup = async () => {
  const h = await signInHarness(runtime, { config: { ...configured, APP_DOMAIN: "smithers.test", APP_ALIASES: "alias.test=/" } })
  const signed = await h.signInAs()
  const [row] = await query(sql => sql<{ id: string }>`SELECT id FROM sessions`)
  return { h, signed, id: row!.id }
}

const lifetime = async () => (await query(sql => sql<{ end: number; deadline: number; now: number }>`
  SELECT (extract(epoch FROM expires_at)*1000)::float8 AS end,
    (extract(epoch FROM started_at + interval '400 days')*1000)::float8 AS deadline,
    (extract(epoch FROM clock_timestamp())*1000)::float8 AS now FROM sessions`))[0]!

test("session reads renew once per day, sample after renewal, and never set a cookie", async () => {
  const { h, signed } = await setup()
  await query(sql => sql`UPDATE sessions SET expires_at = now() + interval '28 days'`)
  const response = await h.fetch("/api/auth/session", { headers: { cookie: cookie(signed.cookies) } })
  const answer = await response.json() as Answer
  expect(answer.expiresAt - answer.serverNow).toBeGreaterThan(29.99 * DAY)
  expect(response.headers.getSetCookie()).toEqual([])
  expect(h.count({ route: "session", outcome: "renewed" })).toBe(1)
  const renewed = await lifetime()
  expect(answer.serverNow).toBeGreaterThanOrEqual(renewed.end - 30 * DAY - 1)
  await h.session(signed.cookies)
  expect((await lifetime()).end).toBe(renewed.end)
  expect(h.count({ route: "session", outcome: "renewed" })).toBe(1)
})

test("renewal is capped at the absolute deadline and returns both effective ends", async () => {
  const { h, signed } = await setup()
  await query(sql => sql`UPDATE sessions SET started_at = now() - interval '399 days', expires_at = now() + interval '12 hours'`)
  const answer = await h.session(signed.cookies) as Answer
  const row = await lifetime()
  expect(answer.deadline).toBeCloseTo(row.deadline, -1)
  expect(answer.expiresAt).toBeCloseTo(row.deadline, -1)
  expect(row.end).toBe(row.deadline)
})

test("copied cookies past the deadline authenticate nobody in every live reader", async () => {
  const { h, signed, id } = await setup()
  await query(sql => sql`UPDATE sessions SET started_at = now() - interval '401 days', expires_at = now() + interval '20 days'`)
  const digest = Keys.digest(signed.cookies.smithers_session!.split(".")[0]!)
  h.advance(-2 * 366 * DAY)
  expect(await h.session(signed.cookies)).toMatchObject({ signedIn: false })
  expect(await runtime.runPromise(Store.findLive(digest))).toEqual(Option.none())
  expect(await runtime.runPromise(Store.findLiveById(id))).toEqual(Option.none())
  expect(await runtime.runPromise(Store.authority(id, null))).toEqual(Option.none())
  const github = await runtime.runPromise(GitHubStore.sessionToken(id))
  expect(Option.isSome(github) && github.value.live).toBe(false)
  await query(sql => sql`UPDATE sessions SET role = 'admin'`)
  expect(await runtime.runPromise(SandboxSpend.bell({ alertId: "sandbox-spend-2026-11-100", usd: 101, limitUsd: 100 }))).toEqual({ admins: 0 })
  const held = await runtime.runPromise(Store.held(id))
  expect(Option.isSome(held) && held.value.live).toBe(false)
  const [person] = await query(sql => sql<{ id: string }>`SELECT id FROM people`)
  expect(await runtime.runPromise(Store.deploymentMember(person!.id))).toBe(false)
  await query(sql => sql`INSERT INTO watches (principal_id, subject, level) VALUES (${person!.id}, 'repo:github/acme/widgets', 'all')`)
  expect(await runtime.runPromise(Notifications.recordRepoEvent({
    kind: "main", repoId: "github/acme/widgets", ref: "a".repeat(40), title: "acme/widgets", actor: null,
    occurredAt: new Date(), href: "/acme/widgets",
  }))).toBe(0)
  expect(await runtime.runPromise(Store.createHostSession({ id: crypto.randomUUID(), tokenDigest: "ended-parent", parentId: id, host: "alias.test" }))).toBe(false)
})

test("an alias read renews its parent and uses the earlier alias deadline", async () => {
  const { h, signed, id } = await setup()
  const token = "alias-lifetime-token"
  const alias = crypto.randomUUID()
  await runtime.runPromise(Store.createHostSession({ id: alias, tokenDigest: Keys.digest(token), parentId: id, host: "alias.test" }))
  await query(sql => sql`UPDATE sessions SET expires_at = now() + interval '25 days'`)
  await query(sql => sql`UPDATE host_sessions SET started_at = now() - interval '399 days'`)
  const keys = await runtime.runPromise(Keys.make(Redacted.make(configured.SESSION_SECRET!)))
  const response = await h.at("http://alias.test/api/auth/session", { headers: { cookie: cookie({ smithers_session: await runtime.runPromise(keys.sign("session", token)) }) } })
  const answer = await response.json() as Answer
  expect(answer.signedIn).toBe(true)
  expect(answer.deadline - answer.serverNow).toBeCloseTo(DAY, -4)
  expect(answer.expiresAt).toBe(answer.deadline)
  expect((await lifetime()).end - answer.serverNow).toBeGreaterThan(29.99 * DAY)
  expect(response.headers.getSetCookie()).toEqual([])
  await query(sql => sql`UPDATE host_sessions SET started_at = now() - interval '401 days'`)
  expect(await runtime.runPromise(Store.findHostLive(Keys.digest(token), "alias.test"))).toEqual(Option.none())
  expect(await runtime.runPromise(Store.authority(id, alias))).toEqual(Option.none())
  expect(signed.response.status).toBe(303)
})

test("sign-in sets an absolute Expires equal to the row deadline, without sliding Max-Age", async () => {
  const { signed } = await setup()
  const set = setCookies(signed.response).smithers_session!.line
  expect(set).not.toContain("Max-Age")
  const expires = /Expires=([^;]+)/.exec(set)
  expect(expires).not.toBeNull()
  expect(Math.abs(Date.parse(expires![1]!) - (await lifetime()).deadline)).toBeLessThan(1000)
})


test("the additive migration preserves existing starts and accepts old Workers' inserts", async () => {
  const migration = (await import("../db/migrations/0109_session_deadlines.ts")).default
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql.withTransaction(Effect.gen(function* () {
    yield* sql`CREATE TEMP TABLE sessions (created_at timestamptz NOT NULL DEFAULT now()) ON COMMIT DROP`
    yield* sql`CREATE TEMP TABLE host_sessions (created_at timestamptz NOT NULL DEFAULT now()) ON COMMIT DROP`
    yield* sql`INSERT INTO sessions (created_at) VALUES (now() - interval '100 days')`
    yield* sql`INSERT INTO host_sessions (created_at) VALUES (now() - interval '90 days')`
    yield* migration
    for (const table of ["sessions", "host_sessions"]) {
      const [backfill] = yield* sql<{ same: boolean }>`SELECT started_at = created_at AS same FROM ${sql(table)}`
      expect(backfill!.same).toBe(true)
      yield* sql`INSERT INTO ${sql(table)} DEFAULT VALUES`
      const rows = yield* sql<{ same: boolean }>`SELECT started_at = created_at AS same FROM ${sql(table)}`
      expect(rows).toEqual([{ same: true }, { same: true }])
    }
  }))))
})
