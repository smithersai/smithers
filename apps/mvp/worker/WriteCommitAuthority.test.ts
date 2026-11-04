import { SharedText } from "@smthrs/sync"
import { digestSync } from "@smthrs/crypto"
import { Effect, Layer, Metric, Option } from "effect"
import { Base64 } from "effect/encoding"
import { FetchHttpClient, HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import { stackRoute } from "../src/features/todos/contract.ts"
import { textRoute } from "../src/features/coedit/contract.ts"
import { type Actor, Sessions } from "./Actor.ts"
import { branchHarness, tracked } from "./test/branch.ts"
import { testFile } from "./test/harness.ts"
import { holdSql } from "./test/sqlWait.ts"
import { stackHarness } from "./stack/test/stack.ts"
import * as Secrets from "./secrets/Store.ts"
import * as Personal from "./personal/Store.ts"
import * as WriteAuthority from "./WriteAuthority.ts"
import * as TestDatabase from "../db/TestDatabase.ts"
import * as GitHubStore from "./github/Store.ts"
import * as GitHubWrite from "./github/Write.ts"
import * as Triage from "./github/TriageStore.ts"
import { TokenUnavailable } from "./github/Tokens.ts"
import * as GitHubMetrics from "./github/Metrics.ts"
import { SigningKeyIds } from "./SessionStore.ts"
import * as ProtectedAuthority from "./ProtectedAuthority.ts"

const runtime = testFile("write_commit_authority")
const query = <A extends object>(f: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, f))
beforeEach(() => query(sql => sql`TRUNCATE stacks, stack_ops, todos, todo_requests, todo_attempts CASCADE`))
const person = async (alias: boolean) => {
  const id = crypto.randomUUID(), session = crypto.randomUUID(), host = alias ? crypto.randomUUID() : undefined
  await query(sql => sql`INSERT INTO people (id, github_id, github_login) VALUES (${id}, ${Math.floor(Math.random() * 1e9)}, 'writer')`)
  await query(sql => sql`INSERT INTO sessions (id, token_digest, person_id, role, role_checked_at, role_verified_at, expires_at)
    VALUES (${session}, ${session}, ${id}, 'admin', clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 day')`)
  if (host !== undefined) await query(sql => sql`INSERT INTO host_sessions (id, token_digest, parent_id, host)
    VALUES (${host}, ${host}, ${session}, 'chat.test')`)
  const actor: Actor = { subject: { kind: "person", id }, role: "admin", login: "writer", session,
    ...(host === undefined ? {} : { alias: host }), cookieKey: "legacy" }
  return { id, session, host, actor }
}
const expires = async (who: Awaited<ReturnType<typeof person>>, boundary: string) => {
  const [row] = boundary === "home" ? await query(sql => sql<{ deadline: string }>`UPDATE sessions
    SET started_at = clock_timestamp() - interval '400 days' + interval '600 milliseconds'
    WHERE id = ${who.session} RETURNING (started_at + interval '400 days')::text AS deadline`)
    : boundary === "alias" ? await query(sql => sql<{ deadline: string }>`UPDATE host_sessions
      SET started_at = clock_timestamp() - interval '400 days' + interval '600 milliseconds'
      WHERE id = ${who.host} RETURNING (started_at + interval '400 days')::text AS deadline`)
    : await query(sql => sql<{ deadline: string }>`UPDATE sessions SET expires_at = clock_timestamp() + interval '600 milliseconds'
      WHERE id = ${who.session} RETURNING expires_at::text AS deadline`)
  return row!.deadline
}
const blocked = async (pid: number, deadline?: string) => expect.poll(async () => {
  const [row] = await query(sql => sql<{ live: boolean }>`SELECT (${deadline ?? null}::timestamptz IS NULL
    OR xact_start < ${deadline ?? null}::timestamptz) AS live FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`)
  return row?.live
}, { timeout: 5_000, interval: 10 }).toBe(true)
const cross = async (deadline: string) => {
  await query(sql => sql`SELECT pg_sleep(greatest(0, extract(epoch FROM ${deadline}::timestamptz - clock_timestamp())) + 0.01)`)
  expect(await query(sql => sql`SELECT clock_timestamp() >= ${deadline}::timestamptz AS ended`)).toEqual([{ ended: true }])
}

