import { digestSync } from "@smthrs/crypto"
import { Deferred, Effect, Metric, Option, Redacted } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import { DEVICE_PERSON_HEADER, type SessionState } from "../src/features/auth/contract.ts"
import * as Rotation from "./SessionSigningKeys.ts"
import { SigningKeyIds } from "./SessionStore.ts"
import { repositoryOf } from "#vibelang/emitted/worker/github/Config"
import * as Writes from "./github/Store.ts"
import * as Write from "./github/Write.ts"
import * as Metrics from "#vibelang/emitted/worker/github/Metrics"
import * as RepoRoles from "./github/RepoRoles.ts"
import * as Triage from "./github/TriageStore.ts"
import { TokenUnavailable } from "./github/Tokens.ts"
import { githubHarness } from "./github/test/harness.ts"
import { testFile } from "./test/harness.ts"
import { holdSql } from "./test/sqlWait.ts"
import { configured, cookie, SECRET, setCookies, signInHarness } from "./test/signIn.ts"

const runtime = testFile("triage_reauthorization")
const query = <A extends object>(f: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, f))
const nextKey = crypto.randomUUID().padEnd(64, "x")
const config = { ...configured, SESSION_SECRETS: JSON.stringify({ legacy: SECRET, next: nextKey }), SESSION_SEAL_SECRET: SECRET,
  APP_DOMAIN: "smithers.test", APP_ALIASES: "alias.test=/" }
const values = (response: Response) => Object.fromEntries(Object.entries(setCookies(response))
  .filter(([, c]) => c.value !== "").map(([k, c]) => [k, c.value]))
const repo = repositoryOf("smithersai/smithers")

beforeEach(async () => {
  await query(sql => sql`TRUNCATE sessions, sign_in_attempts, people, github_writes, triage_settings CASCADE`)
  await query(sql => sql`DELETE FROM session_signing_keys`)
  await query(sql => sql`INSERT INTO session_signing_keys (key_id, state, promoted_at) VALUES ('legacy', 'issuer', now())`)
})

