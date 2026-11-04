import { digestSync } from "@smthrs/crypto"
import { Effect, Metric, Option } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import * as ProtectedAuthority from "./ProtectedAuthority.ts"
import * as SessionStore from "./SessionStore.ts"
import * as WriteAuthority from "./WriteAuthority.ts"
import * as Store from "./github/Store.ts"
import * as Triage from "./github/TriageStore.ts"
import * as Write from "./github/Write.ts"
import { TokenUnavailable } from "./github/Tokens.ts"
import { testFile } from "./test/harness.ts"
import { holdSql } from "./test/sqlWait.ts"

const runtime = testFile("triage_role_deadline")
const query = <A extends object>(f: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, f))
type Scope = "Repo" | "Deployment"
const fixture = async (scope: Scope, alias: boolean, op: "triage/enable" | "triage/pause") => {
  const personId = crypto.randomUUID(), sessionId = crypto.randomUUID(), writeId = crypto.randomUUID()
  const repoId = `github/role-deadline/${crypto.randomUUID()}`, hostId = alias ? crypto.randomUUID() : undefined
  await query(sql => sql`INSERT INTO people (id, github_id, github_login)
    VALUES (${personId}, ${Math.floor(Math.random() * 1e9)}, 'writer')`)
  await query(sql => sql`INSERT INTO sessions (id, token_digest, person_id, role, role_checked_at, role_verified_at, expires_at)
    VALUES (${sessionId}, ${crypto.randomUUID()}, ${personId}, 'admin', clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 day')`)
  if (hostId !== undefined) await query(sql => sql`INSERT INTO host_sessions (id, token_digest, parent_id, host)
    VALUES (${hostId}, ${crypto.randomUUID()}, ${sessionId}, 'chat.test')`)
  const [original] = await query(sql => sql<{ checkedAt: string }>`INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at)
    VALUES (${repoId}, ${personId}, 'admin', clock_timestamp() - interval '2 hours') RETURNING checked_at::text AS "checkedAt"`)
  // A retained write carries an older grant. Its delayed attempt must use a fresh current observation.
  const authority: WriteAuthority.Session = { personId, sessionId, cookieKey: "legacy",
    ...(hostId === undefined ? {} : { alias: hostId }), scope: scope === "Deployment" ? { _tag: scope }
      : { _tag: scope, held: { repoId, personId, role: "admin", checkedAt: original!.checkedAt } } }
  const payload = op === "triage/enable" ? { op, dailyTokens: 20, authority } : { op, authority }
  await runtime.runPromise(Triage.enable(repoId, { actorId: personId, login: null, dailyTokens: 10 }))
  await runtime.runPromise(Store.insertWrite({ id: writeId, repoId, actorId: personId, sessionId, via: "person",
    payload, payloadHash: digestSync(JSON.stringify(payload)) }))
  const database = (await runtime.runPromise(TestDatabase.Scratch)).database
  const http = await Effect.runPromise(HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer)))
  let tokenCalls = 0
  const unavailable = () => Effect.andThen(Effect.sync(() => tokenCalls++), new TokenUnavailable({ reason: "unavailable" }))
  const steps = Write.steps({ database, http, tokens: { forSession: unavailable, forInstallation: unavailable },
    apiBaseUrl: "http://127.0.0.1:1", appLogin: "unavailable", mayAct: () => true })
  const metrics: Metric.MetricRegistry = new Map()
  const count = (stage: "check" | "commit", outcome: "held" | "unavailable") => Effect.runSync(Metric.value(
    Metric.withAttributes(stage === "check" ? ProtectedAuthority.checks : ProtectedAuthority.commitChecks, { outcome }),
  ).pipe(Effect.provideService(Metric.MetricRegistry, metrics))).count
  const attempt = (phase: "send" | "giveUp") => Effect.runPromise(Effect.result(steps[phase]({ writeId }))
    .pipe(Effect.provideService(Metric.MetricRegistry, metrics)))
  const pending = async () => {
    expect(await query(sql => sql`SELECT status, failure, settled_at FROM github_writes WHERE id = ${writeId}`))
      .toEqual([{ status: "pending", failure: null, settled_at: null }])
    expect(await query(sql => sql`SELECT paused, daily_tokens::int FROM triage_settings WHERE repo_id = ${repoId}`))
      .toEqual([{ paused: false, daily_tokens: 10 }])
    expect(await query(sql => sql`SELECT subject FROM notifications WHERE recipient = ${personId}`)).toEqual([])
    expect(tokenCalls).toBe(0)
  }
  const recover = async () => {
    if (scope === "Deployment") await runtime.runPromise(SessionStore.setRole(sessionId, "admin", await runtime.runPromise(SessionStore.roleObservation), 0))
    else await query(sql => sql`UPDATE github_repo_roles SET role = 'admin', checked_at = clock_timestamp()
      WHERE repo_id = ${repoId} AND person_id = ${personId}`)
    expect(await attempt("giveUp")).toMatchObject({ _tag: "Success", success: { status: "done" } })
    expect(await attempt("send")).toMatchObject({ _tag: "Success", success: { status: "done" } })
    expect(Option.getOrThrow(await runtime.runPromise(Store.writeOf(writeId))).id).toBe(writeId)
    expect(await query(sql => sql`SELECT paused, daily_tokens::int FROM triage_settings WHERE repo_id = ${repoId}`))
      .toEqual([{ paused: op === "triage/pause", daily_tokens: op === "triage/enable" ? 20 : 10 }])
    expect(tokenCalls).toBe(0)
    expect(count("commit", "held")).toBe(1)
  }
  return { personId, sessionId, hostId, repoId, writeId, attempt, pending, recover, count }
}