test.each(["secret put", "secret remove", "personal put", "personal remove", "personal link"].flatMap(operation =>
  ["home", "alias", "sliding"].map(boundary => ({ operation, boundary }))))(
  "$operation rolls back its mutation and audit after crossing the $boundary deadline", async ({ operation, boundary }) => {
    const who = await person(boundary === "alias")
    const repoId = `github/deadline/${crypto.randomUUID()}`, id = crypto.randomUUID(), invocationKey = crypto.randomUUID()
    const authority = WriteAuthority.protectedOf(who.actor)
    const sealed = { ciphertext: "sealed-fixture", nonce: "fixture", keyVersion: 1 }
    const secret = { ...sealed, repoId, name: "EXAMPLE", hosts: ["example.test"], methods: undefined,
      actorId: who.id, invocationKey: crypto.randomUUID() }
    const connection: Personal.ConnectionWrite = { id, kind: "codex_subscription", active: false,
      protocol: null, baseUrl: null, models: {}, sealed: { ...sealed, keyLast4: "seed" } }
    const isSecret = operation.startsWith("secret")
    if (isSecret) await runtime.runPromise(Secrets.put(secret))
    else await runtime.runPromise(Personal.put({ personId: who.id, connections: [connection], invocationKey: crypto.randomUUID() }))
    const write = () => operation === "secret put"
      ? Secrets.put({ ...secret, hosts: ["changed.example.test"], authority, invocationKey })
      : operation === "secret remove" ? Secrets.remove({ repoId, name: secret.name, actorId: who.id, authority, invocationKey })
      : operation === "personal put" ? Personal.put({ personId: who.id, connections: [{ ...connection, active: true }], authority, invocationKey })
      : operation === "personal remove" ? Personal.remove({ personId: who.id, authority, invocationKey })
      : Personal.link({ personId: who.id, id, generation: "0", sealed: { ...sealed, keyLast4: "next" }, authority, invocationKey })
    const held = await holdSql(runtime, sql => isSecret
      ? sql`SELECT 1 FROM secrets WHERE repo_id = ${repoId} FOR UPDATE`
      : sql`SELECT 1 FROM personal_models WHERE person_id = ${who.id} FOR UPDATE`)
    const deadline = await expires(who, boundary)
    const writing = runtime.runPromise(write())
    try { await blocked(held.pid, deadline); await cross(deadline) } finally { await held.release() }
    expect(await writing).toBe("stale")
    if (isSecret) {
      expect(await query(sql => sql`SELECT hosts FROM secrets WHERE repo_id = ${repoId}`)).toEqual([{ hosts: ["example.test"] }])
      expect(await query(sql => sql`SELECT id FROM secret_events WHERE invocation_key = ${invocationKey}`)).toEqual([])
    } else {
      expect(await query(sql => sql`SELECT id, active, key_last4 FROM personal_models WHERE person_id = ${who.id}`))
        .toEqual([{ id, active: false, key_last4: "seed" }])
      expect(await query(sql => sql`SELECT id FROM personal_model_events WHERE invocation_key = ${invocationKey}`)).toEqual([])
    }
    await query(sql => sql`UPDATE sessions SET started_at = clock_timestamp(), expires_at = clock_timestamp() + interval '1 day'
      WHERE id = ${who.session}`)
    if (who.host !== undefined) await query(sql => sql`UPDATE host_sessions SET started_at = clock_timestamp() WHERE id = ${who.host}`)
    expect(await runtime.runPromise(write())).toBe(operation.endsWith("remove") ? "deleted" : "replace")
    expect(await runtime.runPromise(write())).toBe("repeat")
  }, 30_000)