test.each(["enable", "pause"].flatMap(operation => ["home", "alias"].flatMap(boundary =>
  ["send", "give-up"].map(phase => ({ operation, boundary, phase })))))(
  "triage $operation recovers the same pending write after actual $boundary reauthentication during $phase", async ({ operation, boundary, phase }) => {
    const auth = await signInHarness(runtime, { config })
    auth.github.permission = "admin"
    const first = await auth.signInAs()
    expect(first.response.status).toBe(303)
    const [person] = await query(sql => sql<{ id: string; session: string }>`SELECT person_id::text AS id, id::text AS session FROM sessions`)
    const handoff = async (home: Record<string, string>, previous: Record<string, string> = {}) => {
      const pressed = await auth.at("http://alias.test/api/auth/sign-in?return=%2Fapp", { headers: { "sec-fetch-site": "same-origin" } })
      expect(pressed.status).toBe(302)
      const handed = await auth.at(pressed.headers.get("location")!, { headers: { cookie: cookie(home) } })
      expect(handed.status).toBe(303)
      const code = new URLSearchParams(new URL(handed.headers.get("location")!).hash.slice(1)).get("code")!
      const arrived = await auth.at("http://alias.test/api/auth/arrive", {
        method: "POST", body: new URLSearchParams({ code }).toString(), headers: {
          "content-type": "application/x-www-form-urlencoded", origin: "http://alias.test",
          cookie: cookie({ ...previous, ...values(pressed) }),
        },
      })
      expect(arrived.status).toBe(303)
      return values(arrived)
    }
    const presented = boundary === "home" ? first.cookies : await handoff(first.cookies)
    const origin = boundary === "home" ? "http://smithers.test" : "http://alias.test"
    const app = await githubHarness(runtime, { own: repo, sessions: auth.sessions })
    const id = crypto.randomUUID()
    const body = operation === "enable" ? { writeId: id, op: "triage/enable", dailyTokens: 20 }
      : { writeId: id, op: "triage/pause" }
    const submit = (cookies: Record<string, string>, payload: unknown = body, owner = person!.id) => app.fetch(`${origin}/api/repos/smithersai/smithers/writes`, {
      method: "POST", body: JSON.stringify(payload), headers: { cookie: cookie(cookies), [DEVICE_PERSON_HEADER]: owner },
    })
    await runtime.runPromise(Triage.enable(repo.id, { actorId: person!.id, login: "test", dailyTokens: 10 }))
    expect((await submit(presented)).status).toBe(202)
    const row = () => runtime.runPromise(Writes.writeOf(id)).then(Option.getOrThrow)
    const before = await row()
    expect(before.payload).toMatchObject({ authority: { cookieKey: "legacy", sessionId: person!.session } })
    await runtime.runPromise(Rotation.stage("next", Redacted.make(nextKey)))
    await runtime.runPromise(Rotation.promote("next"))
    const started = await auth.start()
    const renewed = await auth.callback(auth.github.approve(started.location), {
      ...first.cookies, smithers_sign_in: started.cookies.smithers_sign_in!.value,
    })
    expect(renewed.status).toBe(303)
    const fresh = boundary === "home" ? values(renewed) : await handoff(values(renewed), presented)
    expect(await query(sql => sql`SELECT id::text, cookie_key AS key FROM sessions`))
      .toEqual([{ id: person!.session, key: "next" }])
    if (boundary === "alias") {
      expect(await query(sql => sql`SELECT id::text, cookie_key AS key FROM host_sessions`))
        .toEqual([{ id: (before.payload as { authority: { alias: string } }).authority.alias, key: "next" }])
    }
    const database = (await runtime.runPromise(TestDatabase.Scratch)).database
    const http = await Effect.runPromise(HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer)))
    let tokenCalls = 0
    const unavailable = () => Effect.andThen(Effect.sync(() => tokenCalls++), new TokenUnavailable({ reason: "unavailable" }))
    const steps = Write.steps({ database, http, tokens: { forSession: unavailable, forInstallation: unavailable },
      apiBaseUrl: "http://127.0.0.1:1", appLogin: "unavailable", mayAct: () => true })
    const send = (phase === "send" ? steps.send : steps.giveUp)({ writeId: id })
    const attempt = () => Effect.runPromise(Effect.result(send).pipe(Effect.provideService(SigningKeyIds, ["legacy", "next"])))
    expect(await attempt()).toMatchObject({ _tag: "Failure", failure: { _tag: "@smthrs/mvp/github/WriteUnavailable" } })
    expect((await row()).status).toBe("pending")
    const changed = operation === "enable" ? { ...body, dailyTokens: 30 } : { ...body, op: "triage/enable", dailyTokens: 30 }
    expect((await submit(fresh, changed)).status).toBe(409)
    expect((await row()).payload).toEqual(before.payload)
    auth.github.person = { id: 900002, login: "other-admin" }
    const other = await auth.signInAs()
    expect(other.response.status).toBe(303)
    const otherState = await auth.session(other.cookies) as SessionState
    if (!otherState.signedIn) throw new Error("expected the other person signed in")
    expect(otherState.personId).not.toBe(person!.id)
    const otherCookies = boundary === "home" ? other.cookies : await handoff(other.cookies)
    expect((await submit(otherCookies, body, otherState.personId!)).status).toBe(409)
    const captured = before.payload
    if (captured.op !== "triage/enable" && captured.op !== "triage/pause") throw new Error("expected triage write")
    const [stored] = await query(sql => sql<{ hash: string }>`SELECT payload_hash AS hash FROM github_writes WHERE id = ${id}::uuid`)
    expect(await runtime.runPromise(Writes.insertWrite({ id, repoId: "github/smithersai/another", actorId: person!.id,
      sessionId: person!.session, via: "person", payload: { ...captured, authority: { ...captured.authority!, cookieKey: "next" } },
      payloadHash: stored!.hash, reauthorize: true }))).toEqual({ kind: "taken" })
    expect((await row()).payload).toEqual(before.payload)
    // A contended admission has its own SQL bound and cannot quietly authorize after its caller gave up.
    const stalled = await holdSql(runtime, sql => sql`SELECT 1 FROM github_writes WHERE id = ${id}::uuid FOR UPDATE`)
    const waiting = submit(fresh)
    let bounded: unknown
    try { bounded = await Effect.runPromise(Effect.result(Effect.promise(() => waiting).pipe(Effect.timeout("2 seconds")))) }
    finally { await stalled.release(); await waiting }
    expect(bounded).toMatchObject({ _tag: "Success", success: { status: 503 } })
    expect((await row()).payload).toEqual(before.payload)
    // The executing attempt owns the write row while checking authority. A fresh request must wait behind it.
    const held = await holdSql(runtime, sql => sql`SELECT 1 FROM people WHERE id = ${person!.id}::uuid FOR UPDATE`)
    const executing = attempt()
    let resubmitting: Promise<Response> | undefined
    let responded = false
    try {
      await expect.poll(async () => (await query(sql => sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE ${held.pid} = ANY(pg_blocking_pids(pid))`))[0]!.n, { timeout: 1000, interval: 10 }).toBe(1)
      resubmitting = submit(fresh).then(response => { responded = true; return response })
      await expect.poll(async () => (await query(sql => sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity a
        WHERE EXISTS (SELECT 1 FROM pg_stat_activity b WHERE ${held.pid} = ANY(pg_blocking_pids(b.pid))
          AND b.pid = ANY(pg_blocking_pids(a.pid)))`))[0]!.n, { timeout: 1000, interval: 10 }).toBe(1)
      expect(responded).toBe(false)
    } finally { await held.release(); await Promise.allSettled([executing, ...(resubmitting === undefined ? [] : [resubmitting])]) }
    expect(await executing).toMatchObject({ _tag: "Failure", failure: { _tag: "@smthrs/mvp/github/WriteUnavailable" } })
    expect((await resubmitting!).status).toBe(200)
    expect(app.count(Metrics.writeRequests, { op: body.op, outcome: "reauthorized", repository: "own" })).toBe(1)
    expect((await row()).payload).toMatchObject({ authority: { cookieKey: "next", sessionId: person!.session } })
    expect(await attempt()).toMatchObject({ _tag: "Success", success: { status: "done" } })
    expect(await attempt()).toMatchObject({ _tag: "Success", success: { status: "done" } })
    expect((await row()).id).toBe(id)
    const settled = await row()
    expect((await submit(fresh)).status).toBe(200)
    expect(await row()).toEqual(settled)
    expect(app.count(Metrics.writeRequests, { op: body.op, outcome: "reauthorized", repository: "own" })).toBe(1)
    expect(await query(sql => sql`SELECT paused, daily_tokens::int FROM triage_settings WHERE repo_id = ${repo.id}`))
      .toEqual([{ paused: operation === "pause", daily_tokens: operation === "enable" ? 20 : 10 }])
    expect(tokenCalls).toBe(0)
  })