test.each((["admin", "member", null] as const).flatMap(role => ["expired", "missing", "future"].flatMap(observation =>
  ["send", "giveUp"].map(phase => ({ role, observation, phase })))))(
  "deployment triage holds $role authority with a $observation observation during $phase", async ({ role, observation, phase }) => {
    const h = await fixture("Deployment", false, phase === "send" ? "triage/enable" : "triage/pause")
    await query(sql => sql`UPDATE sessions SET role = ${role}, role_verified_at = ${observation === "missing" ? sql`NULL`
      : observation === "expired" ? sql`clock_timestamp() - interval '61 minutes'` : sql`clock_timestamp() + interval '1 minute'`}
      WHERE id = ${h.sessionId}`)
    expect(await h.attempt(phase as "send" | "giveUp"))
      .toMatchObject({ _tag: "Failure", failure: { _tag: "@smthrs/mvp/github/WriteUnavailable" } })
    await h.pending()
    expect(h.count("check", "unavailable")).toBe(1)
    expect(h.count("commit", "unavailable")).toBe(0)
    await h.recover()
  },
)

const waits = (["Repo", "Deployment"] as const).flatMap(scope => (["admin", "member"] as const).flatMap(role =>
  ["session", "alias", "receipt", ...(role === "admin" ? ["enable settings", "pause settings"] : [])]
    .map(boundary => ({ scope, role, boundary }))))
test.each(waits)("$scope $role authority expires during the $boundary lock wait and remains pending", async ({ scope, role, boundary }) => {
  const h = await fixture(scope, boundary === "alias", boundary === "enable settings" ? "triage/enable" : "triage/pause")
  const generation = await runtime.runPromise(SessionStore.roleObservation)
  const held = await holdSql(runtime, sql => boundary === "session"
    ? sql`SELECT 1 FROM sessions WHERE id = ${h.sessionId} FOR UPDATE`
    : boundary === "alias" ? sql`SELECT 1 FROM host_sessions WHERE id = ${h.hostId} FOR UPDATE`
    : boundary === "receipt" ? sql`LOCK TABLE branches IN ACCESS EXCLUSIVE MODE`
    : sql`SELECT 1 FROM triage_settings WHERE repo_id = ${h.repoId} FOR UPDATE`)
  // Set the role deadline on another connection while the chosen downstream lock is held.
  // For a session lock, another session's newest receipt avoids updating the held session row.
  const [clock] = await query(sql => sql<{ stamp: string; deadline: string }>`SELECT
    (clock_timestamp() - ${scope === "Repo" ? sql`interval '5 minutes'` : sql`interval '60 minutes'`} + interval '600 milliseconds')::text AS stamp,
    (clock_timestamp() + interval '600 milliseconds')::text AS deadline`)
  if (scope === "Repo") await query(sql => sql`UPDATE github_repo_roles SET role = ${role}, checked_at = ${clock!.stamp}::timestamptz
    WHERE repo_id = ${h.repoId} AND person_id = ${h.personId}`)
  else await query(sql => sql`INSERT INTO person_role_receipts (person_id, session_id, role, role_generation, role_checked_at, role_verified_at, created_at)
    VALUES (${h.personId}, ${crypto.randomUUID()}, ${role}, ${generation}::bigint, clock_timestamp(), ${clock!.stamp}::timestamptz, clock_timestamp())`)
  if (scope === "Deployment") expect(await query(sql => sql`SELECT
    ${SessionStore.latestRole(sql, sql`${h.personId}::uuid`)} IS NOT DISTINCT FROM ${role} AS selected,
    ${SessionStore.latestRoleVerifiedAt(sql, sql`${h.personId}::uuid`)} = ${clock!.stamp}::timestamptz AS stamped`))
    .toEqual([{ selected: true, stamped: true }])
  const phase = boundary === "alias" || boundary === "receipt" ? "giveUp" : "send"
  const writing = h.attempt(phase)
  try {
    await expect.poll(async () => {
      const [row] = await query(sql => sql<{ live: boolean }>`SELECT clock_timestamp() < ${clock!.deadline}::timestamptz AS live
        FROM pg_stat_activity WHERE ${held.pid} = ANY(pg_blocking_pids(pid))`)
      return row?.live
    }, { timeout: 1000, interval: 10 }).toBe(true)
    await query(sql => sql`SELECT pg_sleep(greatest(0, extract(epoch FROM ${clock!.deadline}::timestamptz - clock_timestamp())) + 0.01)`)
    expect(await query(sql => sql`SELECT clock_timestamp() >= ${clock!.deadline}::timestamptz AS ended`)).toEqual([{ ended: true }])
  } finally { await held.release(); await writing }
  expect(await writing).toMatchObject({ _tag: "Failure", failure: { _tag: "@smthrs/mvp/github/WriteUnavailable" } })
  await h.pending()
  const atCommit = boundary !== "session" && boundary !== "alias"
  expect(h.count("check", "unavailable")).toBe(atCommit ? 0 : 1)
  expect(h.count("commit", "unavailable")).toBe(atCommit ? 1 : 0)
  await h.recover()
})