test.each(["enable", "pause"].flatMap(operation => ["home", "alias", "sliding"].map(boundary => ({ operation, boundary }))))(
  "triage $operation rolls back its settings and settlement after crossing the $boundary deadline", async ({ operation, boundary }) => {
    const who = await person(boundary === "alias"), id = crypto.randomUUID(), repoId = `github/deadline/${crypto.randomUUID()}`
    await runtime.runPromise(Triage.enable(repoId, { actorId: who.id, login: null, dailyTokens: 10 }))
    const authority = WriteAuthority.protectedOf(who.actor)
    const payload = operation === "enable" ? { op: "triage/enable" as const, dailyTokens: 20, authority }
      : { op: "triage/pause" as const, authority }
    await runtime.runPromise(GitHubStore.insertWrite({ id, repoId, actorId: who.id, sessionId: who.session,
      via: "person", payload, payloadHash: digestSync(JSON.stringify(payload)) }))
    const database = (await runtime.runPromise(TestDatabase.Scratch)).database
    const http = await Effect.runPromise(HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer)))
    // GitHub is unavailable: these local settings operations must never ask for a token or make a network write.
    let tokenCalls = 0
    const unavailable = () => Effect.andThen(Effect.sync(() => tokenCalls++), new TokenUnavailable({ reason: "unavailable" }))
    const send = GitHubWrite.steps({ database, http, tokens: { forSession: unavailable, forInstallation: unavailable },
      apiBaseUrl: "http://127.0.0.1:1", appLogin: "unavailable", mayAct: () => true }).send
    const metrics: Metric.MetricRegistry = new Map()
    const held = await holdSql(runtime, sql => sql`SELECT 1 FROM triage_settings WHERE repo_id = ${repoId} FOR UPDATE`)
    const deadline = await expires(who, boundary)
    const writing = Effect.runPromise(Effect.result(send({ writeId: id })).pipe(Effect.provideService(Metric.MetricRegistry, metrics)))
    try { await blocked(held.pid, deadline); await cross(deadline) } finally { await held.release() }
    expect(await writing).toMatchObject({ _tag: "Failure", failure: { _tag: "@smthrs/mvp/github/WriteUnavailable" } })
    expect(await query(sql => sql`SELECT paused, daily_tokens::int FROM triage_settings WHERE repo_id = ${repoId}`))
      .toEqual([{ paused: false, daily_tokens: 10 }])
    expect(await query(sql => sql`SELECT status FROM github_writes WHERE id = ${id}`)).toEqual([{ status: "pending" }])
    expect(Effect.runSync(Metric.value(Metric.withAttributes(GitHubMetrics.writes, {
      op: payload.op, outcome: "done", token: "none",
    })).pipe(Effect.provideService(Metric.MetricRegistry, metrics))).count).toBe(0)
    // A durable retry can arrive before sign-in recovers. It must not turn this retained write terminal.
    expect(await Effect.runPromise(Effect.result(send({ writeId: id })).pipe(Effect.provideService(Metric.MetricRegistry, metrics)))).toMatchObject({
      _tag: "Failure", failure: { _tag: "@smthrs/mvp/github/WriteUnavailable" },
    })
    expect(Effect.runSync(Metric.value(Metric.withAttributes(ProtectedAuthority.checks, { outcome: "unavailable" }))
      .pipe(Effect.provideService(Metric.MetricRegistry, metrics))).count).toBe(1)
    expect(await query(sql => sql`SELECT status, failure, settled_at FROM github_writes WHERE id = ${id}`))
      .toEqual([{ status: "pending", failure: null, settled_at: null }])
    await query(sql => sql`UPDATE sessions SET started_at = clock_timestamp(), expires_at = clock_timestamp() + interval '1 day'
      WHERE id = ${who.session}`)
    if (who.host !== undefined) await query(sql => sql`UPDATE host_sessions SET started_at = clock_timestamp() WHERE id = ${who.host}`)
    expect(await Effect.runPromise(send({ writeId: id }))).toMatchObject({ status: "done" })
    expect(await Effect.runPromise(send({ writeId: id }))).toMatchObject({ status: "done" })
    expect(tokenCalls).toBe(0)
  }, 30_000)