test.each(["allowed", "denied", "app absent", "settled"] as const)(
  "a role result from before reauthorization cannot settle the refreshed write: %s", async outcome => {
    const auth = await signInHarness(runtime, { config })
    auth.github.permission = "admin"
    const first = await auth.signInAs()
    expect(first.response.status).toBe(303)
    const [person] = await query(sql => sql<{ id: string; session: string }>`SELECT person_id::text AS id, id::text AS session FROM sessions`)
    const [observation] = await query(sql => sql<{ checkedAt: string }>`INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at)
      VALUES (${repo.id}, ${person!.id}::uuid, 'maintainer', clock_timestamp()) RETURNING checked_at::text AS "checkedAt"`)
    const held: RepoRoles.Held = { repoId: repo.id, personId: person!.id, role: "maintainer", checkedAt: observation!.checkedAt }
    const id = crypto.randomUUID()
    // Admit through the store's public boundary with a real repository role receipt.
    await runtime.runPromise(Writes.insertWrite({ id, repoId: repo.id, actorId: person!.id, sessionId: person!.session,
      via: "person", payload: { op: "triage/pause", authority: { personId: person!.id, sessionId: person!.session,
        cookieKey: "legacy", scope: { _tag: "Repo", held } } }, payloadHash: digestSync(JSON.stringify({ via: "person", op: "triage/pause" })) }))
    await runtime.runPromise(Triage.enable(repo.id, { actorId: person!.id, login: "test", dailyTokens: 10 }))
    const reached = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const database = (await runtime.runPromise(TestDatabase.Scratch)).database
    const http = await Effect.runPromise(HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer)))
    const unavailable = () => Effect.fail(new TokenUnavailable({ reason: "unavailable" }))
    const metrics: Metric.MetricRegistry = new Map()
    const send = Write.steps({ database, http, tokens: { forSession: unavailable, forInstallation: unavailable },
      apiBaseUrl: "http://127.0.0.1:1", appLogin: "unavailable", mayAct: () => true,
      roles: { repository: repo, resolve: () => Effect.gen(function* () {
        yield* Deferred.succeed(reached, undefined)
        yield* Deferred.await(release)
        if (outcome === "app absent") return yield* new RepoRoles.RoleRefused({ code: "app_not_installed" })
        return { role: outcome === "denied" ? null : "maintainer" as const,
          held: outcome === "denied" ? Option.none<RepoRoles.Held>() : Option.some(held) }
      }) },
    }).send({ writeId: id })
    const attempt = () => Effect.runPromise(Effect.result(send).pipe(Effect.provideService(SigningKeyIds, ["legacy", "next"]),
      Effect.provideService(Metric.MetricRegistry, metrics)))
    const oldAttempt = attempt()
    try {
      await runtime.runPromise(Deferred.await(reached).pipe(Effect.timeout("5 seconds")))
      await runtime.runPromise(Rotation.stage("next", Redacted.make(nextKey)))
      await runtime.runPromise(Rotation.promote("next"))
      const started = await auth.start()
      const renewed = await auth.callback(auth.github.approve(started.location), {
        ...first.cookies, smithers_sign_in: started.cookies.smithers_sign_in!.value,
      })
      expect(renewed.status).toBe(303)
      const app = await githubHarness(runtime, { own: repo, sessions: auth.sessions })
      const response = await app.fetch("http://smithers.test/api/repos/smithersai/smithers/writes", {
        method: "POST", body: JSON.stringify({ writeId: id, op: "triage/pause" }),
        headers: { cookie: cookie(values(renewed)), [DEVICE_PERSON_HEADER]: person!.id },
      })
      expect(response.status).toBe(200)
      expect(Option.getOrThrow(await runtime.runPromise(Writes.writeOf(id))).payload)
        .toMatchObject({ authority: { cookieKey: "next" } })
      if (outcome === "settled") expect(await attempt()).toMatchObject({ _tag: "Success", success: { status: "done" } })
    } finally { await runtime.runPromise(Deferred.succeed(release, undefined)); await oldAttempt }
    expect(await oldAttempt).toMatchObject(outcome === "settled" ? { _tag: "Success", success: { status: "done" } }
      : { _tag: "Failure", failure: { _tag: "@smthrs/mvp/github/WriteUnavailable" } })
    expect(Effect.runSync(Metric.value(Metric.withAttributes(Metrics.writeAuthority, { op: "triage/pause", outcome: "superseded" }))
      .pipe(Effect.provideService(Metric.MetricRegistry, metrics))).count).toBe(outcome === "settled" ? 0 : 1)
    expect(Option.getOrThrow(await runtime.runPromise(Writes.writeOf(id))).status).toBe(outcome === "settled" ? "done" : "pending")
    expect(await attempt()).toMatchObject({ _tag: "Success", success: { status: "done" } })
    expect(await query(sql => sql`SELECT paused FROM triage_settings WHERE repo_id = ${repo.id}`)).toEqual([{ paused: true }])
  })