test.each(["enable", "pause"].flatMap(operation => ["home", "alias"].map(boundary => ({ operation, boundary }))))(
  "triage $operation retains its write while its $boundary cookie key is stale", async ({ operation, boundary }) => {
    const who = await person(boundary === "alias"), id = crypto.randomUUID(), repoId = `github/rekey/${crypto.randomUUID()}`
    await runtime.runPromise(Triage.enable(repoId, { actorId: who.id, login: null, dailyTokens: 10 }))
    const authority = WriteAuthority.protectedOf(who.actor)
    const payload = operation === "enable" ? { op: "triage/enable" as const, dailyTokens: 20, authority }
      : { op: "triage/pause" as const, authority }
    await runtime.runPromise(GitHubStore.insertWrite({ id, repoId, actorId: who.id, sessionId: who.session,
      via: "person", payload, payloadHash: digestSync(JSON.stringify(payload)) }))
    const database = (await runtime.runPromise(TestDatabase.Scratch)).database
    const http = await Effect.runPromise(HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer)))
    let tokenCalls = 0
    const unavailable = () => Effect.andThen(Effect.sync(() => tokenCalls++), new TokenUnavailable({ reason: "unavailable" }))
    const send = GitHubWrite.steps({ database, http, tokens: { forSession: unavailable, forInstallation: unavailable },
      apiBaseUrl: "http://127.0.0.1:1", appLogin: "unavailable", mayAct: () => true }).send
    const metrics: Metric.MetricRegistry = new Map()
    const attempt = () => Effect.runPromise(Effect.result(send({ writeId: id })).pipe(
      Effect.provideService(SigningKeyIds, ["legacy", "next"]), Effect.provideService(Metric.MetricRegistry, metrics)))
    const stamp = (key: string) => query(sql => boundary === "home"
      ? sql`UPDATE sessions SET cookie_key = ${key} WHERE id = ${who.session}`
      : sql`UPDATE host_sessions SET cookie_key = ${key} WHERE id = ${who.host}`)
    await stamp("next")
    for (let retry = 0; retry < 2; retry++) {
      expect(await attempt()).toMatchObject({ _tag: "Failure", failure: { _tag: "@smthrs/mvp/github/WriteUnavailable" } })
      expect(await query(sql => sql`SELECT status, failure, settled_at FROM github_writes WHERE id = ${id}`))
        .toEqual([{ status: "pending", failure: null, settled_at: null }])
    }
    expect(await query(sql => sql`SELECT paused, daily_tokens::int FROM triage_settings WHERE repo_id = ${repoId}`))
      .toEqual([{ paused: false, daily_tokens: 10 }])
    expect(Effect.runSync(Metric.value(Metric.withAttributes(ProtectedAuthority.checks, { outcome: "unavailable" }))
      .pipe(Effect.provideService(Metric.MetricRegistry, metrics))).count).toBe(2)
    // Only fresh same-ID admission can replace this authority; TriageReauthorization exercises real sign-in.
    expect(tokenCalls).toBe(0)
  })

test.each(["enable", "pause"] as const)("triage %s keeps a confirmed permission denial terminal", async operation => {
  const who = await person(false), id = crypto.randomUUID(), repoId = `github/denied/${crypto.randomUUID()}`
  await runtime.runPromise(Triage.enable(repoId, { actorId: who.id, login: null, dailyTokens: 10 }))
  const authority = WriteAuthority.protectedOf(who.actor)
  const payload = operation === "enable" ? { op: "triage/enable" as const, dailyTokens: 20, authority }
    : { op: "triage/pause" as const, authority }
  await runtime.runPromise(GitHubStore.insertWrite({ id, repoId, actorId: who.id, sessionId: who.session,
    via: "person", payload, payloadHash: digestSync(JSON.stringify(payload)) }))
  const database = (await runtime.runPromise(TestDatabase.Scratch)).database
  const http = await Effect.runPromise(HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer)))
  let tokenCalls = 0
  const unavailable = () => Effect.andThen(Effect.sync(() => tokenCalls++), new TokenUnavailable({ reason: "unavailable" }))
  const send = GitHubWrite.steps({ database, http, tokens: { forSession: unavailable, forInstallation: unavailable },
    apiBaseUrl: "http://127.0.0.1:1", appLogin: "unavailable", mayAct: () => true }).send
  const metrics: Metric.MetricRegistry = new Map()
  const attempt = () => Effect.runPromise(send({ writeId: id }).pipe(Effect.provideService(Metric.MetricRegistry, metrics)))
  await query(sql => sql`UPDATE sessions SET role = 'member', role_checked_at = clock_timestamp(),
    role_verified_at = clock_timestamp() WHERE id = ${who.session}`)
  expect(await attempt()).toMatchObject({ status: "refused" })
  expect(await query(sql => sql`SELECT status, failure FROM github_writes WHERE id = ${id}`))
    .toEqual([{ status: "refused", failure: "not_allowed" }])
  await query(sql => sql`UPDATE sessions SET role = 'admin', role_checked_at = clock_timestamp(),
    role_verified_at = clock_timestamp() WHERE id = ${who.session}`)
  expect(await attempt()).toMatchObject({ status: "refused" })
  expect(Effect.runSync(Metric.value(Metric.withAttributes(ProtectedAuthority.checks, { outcome: "denied" }))
    .pipe(Effect.provideService(Metric.MetricRegistry, metrics))).count).toBe(1)
  expect(await query(sql => sql`SELECT paused, daily_tokens::int FROM triage_settings WHERE repo_id = ${repoId}`))
    .toEqual([{ paused: false, daily_tokens: 10 }])
  expect(tokenCalls).toBe(0)
})

test.each(["home", "alias", "sliding"] as const)("a TODO commit rolls back after a stack lock crosses its %s deadline", async boundary => {
  const who = await person(boundary === "alias")
  const h = await stackHarness(runtime, { actor: who.actor })
  await query(sql => sql`INSERT INTO stacks (repo_id) VALUES ('github/octo/hello')`)
  const held = await holdSql(runtime, sql => sql`SELECT 1 FROM stacks WHERE repo_id = 'github/octo/hello' FOR UPDATE`)
  const deadline = await expires(who, boundary)
  const opId = crypto.randomUUID()
  const writing = h.fetch(stackRoute("octo", "hello"), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ opId, op: "commit", title: "Deadline", prompt: "Deadline" }) })
  try { await blocked(held.pid, deadline); await cross(deadline) } finally { await held.release() }
  const response = await writing
  expect([response.status, await response.json()]).toEqual([503, { code: "unavailable" }])
  expect(await query(sql => sql`SELECT id FROM todos WHERE id = ${opId}`)).toEqual([])
  expect(await query(sql => sql`SELECT id FROM stack_ops WHERE id = ${opId}`)).toEqual([])
  expect(await query(sql => sql`SELECT next_number, version::int FROM stacks WHERE repo_id = 'github/octo/hello'`))
    .toEqual([{ next_number: 1, version: 0 }])
})

const endings = ["absolute", "rekey", "revoke"] as const
test.each(["home", "alias"].flatMap(boundary => endings.map(ending => ({ boundary, ending }))))(
  "a coedit insert retains $boundary authority across a unique-index wait and $ending", async ({ boundary, ending }) => {
    const who = await person(boundary === "alias")
    const branch = await tracked(runtime, "github/smithersai/smithers", `wait-${crypto.randomUUID()}`, "open", who.id)
    const textId = crypto.randomUUID(), id = crypto.randomUUID()
    const update = await runtime.runPromise(Effect.scoped(Effect.flatMap(SharedText.make, text => text.replace("held edit"))))
    const data = Base64.encode(update!)
    let actor = who.actor
    const h = await branchHarness(runtime, { sessions: Layer.succeed(Sessions, Sessions.of({ resolve: Effect.sync(() => Option.some(actor)) })),
      config: { SESSION_SECRETS: JSON.stringify({ legacy: "l".repeat(64), next: "n".repeat(64) }) } })
    const body = JSON.stringify({ id, scope: { conversation: branch.conversationId }, update: data })
    const send = () => h.fetch(textRoute(textId), { method: "POST", body })
    const held = await holdSql(runtime, sql => sql`INSERT INTO text_updates (id, scope, text_id, data, seed, person_id)
      VALUES (${id}, ${`branch:${branch.branchId}`}, ${textId}, ${data}, false, ${who.id})`)
    const deadline = ending === "absolute" ? await expires(who, boundary) : undefined
    const writing = send()
    try {
      await blocked(held.pid, deadline)
      if (deadline !== undefined) await cross(deadline)
      else if (ending === "rekey") {
        if (who.host === undefined) await query(sql => sql`UPDATE sessions SET cookie_key = 'next' WHERE id = ${who.session}`)
        else await query(sql => sql`UPDATE host_sessions SET cookie_key = 'next' WHERE id = ${who.host}`)
      } else {
        if (who.host === undefined) await query(sql => sql`UPDATE sessions SET revoked_at = clock_timestamp(), revoked_reason = 'sign_out' WHERE id = ${who.session}`)
        else await query(sql => sql`UPDATE host_sessions SET revoked_at = clock_timestamp() WHERE id = ${who.host}`)
      }
    } finally { await held.release() }
    const response = await writing
    expect([response.status, await response.json()]).toEqual([503, { code: "unavailable" }])
    expect(await query(sql => sql`SELECT id FROM text_updates WHERE id = ${id}`)).toEqual([])
    const fresh = await person(false)
    actor = { ...fresh.actor, subject: { kind: "person", id: who.id } }
    await query(sql => sql`UPDATE sessions SET person_id = ${who.id} WHERE id = ${fresh.session}`)
    expect((await send()).status).toBe(200)
    const repeat = await send()
    expect([repeat.status, await repeat.json()]).toEqual([200, { txid: null }])
    expect(await query(sql => sql`SELECT id FROM text_updates WHERE id = ${id}`)).toEqual([{ id }])
  }, 30_000)


test.each(["home", "alias"])("a coedit insert never waits on the %s session row lock", async boundary => {
  const who = await person(boundary === "alias")
  const branch = await tracked(runtime, "github/smithersai/smithers", `unlocked-${crypto.randomUUID()}`, "open", who.id)
  const textId = crypto.randomUUID(), id = crypto.randomUUID()
  const update = await runtime.runPromise(Effect.scoped(Effect.flatMap(SharedText.make, text => text.replace("edit"))))
  const h = await branchHarness(runtime, { sessions: Layer.succeed(Sessions, Sessions.of({ resolve: Effect.succeed(Option.some(who.actor)) })) })
  const held = await holdSql(runtime, sql => boundary === "home"
    ? sql`SELECT 1 FROM sessions WHERE id = ${who.session} FOR UPDATE`
    : sql`SELECT 1 FROM host_sessions WHERE id = ${who.host} FOR UPDATE`)
  try {
    const response = await h.fetch(textRoute(textId), { method: "POST", body: JSON.stringify({
      id, scope: { conversation: branch.conversationId }, update: Base64.encode(update!),
    }) })
    expect(response.status).toBe(200)
    expect(await query(sql => sql`SELECT id FROM text_updates WHERE id = ${id}`)).toEqual([{ id }])
  } finally { await held.release() }
})
