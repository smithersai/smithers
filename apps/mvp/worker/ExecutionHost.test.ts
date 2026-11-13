import { TestSchemas } from "@smthrs/database"
// worker/ExecutionHost.ts in Node: the Durable Object's start and alarm handlers over the compose Postgres
// (`pnpm db:up`), with an in-memory stand-in for the object's storage, the one Cloudflare binding they take. The real
// object runs them in local workerd in worker/ExecutionHost.workerd.test.ts.
import * as Pg from "@effect/sql-pg"
import { Action, Flow, Interpreter, WaitFor } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { ConfigProvider, Context, Deferred, Duration, Effect, Fiber, Layer, Logger, Metric, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { describe, expect, onTestFailed, onTestFinished, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import * as ExecutionHost from "./ExecutionHost.ts"
import * as Flows from "./Flows.ts"
import * as TodoRuns from "./stack/TodoRuns.ts"
import * as DatabaseLoad from "./flows/DatabaseLoad.ts"
import * as SandboxSpend from "./flows/SandboxSpend.ts"
import * as BugReport from "./flows/BugReport.ts"
import * as Expire from "./flows/Expire.ts"
import * as Pause from "./flows/Pause.ts"
import { awaitPullClosed } from "./flows/TodoWait.ts"
import * as RecheckRole from "./flows/RecheckRole.ts"
import * as RepoClone from "./flows/RepoClone.ts"
import * as RepoRefresh from "./flows/RepoRefresh.ts"
import * as ReplacedTokens from "./flows/RevokeReplacedGitHubToken.ts"
import * as RevokeGitHubToken from "./flows/RevokeGitHubToken.ts"
import * as SpendAlert from "./flows/SpendAlert.ts"
import * as SessionKeys from "./SessionKeys.ts"
import * as RunnerAdmin from "./runners/AdminFlows.ts"
import { DEVICE_PERSON_HEADER, type SessionState } from "../src/features/auth/contract.ts"
import { cloneExecutionId } from "../src/features/repo/contract.ts"
import * as Repos from "./Repos.ts"
import { scripted } from "./test/codeStorage.ts"
import { answers, harness, row, testFile } from "./test/harness.ts"
import { repositoryRow, resetRepos } from "./test/repos.ts"
import { resetBranches, terminal, terminalRows, tracked } from "./test/branch.ts"
import { Sandboxes } from "./branch/Sandboxes.ts"
import { Machines } from "./branch/Machines.ts"
import * as SandboxCall from "./flows/SandboxCall.ts"
import * as SandboxCommand from "./flows/SandboxCommand.ts"
import * as SandboxKeep from "./flows/SandboxKeep.ts"
import * as DomainFlows from "./domains/DomainFlows.ts"
import { DomainProvider } from "./domains/Provider.ts"
import * as SecretFlows from "./secrets/SecretFlows.ts"
import { CodexAuth } from "./personal/Codex.ts"
import * as ModelFlows from "./personal/ModelFlows.ts"
import { SecretKeys } from "./secrets/Keys.ts"
import * as TerminalOpen from "./flows/TerminalOpen.ts"
import { openExecutionId } from "../src/features/terminal/contract.ts"
import { configured, cookie, SECRET, signInHarness } from "./test/signIn.ts"
import { FetchHttpClient, HttpClient } from "effect/http"
import { digestSync } from "@smthrs/crypto"
import * as SessionStore from "./SessionStore.ts"
import * as GitHubWrite from "./github/Write.ts"
import * as GitHubStore from "./github/Store.ts"
import * as TriageStore from "./github/TriageStore.ts"
import * as SecretStore from "./secrets/Store.ts"
import { TokenUnavailable } from "./github/Tokens.ts"
import * as ProtectedAuthority from "./ProtectedAuthority.ts"

// The app's own tables, for sign-in's role check (`auth/RecheckRole`) and `chat/Expire`, on a schema of this file's.
const app = testFile("execution_host")

/** The deployed flows' services over the app's tables on this file's schema, with answers expiring after `expiry`. */
const appServices = async (expiry: Duration.Input = Expire.DEFAULT_EXPIRY): Promise<Expire.Services<unknown>> => ({
  database: (await app.runPromise(Effect.service(TestDatabase.Scratch))).database,
  expiry: Duration.fromInputUnsafe(expiry),
})


/** A Durable Object's storage in memory: values cross it by structured clone, and it holds one alarm. */
const memory = () => {
  const values = new Map<string, unknown>()
  let alarm: number | null = null
  const storage: ExecutionHost.Storage = {
    get: <A>(key: string) => Effect.sync(() => structuredClone(values.get(key)) as A | undefined),
    put: (key, value) => Effect.sync(() => void values.set(key, structuredClone(value))),
    delete: (key) => Effect.sync(() => values.delete(key)),
    setAlarm: (at) => Effect.sync(() => void (alarm = at)),
    deleteAlarm: () => Effect.sync(() => void (alarm = null)),
  }
  return { storage, values, alarm: () => alarm }
}

/** A router that only records what it was handed: `probe/Pause` starts no child and wakes no parent. */
const recording = () => {
  const routed: Array<string> = []
  return {
    routed,
    router: {
      start: (intent: { readonly executionId: string }) =>
        Effect.sync(() => void routed.push(`start ${intent.executionId}`)),
      wake: (executionId: string) => Effect.sync(() => void routed.push(`wake ${executionId}`)),
    },
  }
}

/** Runs `use` with a fresh engine schema on the compose Postgres, dropped afterwards, and a client outside it. */
const withSchema = <A, E>(
  use: (schema: { readonly url: string; readonly name: string; readonly sql: SqlClient.SqlClient }) => Effect.Effect<
    A,
    E
  >,
) =>
  Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      const url = (yield* TestDatabase.serverUrl).toString()
      const admin = yield* Layer.build(Pg.PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }))
      const sql = Context.get(admin, SqlClient.SqlClient)
      const name = TestSchemas.schemaName("flows")
      yield* Effect.addFinalizer(() => Effect.orDie(sql`DROP SCHEMA IF EXISTS ${sql(name)} CASCADE`))
      return yield* use({ url, name, sql })
    })),
  )

const status = (sql: SqlClient.SqlClient, schema: string, executionId: string) =>
  Effect.orDie(
    sql<{ readonly status: string }>`SELECT status FROM ${sql(schema)}.flows_runs WHERE run_id = ${executionId}`,
  ).pipe(Effect.map((rows) => rows[0]?.status))

describe("ExecutionHost over the compose Postgres", () => {
  test("configured role window reaches request authorization without runtime Config", async () => {
    const auth = await signInHarness(app, { config: { ...configured, ROLE_RECHECK_MINUTES: "5" } })
    auth.github.permission = "admin"
    const signed = await auth.signInAs()
    expect(signed.response.status).toBe(303)
    const state = await auth.session(signed.cookies) as SessionState
    expect(state.signedIn).toBe(true)
    if (!state.signedIn || typeof state.personId !== "string") throw new Error("sign-in did not produce an owned session")
    onTestFinished(async () => { await app.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`DELETE FROM sessions WHERE person_id = ${state.personId}`)) })
    const [session] = await app.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql<{ id: string }>`UPDATE sessions
      SET role_verified_at = clock_timestamp() - interval '10 minutes' WHERE person_id = ${state.personId} RETURNING id`))
    const authority = { personId: state.personId, sessionId: session!.id, cookieKey: "legacy", scope: { _tag: "Deployment" as const } }
    const check = () => app.runPromise(ProtectedAuthority.check(authority, ["admin"]).pipe(Effect.provide(auth.sessions),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({}))))
    expect(await check()).toBe("unavailable")
    await app.runPromise(Effect.gen(function* () {
      yield* SessionStore.setRole(session!.id, "admin", yield* SessionStore.roleObservation, 0)
    }))
    expect(await check()).toBe("held")
  })

  test.each(["triage/enable", "triage/pause"].flatMap(op => ["admin", "member"].map(role => ({ op, role }))))(
    "configured role window keeps $op with expired $role authority pending without runtime Config", async ({ op, role }) => {
      let phase = "setup"
      onTestFailed(() => { console.error("configured-role-window", { op, role, phase }) })
      const services = await appServices()
      const person = crypto.randomUUID(), session = crypto.randomUUID(), writeId = crypto.randomUUID()
      onTestFinished(async () => { await app.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`DELETE FROM sessions WHERE id = ${session}`)) })
      const repoId = `github/host-window/${crypto.randomUUID()}`
      const authority = { personId: person, sessionId: session, cookieKey: "legacy", scope: { _tag: "Deployment" as const } }
      const payload = op === "triage/enable" ? { op: "triage/enable" as const, dailyTokens: 20, authority }
        : { op: "triage/pause" as const, authority }
      await app.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => Effect.gen(function* () {
        yield* sql`INSERT INTO people (id, github_id, github_login) VALUES (${person}, ${Math.floor(Math.random() * 1e9)}, 'window-person')`
        yield* sql`INSERT INTO sessions (id, token_digest, person_id, role, role_checked_at, role_verified_at, expires_at)
          VALUES (${session}, ${session}, ${person}, ${role}, clock_timestamp(), clock_timestamp() - interval '10 minutes', clock_timestamp() + interval '1 day')`
        yield* TriageStore.enable(repoId, { actorId: person, login: null, dailyTokens: 10 })
        yield* GitHubStore.insertWrite({ id: writeId, repoId, actorId: person, sessionId: session, via: "person", payload,
          payloadHash: digestSync(JSON.stringify(payload)) })
      })))
      const roleFreshMs = await Effect.runPromise(SessionStore.roleFreshMs.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ ROLE_RECHECK_MINUTES: "5" }))))
      expect(roleFreshMs).toBe(300_000)
      const http = await Effect.runPromise(HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer)))
      let tokenCalls = 0
      const unavailable = () => Effect.andThen(Effect.sync(() => tokenCalls++), new TokenUnavailable({ reason: "unavailable" }))
      await withSchema(({ name, url }) => Effect.gen(function* () {
        const object = memory()
        const options = { hostId: `window-${writeId}`, database: ExecutionHost.database(url, name), signingKeyIds: ["legacy"],
          roleFreshMs, router: recording().router, driveBudgetMs: 5_000,
          flows: { flows: [GitHubWrite.Write], registration: GitHubWrite.registration({ database: services.database, http,
            tokens: { forSession: unavailable, forInstallation: unavailable }, apiBaseUrl: "http://127.0.0.1:1", appLogin: "unavailable", mayAct: () => true }) } }
        const host = ExecutionHost.make(object.storage, options)
        yield* host.start(yield* ExecutionHost.intent(GitHubWrite.Write, { executionId: writeId, payload: { writeId } }))
        phase = "expired authority drive"
        expect(["Yielded", "Parked"]).toContain((yield* host.alarm())._tag)
        phase = "pending state and fresh role"
        yield* Effect.promise(() => app.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => Effect.gen(function* () {
          expect(yield* sql`SELECT status, failure, settled_at FROM github_writes WHERE id = ${writeId}`)
            .toEqual([{ status: "pending", failure: null, settled_at: null }])
          expect(yield* sql`SELECT paused, daily_tokens::int FROM triage_settings WHERE repo_id = ${repoId}`)
            .toEqual([{ paused: false, daily_tokens: 10 }])
          yield* SessionStore.setRole(session, "admin", yield* SessionStore.roleObservation, 0)
        }))))
        // Retried actions use database time. Keep the host clock live while those durable retry deadlines elapse.
        phase = "fresh authority recovery"
        let outcome = yield* host.alarm()
        for (let drives = 1; outcome._tag !== "Settled" && drives < 3; drives++) outcome = yield* host.alarm()
        expect(outcome._tag).toBe("Settled")
        phase = "recovered"
      }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({}))))
      expect(await app.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`SELECT status FROM github_writes WHERE id = ${writeId}`)))
        .toEqual([{ status: "done" }])
      expect(tokenCalls).toBe(0)
    }, 30_000,
  )

  test.each(["put", "delete"] as const)("configured role window refuses secret %s without runtime Config", async op => {
    const services = await appServices()
    const person = crypto.randomUUID(), session = crypto.randomUUID(), executionId = crypto.randomUUID()
    onTestFinished(async () => { await app.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`DELETE FROM sessions WHERE id = ${session}`)) })
    const repoId = `github/host-window/${crypto.randomUUID()}`
    const authority = { personId: person, sessionId: session, cookieKey: "legacy", scope: { _tag: "Deployment" as const } }
    await app.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => Effect.gen(function* () {
      yield* sql`INSERT INTO people (id, github_id, github_login) VALUES (${person}, ${Math.floor(Math.random() * 1e9)}, 'window-person')`
      yield* sql`INSERT INTO sessions (id, token_digest, person_id, role, role_checked_at, role_verified_at, expires_at)
        VALUES (${session}, ${session}, ${person}, 'admin', clock_timestamp(), clock_timestamp() - interval '10 minutes', clock_timestamp() + interval '1 day')`
      yield* SecretStore.put({ repoId, name: "EXAMPLE", ciphertext: "sealed-fixture", nonce: "fixture", keyVersion: 1,
        hosts: ["before.test"], methods: undefined, actorId: person, invocationKey: crypto.randomUUID() })
    })))
    const roleFreshMs = await Effect.runPromise(SessionStore.roleFreshMs.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({ ROLE_RECHECK_MINUTES: "5" }))))
    await withSchema(({ name, url }) => Effect.gen(function* () {
      const options = { hostId: `window-${executionId}`, database: ExecutionHost.database(url, name), signingKeyIds: ["legacy"],
        roleFreshMs, router: recording().router, driveBudgetMs: 5_000,
        flows: ExecutionHost.withSecrets(ExecutionHost.remote(services), services.database) }
      const host = ExecutionHost.make(memory().storage, options)
      const payload = { repoId, name: "EXAMPLE", actorId: person, authority }
      yield* host.start(op === "delete"
        ? yield* ExecutionHost.intent(SecretFlows.Delete, { executionId, payload })
        : yield* ExecutionHost.intent(SecretFlows.Put, { executionId, payload: { ...payload,
          sealed: { ciphertext: "sealed-fixture", nonce: "fixture" }, keyVersion: 1, hosts: ["after.test"] } }))
      expect((yield* host.alarm())._tag).toBe("Settled")
    }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({}))))
    expect(await app.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`SELECT hosts FROM secrets WHERE repo_id = ${repoId}`)))
      .toEqual([{ hosts: ["before.test"] }])
    expect(await app.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`SELECT action FROM secret_events WHERE repo_id = ${repoId}`)))
      .toEqual([{ action: "set" }])
  })

  test.each(["home", "alias", "removed key"] as const)("the production host retains captured signing keys for %s writes without ambient Config", async boundary => {
    const services = await appServices()
    const person = crypto.randomUUID(), session = crypto.randomUUID(), alias = boundary === "alias" ? crypto.randomUUID() : undefined
    const executionId = crypto.randomUUID()
    let stage = "seed"
    onTestFailed(() => console.error("execution.signing_keys", { boundary, stage }))
    try {
      await app.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => Effect.gen(function* () {
        yield* sql`INSERT INTO people (id, github_id, github_login) VALUES (${person}, ${Math.floor(Math.random() * 1e9)}, 'host-person')`
        yield* sql`INSERT INTO sessions (id, token_digest, person_id, role, role_checked_at, role_verified_at, expires_at, cookie_key)
          VALUES (${session}, ${session}, ${person}, 'admin', clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '1 day', 'next')`
        if (alias !== undefined) yield* sql`INSERT INTO host_sessions (id, token_digest, parent_id, host, cookie_key)
          VALUES (${alias}, ${alias}, ${session}, 'chat.test', 'next')`
      })))
      stage = "host"
      await withSchema(({ name, url }) => Effect.gen(function* () {
        const options = { hostId: `keys-${executionId}`, database: ExecutionHost.database(url, name), driveBudgetMs: 5_000,
          flows: ExecutionHost.withRunners(ExecutionHost.remote(services), services.database),
          signingKeyIds: boundary === "removed key" ? ["legacy"] : ["next"], router: recording().router }
        const host = ExecutionHost.make(memory().storage, options)
        yield* host.start(yield* ExecutionHost.intent(RunnerAdmin.AddRunner, { executionId, payload: {
          repoId: "github/host/keys", name: `key-${boundary.replaceAll(" ", "-")}`, tokenSha256: SessionKeys.digest(executionId),
          labels: [], capacity: 1, actorId: person, repoAuthorized: true,
          fence: { execution: executionId, expiresAt: Date.now() + 60_000, generation: 0,
            authority: { _tag: "Session", personId: person, sessionId: session, ...(alias === undefined ? {} : { alias }), cookieKey: "next" } },
        } }))
        stage = "alarm"
        expect((yield* host.alarm())._tag).toBe("Settled")
      }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({}))))
      stage = "receipt"
      expect(await app.runPromise(Effect.flatMap(SqlClient.SqlClient, sql =>
        sql`SELECT outcome FROM admin_receipts WHERE execution = ${executionId}`)))
        .toEqual([{ outcome: boundary === "removed key" ? "authorization_expired" : "set" }])
    } finally {
      await app.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => Effect.gen(function* () {
        yield* sql`DELETE FROM runners WHERE added_by = ${person}`
        yield* sql`DELETE FROM runner_changes WHERE changed_by = ${person}`
        yield* sql`DELETE FROM admin_receipts WHERE actor_id = ${person}`
        yield* sql`DELETE FROM sessions WHERE person_id = ${person}`
        yield* sql`DELETE FROM people WHERE id = ${person}`
      })))
    }
  })

  test("a durable sleep that comes due within the drive's hold finishes in the same alarm, never Undriven", () =>
    withSchema(({ name, sql, url }) =>
      Effect.gen(function* () {
        // 2026-10-22: a job's probe round parked on a 1 to 2 s sleep already due when the park committed; its alarm
        // answered Retrying(Undriven), and the next one rebuilt the runtime a backoff later to replay it.
        const object = memory()
        const marks: Array<string> = []
        const executionId = crypto.randomUUID()
        const host = ExecutionHost.make(object.storage, {
          hostId: `object-${executionId}`,
          database: ExecutionHost.database(url, name),
          flows: {
            flows: [Pause.Pause],
            registration: Pause.registration((label) => Effect.sync(() => marks.push(label)).pipe(Effect.as(label))),
          },
          router: recording().router,
        })
        yield* host.start(yield* ExecutionHost.intent(Pause.Pause, { executionId, payload: { label: "s", pauseMs: 1_000 } }))
        const settled = yield* host.alarm()
        expect(settled).toEqual({ _tag: "Settled", forgetAtMs: expect.any(Number) })
        expect(marks).toEqual(["s:before", "s:after"])
        expect(yield* status(sql, name, executionId)).toBe("completed")
      })
    ))

  test.each([true, false])("signal before park=%s survives host replacement and duplicate delivery", (early) =>
    withSchema(({ name, sql, url }) => Effect.gen(function* () {
      const Event = Flow.make("probe/Signal", {
        payload: {}, success: Schema.Json, error: WaitFor.WaitForRequestInvalid,
        body: Node.capture({ wait: WaitFor.action.name }, () => WaitFor.action.call({ name: "published" }).pipe(
          Node.andThen(WaitFor.action.call({ name: "merge" })),
        )),
      })
      const object = memory()
      const executionId = crypto.randomUUID()
      const make = () => ExecutionHost.make(object.storage, {
        hostId: `object-${executionId}`, database: ExecutionHost.database(url, name),
        flows: { flows: [Event], registration: Layer.merge(Interpreter.layer(Event), WaitFor.layer).pipe(
          Layer.provideMerge(Action.layerImplementations),
        ) },
        router: recording().router,
      })
      const host = make()
      yield* host.start(yield* ExecutionHost.intent(Event, { executionId, payload: {} }))
      expect((yield* host.alarm())._tag).toBe("Parked")
      expect(object.alarm()).toBeNull()
      if (early) yield* host.signal(WaitFor.deferred("merge").name)
      yield* host.signal(WaitFor.deferred("published").name)
      if (!early) {
        expect((yield* host.alarm())._tag).toBe("Parked")
        yield* host.signal(WaitFor.deferred("merge").name)
      }
      const restarted = make()
      yield* restarted.signal(WaitFor.deferred("merge").name)
      expect(object.alarm()).toBeLessThanOrEqual(Date.now())
      expect((yield* restarted.alarm())._tag).toBe("Settled")
      expect(yield* status(sql, name, executionId)).toBe("completed")
      const completions = yield* sql`SELECT * FROM ${sql(name)}.flows_deferred_completions
        WHERE execution_id = ${executionId}`
      expect(completions).toHaveLength(2)
    })))

  test("TODO event waits use an hourly durable fallback without failed attempts", () =>
    withSchema(({ name, sql, url }) => Effect.gen(function* () {
      let closed = false
      const Check = Action.make("probe/MergeFallback", { payload: {}, success: Schema.Void })
      const Fallback = Flow.make("probe/MergeFallback", {
        payload: {}, success: Schema.Void,
        body: Node.capture({ check: Check.name }, () => Check.call({})),
      })
      const object = memory()
      const executionId = crypto.randomUUID()
      const host = ExecutionHost.make(object.storage, {
        hostId: `object-${executionId}`, database: ExecutionHost.database(url, name),
        flows: { flows: [Fallback], registration: Interpreter.layerWithImplementations(Fallback,
          Check.toLayer(() => Effect.suspend(() => closed ? Effect.void : awaitPullClosed(1))),
        ).pipe(Layer.provideMerge(Action.layerImplementations)) },
        router: recording().router,
      })
      yield* host.start(yield* ExecutionHost.intent(Fallback, { executionId, payload: {} }))
      const before = Date.now()
      const parked = yield* host.alarm()
      expect(parked._tag).toBe("Parked")
      const due = object.alarm()!
      expect(due).toBeGreaterThan(before)
      expect(due).toBeLessThanOrEqual(Date.now() + 60 * 60_000)
      const attempts = yield* sql`SELECT state, error_json FROM ${sql(name)}.flows_attempts WHERE run_id = ${executionId}`
      expect(attempts.every((row) => row.error_json === null)).toBe(true)
      // The PR remains open past the old 70-second retry interval: no failed attempt or new attempt is made.
      const stillOpen = yield* Effect.gen(function* () {
        yield* TestClock.setTime(due + 1)
        return yield* host.alarm()
      }).pipe(Effect.provide(TestClock.layer()))
      expect(stillOpen._tag).toBe("Parked")
      expect(Math.abs(object.alarm()! - (due + 60 * 60_000))).toBeLessThanOrEqual(5)
      const after = yield* sql`SELECT state, error_json FROM ${sql(name)}.flows_attempts WHERE run_id = ${executionId}`
      expect(after).toEqual(attempts)
      // A lost webhook: the following hourly alarm re-enters the check and observes the terminal fact.
      closed = true
      const nextDue = object.alarm()!
      const settled = yield* Effect.gen(function* () { yield* TestClock.setTime(nextDue + 1); return yield* host.alarm() }).pipe(Effect.provide(TestClock.layer()))
      expect(settled._tag).toBe("Settled")
      expect(yield* status(sql, name, executionId)).toBe("completed")
    })))

  test("start wakes the object at once; alarms drive probe/Pause through its durable sleep to the end", () =>
    withSchema(({ name, sql, url }) =>
      Effect.gen(function* () {
        const object = memory()
        const routes = recording()
        const marks: Array<string> = []
        const executionId = crypto.randomUUID()
        const host = ExecutionHost.make(object.storage, {
          hostId: `object-${executionId}`,
          database: ExecutionHost.database(url, name),
          flows: {
            flows: [Pause.Pause],
            registration: Pause.registration((label) => Effect.sync(() => marks.push(label)).pipe(Effect.as(label))),
          },
          router: routes.router,
        })
        const before = Date.now()
        // Longer than the drive's hold for a wake due soon (`EngineStore.defaultHoldMs`, 5 s), so the first alarm parks
        // on the timer and the next one finishes the run.
        const payload = { label: "x", pauseMs: 8_000 }
        const intent = yield* ExecutionHost.intent(Pause.Pause, { executionId, payload })
        // An intent recorded by the standalone writer survives adoption by the composed handlers.
        yield* ExecutionHost.recordStart(object.storage, intent)
        expect(marks).toEqual([])
        yield* host.start(intent)
        expect(object.alarm()).toBeGreaterThanOrEqual(before)
        expect(object.alarm()).toBeLessThanOrEqual(Date.now())

        // The first alarm runs the first step and parks on the timer, with the alarm armed for it.
        const parked = yield* host.alarm()
        expect(parked._tag).toBe("Parked")
        expect(marks).toEqual(["x:before"])
        const wakeAt = parked._tag === "Parked" ? parked.wakeAtMs : null
        expect(wakeAt).toBeGreaterThanOrEqual(before + 8_000)
        expect(object.alarm()).toBe(wakeAt)
        expect(yield* status(sql, name, executionId)).toBe("suspended")

        // The wake-up at the armed time, as Cloudflare fires it: the second step, then the run settles and the alarm
        // waits out the object's retention window.
        yield* Effect.sleep(Math.max(0, wakeAt! - Date.now()))
        const settled = yield* host.alarm()
        expect(settled).toEqual({ _tag: "Settled", forgetAtMs: expect.any(Number) })
        const forgetAtMs = settled._tag === "Settled" ? settled.forgetAtMs : null
        expect(forgetAtMs! - Date.now()).toBeGreaterThan(ExecutionHost.settledRetentionMs - 60_000)
        expect(object.alarm()).toBe(forgetAtMs)
        expect(marks).toEqual(["x:before", "x:after"])
        expect(yield* status(sql, name, executionId)).toBe("completed")
        expect(routes.routed).toEqual([])

        // The final alarm, a day later, forgets the execution: the object's storage is empty and no alarm is armed.
        // The run and its result stay in the engine's schema.
        const forgotten = yield* Effect.gen(function* () {
          yield* TestClock.setTime(forgetAtMs!)
          return yield* host.alarm()
        }).pipe(Effect.provide(TestClock.layer()))
        expect(forgotten).toEqual({ _tag: "Forgotten" })
        expect(object.values.size).toBe(0)
        expect(object.alarm()).toBeNull()
        expect(yield* host.wake()).toBe(false)
        expect(yield* status(sql, name, executionId)).toBe("completed")
      })
    ))

  test("every start and alarm is one log line and one count by outcome, never the payload", () =>
    withSchema(({ name, url }) =>
      Effect.gen(function* () {
        const lines: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
        const logger = Logger.make((options) => void lines.push(StructuredLogger.formatStructured.log(options)))
        const registry: Metric.MetricRegistry = new Map()
        const object = memory()
        const executionId = crypto.randomUUID()
        const host = ExecutionHost.make(object.storage, {
          hostId: `object-${executionId}`,
          database: ExecutionHost.database(url, name),
          flows: { flows: [Pause.Pause], registration: Pause.registration(Effect.succeed) },
          router: recording().router,
        })
        const sentinel = "SENTINEL-payload-text"
        const value = yield* ExecutionHost.intent(Pause.Pause, {
          executionId,
          payload: { label: sentinel, pauseMs: 0 },
        })
        yield* Effect.gen(function* () {
          yield* host.start(value)
          yield* host.start(value)
          yield* host.alarm()
        }).pipe(
          Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
          Effect.provideService(Metric.MetricRegistry, registry),
        )
        const records = lines.filter((line) => String(line.message).startsWith("cloudflare.execution."))
        expect(records.map((line) => [line.message, line.annotations.outcome])).toEqual([
          ["cloudflare.execution.request", undefined],
          ["cloudflare.execution.start", "accepted"],
          ["cloudflare.execution.request", undefined],
          ["cloudflare.execution.start", "duplicate"],
          ["cloudflare.execution.ready", undefined],
          ["cloudflare.execution.alarm", "settled"],
        ])
        expect(JSON.stringify(records)).not.toContain(sentinel)
        const snapshot = Effect.runSync(Metric.snapshot.pipe(Effect.provideService(Metric.MetricRegistry, registry)))
        const count = (metric: string, outcome: string) =>
          snapshot.filter((entry) => entry.id === metric && entry.attributes?.outcome === outcome)
            .map((entry) => (entry.state as { readonly count: number }).count)[0]
        expect(count("smithers_cloudflare_execution_starts", "accepted")).toBe(1)
        expect(count("smithers_cloudflare_execution_starts", "duplicate")).toBe(1)
        expect(count("smithers_cloudflare_execution_alarms", "settled")).toBe(1)
      })
    ))

  test("wake makes a held execution due at once, and leaves an object without one idle", async () => {
    const services = await appServices()
    await withSchema(({ name, url }) =>
      Effect.gen(function* () {
        const object = memory()
        const executionId = crypto.randomUUID()
        const host = ExecutionHost.make(object.storage, {
          hostId: `object-${executionId}`,
          database: ExecutionHost.database(url, name),
          flows: ExecutionHost.remote(services),
          router: recording().router,
        })
        yield* host.signal(WaitFor.deferred("before-start").name)
        expect(yield* host.wake()).toBe(false)
        expect(object.alarm()).toBeNull()
        const payload = { label: "z", pauseMs: 60_000 }
        yield* host.start(yield* ExecutionHost.intent(Pause.Pause, { executionId, payload }))
        expect((yield* host.alarm())._tag).toBe("Parked")
        expect(object.alarm()).toBeGreaterThan(Date.now() + 30_000)
        const before = Date.now()
        expect(yield* host.wake()).toBe(true)
        expect(object.alarm()).toBeGreaterThanOrEqual(before)
        expect(object.alarm()).toBeLessThanOrEqual(Date.now())
      })
    )
  })

  test("the deployed flows run probe/Pause with logging steps, in the engine's schema", async () => {
    const services = await appServices()
    await withSchema(({ name, sql, url }) =>
      Effect.gen(function* () {
        const flows = ExecutionHost.remote(services)
        expect(flows.flows).toEqual([
          Pause.Pause,
          Expire.Expire,
          SpendAlert.SpendAlert,
          DatabaseLoad.DatabaseLoad,
          DatabaseLoad.DatabaseLoadV2,
          SandboxSpend.SandboxSpend,
          BugReport.BugReport,
        ])
        const object = memory()
        const executionId = crypto.randomUUID()
        const host = ExecutionHost.make(object.storage, {
          hostId: `object-${executionId}`,
          database: ExecutionHost.database(url, name),
          flows,
          router: recording().router,
        })
        const payload = { label: "y", pauseMs: 0 }
        yield* host.start(yield* ExecutionHost.intent(Pause.Pause, { executionId, payload }))
        expect(yield* host.alarm()).toMatchObject({ _tag: "Settled" })
        expect(yield* status(sql, name, executionId)).toBe("completed")
      })
    )
  })

  test("the deployed flows run chat/Expire: it parks on its timer, then settles the answer abandoned", async () => {
    const h = await harness(app, answers("never"), {
      actor: { subject: { kind: "person", id: "person-member" }, role: "member" },
    })
    const answerId = crypto.randomUUID()
    const asked = await h.ask({ id: crypto.randomUUID(), answerId, text: "Asked, then the phone was shut" })
    expect(asked.status).toBe(202)
    // ChatApi started the expiry, as it asks the Durable Object to: the execution of the attempt that stored the answer.
    const executionId = h.starts[0]!.executionId
    expect(executionId).toMatch(new RegExp(`^${Expire.executionId(answerId)}-\\d+$`))
    expect(h.starts).toEqual([{ flow: "chat/Expire", executionId, payload: { answerId } }])
    // Use the production expiry: a shortened deadline can enter the host's five-second hold during setup.
    const services = await appServices()
    await withSchema(({ name, sql, url }) =>
      Effect.gen(function* () {
        const object = memory()
        const host = ExecutionHost.make(object.storage, {
          hostId: `object-${executionId}`,
          database: ExecutionHost.database(url, name),
          flows: ExecutionHost.remote(services),
          router: recording().router,
        })
        yield* host.start(yield* ExecutionHost.intent(Expire.Expire, { executionId, payload: { answerId } }))

        // The first alarm finds the answer young and parks on the durable timer, with the alarm armed for it.
        const parked = yield* host.alarm()
        expect(parked._tag).toBe("Parked")
        const wakeAt = parked._tag === "Parked" ? parked.wakeAtMs : null
        expect(object.alarm()).toBe(wakeAt)
        expect(yield* status(sql, name, executionId)).toBe("suspended")

        // Advance both time domains: Postgres owns the answer age, and the host owns the durable timer.
        const [aged] = yield* Effect.flatMap(SqlClient.SqlClient, (appSql) => appSql`
          UPDATE messages SET updated_at = updated_at - make_interval(secs => ${Duration.toSeconds(services.expiry)})
          WHERE id = ${answerId} RETURNING status`).pipe(Effect.provide(services.database))
        expect(aged).toMatchObject({ status: "streaming" })
        const settled = yield* Effect.gen(function* () {
          yield* TestClock.setTime(wakeAt! + 1)
          return yield* host.alarm()
        }).pipe(Effect.provide(TestClock.layer()))
        expect(settled).toMatchObject({ _tag: "Settled" })
        expect(object.alarm()).toBe(settled._tag === "Settled" ? settled.forgetAtMs : null)
        expect(yield* status(sql, name, executionId)).toBe("completed")
      })
    )
    expect(await row(app, answerId)).toMatchObject({ status: "failed", failure: "abandoned" })
  })

  test("the deployed flows run ops/SpendAlert: a model call starts it; once its window ends, it records the alert", async () => {
    const h = await harness(app, answers("spent"), {
      actor: { subject: { kind: "person", id: "person-member" }, role: "member" },
      config: { MODEL_SPEND_ALERT_WINDOW: "1 second" },
    })
    await app.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE model_usage, spend_alerts`))
    const call = await h.fetch("/api/model/agent", {
      method: "POST",
      body: JSON.stringify({
        modelId: "m",
        system: [],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [],
        params: {},
      }),
    })
    await call.text()
    const [start] = h.starts.filter((each) => each.flow === "ops/SpendAlert")
    const window = start!.payload as SpendAlert.Window
    const services = await appServices()
    await withSchema(({ name, sql, url }) =>
      Effect.gen(function* () {
        const object = memory()
        const host = ExecutionHost.make(object.storage, {
          hostId: `object-${start!.executionId}`,
          database: ExecutionHost.database(url, name),
          flows: ExecutionHost.remote(services),
          router: recording().router,
        })
        yield* host.start(
          yield* ExecutionHost.intent(SpendAlert.SpendAlert, { executionId: start!.executionId, payload: window }),
        )
        // Until the window ends it waits on its timer; the alarm after records the alert.
        let drove = yield* host.alarm()
        while (drove._tag !== "Settled") {
          yield* Effect.sleep(Math.max(0, (drove._tag === "Parked" ? drove.wakeAtMs ?? Date.now() : Date.now()) - Date.now()))
          drove = yield* host.alarm()
        }
        expect(yield* status(sql, name, start!.executionId)).toBe("completed")
      })
    )
    const [alert] = await app.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly id: string; readonly calls: number }>`SELECT id, calls FROM spend_alerts`))
    expect(alert).toEqual({ id: start!.executionId, calls: 1 })
  }, 60_000)

  test("after each alarm, whatever it did, the host runs afterAlarm", () =>
    withSchema(({ name, url }) =>
      Effect.gen(function* () {
        const object = memory()
        let after = 0
        let admitted = 0
        const executionId = crypto.randomUUID()
        const host = ExecutionHost.make(object.storage, {
          hostId: `object-${executionId}`,
          database: ExecutionHost.database(url, name),
          flows: { flows: [Pause.Pause], registration: Pause.registration((label) => Effect.succeed(label)) },
          router: recording().router,
          driveBudgetMs: 0,
          canStart: () => Effect.sync(() => { admitted++; return true }),
          afterAlarm: Effect.sync(() => void after++),
        })
        expect((yield* host.alarm())._tag).toBe("Idle")
        expect(after).toBe(1)
        const payload = { label: "a", pauseMs: 0 }
        yield* host.start(yield* ExecutionHost.intent(Pause.Pause, { executionId, payload }))
        for (let i = 0; i < 2; i++) {
          const before = Date.now()
          expect((yield* host.alarm())._tag).toBe("Yielded")
          expect(object.alarm()).toBeGreaterThanOrEqual(before)
          expect(object.alarm()).toBeLessThanOrEqual(Date.now())
          expect(after).toBe(i + 2)
        }
        expect((yield* host.alarm())._tag).toBe("Settled")
        expect(after).toBe(4)
        expect(admitted).toBe(1)
      })
    ))

  test("settled takes the run's settlement until it succeeds, and the run is forgotten only a day after", () =>
    withSchema(({ name, url }) =>
      Effect.gen(function* () {
        const object = memory()
        const settled: Array<string> = []
        let down = true
        const executionId = crypto.randomUUID()
        const host = ExecutionHost.make(object.storage, {
          hostId: `object-${executionId}`,
          database: ExecutionHost.database(url, name),
          flows: { flows: [Pause.Pause], registration: Pause.registration((label) => Effect.succeed(label)) },
          router: recording().router,
          // The app's database is down until `down` is cleared: the run's row can't be written.
          settled: (id) => Effect.suspend(() => {
            settled.push(id)
            return down ? Effect.fail(new Error("app database unavailable")) : Effect.void
          }),
        })
        expect((yield* host.alarm())._tag).toBe("Idle")
        yield* host.start(yield* ExecutionHost.intent(Pause.Pause, { executionId, payload: { label: "a", pauseMs: 60_000 } }))
        expect((yield* host.alarm())._tag).toBe("Parked")
        expect(settled).toEqual([])
        // Stopped: the next alarm settles it cancelled and hands it over, which fails, so the object retries with
        // backoff instead of arming the day's window.
        yield* host.cancel()
        const refused = yield* host.alarm()
        expect(refused).toMatchObject({ _tag: "Retrying", attempt: 1, failure: "Error" })
        expect(settled).toEqual([executionId])
        // A day later the app's row was still never written: the object still holds the run, and hands it over again.
        const late = yield* Effect.gen(function* () {
          yield* TestClock.setTime(Date.now() + ExecutionHost.settledRetentionMs + 1)
          down = false
          return yield* host.alarm()
        }).pipe(Effect.provide(TestClock.layer()))
        expect(late).toEqual({ _tag: "Settled", forgetAtMs: expect.any(Number) })
        expect(settled).toEqual([executionId, executionId])
        // Taken: a duplicate alarm hands nothing over, and the one that forgets the run a day after hands nothing.
        expect((yield* host.alarm())._tag).toBe("Settled")
        const forgotten = yield* Effect.gen(function* () {
          yield* TestClock.setTime(late._tag === "Settled" ? late.forgetAtMs : 0)
          return yield* host.alarm()
        }).pipe(Effect.provide(TestClock.layer()))
        expect(forgotten._tag).toBe("Forgotten")
        expect(settled).toEqual([executionId, executionId])
      })
    ))

  test("a settled object whose stored intent doesn't decode hands settled nothing", () =>
    withSchema(({ name, url }) =>
      Effect.gen(function* () {
        const object = memory()
        const settled: Array<string> = []
        const host = ExecutionHost.make(object.storage, {
          hostId: "object-undecodable",
          database: ExecutionHost.database(url, name),
          flows: { flows: [Pause.Pause], registration: Pause.registration((label) => Effect.succeed(label)) },
          router: recording().router,
          settled: (id) => Effect.sync(() => void settled.push(id)),
        })
        // The keys `ExecutionObject` stores its intent and its settlement under.
        object.values.set("smithers/intent", "not an intent")
        object.values.set("smithers/settled", Date.now())
        expect((yield* host.alarm())._tag).toBe("Settled")
        expect(settled).toEqual([])
      })
    ))

  test("the deployed flows run ops/DatabaseLoad/v2: an alarm starts its window's sample, which samples once", async () => {
    const services = await appServices()
    const samples: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
    const logger = Logger.make((options) => void samples.push(StructuredLogger.formatStructured.log(options)))
    await withSchema(({ name, sql, url }) =>
      Effect.gen(function* () {
        // Every execution's alarm starts the window's sample on the sample's own object, as worker/Executions.ts does.
        const loadObject = memory()
        const started: Array<string> = []
        const starter = Flows.FlowStarter.of({
          start: (flow, { executionId, payload }) =>
            ExecutionHost.intent(flow, { executionId, payload: payload as never }).pipe(
              Effect.flatMap((intent) => ExecutionHost.recordStart(loadObject.storage, intent)),
              Effect.tap(() => Effect.sync(() => void started.push(executionId))),
              Effect.orDie,
            ),
        })
        const hostFor = (
          object: ReturnType<typeof memory>,
          executionId: string,
          sampleLoad: Effect.Effect<void, never, Flows.FlowStarter>,
        ) =>
          ExecutionHost.make(object.storage, {
            hostId: `object-${executionId}`,
            database: ExecutionHost.database(url, name),
            flows: ExecutionHost.remote(services),
            router: recording().router,
            afterAlarm: sampleLoad.pipe(Effect.provideService(Flows.FlowStarter, starter)),
          })

        // Another execution's alarm, in one isolate.
        const pauseObject = memory()
        const pauseId = crypto.randomUUID()
        const pause = hostFor(pauseObject, pauseId, yield* DatabaseLoad.sampler)
        const payload = { label: "p", pauseMs: 0 }
        yield* pause.start(yield* ExecutionHost.intent(Pause.Pause, { executionId: pauseId, payload }))
        expect((yield* pause.alarm())._tag).toBe("Settled")
        expect(started).toHaveLength(1)
        const loadId = started[0]!
        expect(loadId).toMatch(/^database-load-v2-300000-\d+$/)
        expect(loadObject.alarm()).not.toBeNull()

        // The sample's own object, in another isolate: its alarm samples and settles, then starts its own window again.
        const load = hostFor(loadObject, loadId, yield* DatabaseLoad.sampler)
        const settled = yield* load.alarm()
        expect(settled._tag).toBe("Settled")
        expect(yield* status(sql, name, loadId)).toBe("completed")
        expect(started).toEqual([loadId, loadId])
        // That start was the same intent: the next alarm answers with the settlement and samples nothing more.
        expect((yield* load.alarm())._tag).toBe("Settled")
        expect(samples.filter((line) => line.message === "database.connections")).toHaveLength(1)
        // This isolate started its window already: its later alarms start nothing.
        expect(started).toEqual([loadId, loadId])
      }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])))
    )
  }, 60_000)

  test("a chat/Expire round that finds the queue moved during its wait hands off to the next round's own object", async () => {
    const h = await harness(app, answers("never"), {
      actor: { subject: { kind: "person", id: "person-member" }, role: "member" },
    })
    const [ahead, last] = [crypto.randomUUID(), crypto.randomUUID()]
    expect((await h.ask({ id: crypto.randomUUID(), answerId: ahead, text: "First" })).status).toBe(202)
    expect((await h.ask({ id: crypto.randomUUID(), answerId: last, text: "Second" })).status).toBe(202)
    const executionId = Expire.executionId(last)
    const services = await appServices()
    const router = recording()
    const timing: Array<{ readonly stage: string; readonly serverNowMs: number; readonly renewedAtMs: number; readonly deadlineMs: number }> = []
    let renewedAtMs = 0
    const sample = (stage: string) => Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly serverNowMs: number }>`SELECT extract(epoch FROM clock_timestamp())::float8 * 1000 AS "serverNowMs"`).pipe(
        Effect.provide(services.database),
        Effect.orDie,
        Effect.tap(([clock]) => Effect.sync(() => {
          timing.push({ stage, serverNowMs: clock!.serverNowMs, renewedAtMs, deadlineMs: renewedAtMs + Duration.toMillis(services.expiry) })
        })),
      )
    await withSchema(({ name, url }) =>
      Effect.gen(function* () {
        const object = memory()
        const host = ExecutionHost.make(object.storage, {
          hostId: `object-${executionId}`,
          database: ExecutionHost.database(url, name),
          flows: ExecutionHost.remote(services),
          router: router.router,
        })
        yield* host.start(yield* ExecutionHost.intent(Expire.Expire, { executionId, payload: { answerId: last } }))
        const parked = yield* host.alarm()
        expect(parked._tag).toBe("Parked")
        const wakeAt = parked._tag === "Parked" ? parked.wakeAtMs : null
        yield* Effect.flatMap(SqlClient.SqlClient, (appSql) => appSql`
          UPDATE messages SET updated_at = updated_at - make_interval(secs => ${Duration.toSeconds(services.expiry)})
          WHERE id IN (${ahead}, ${last})`).pipe(Effect.provide(services.database))
        // Renew immediately before delivering the original due alarm. Renewing
        // just after Parked leaves only startup time between the two deadlines;
        // a late alarm can then correctly abandon the renewed queue instead.
        const [moved] = yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql<{ readonly renewedAtMs: number }>`
            UPDATE messages SET status = 'done', text = 'Answered.', updated_at = now() WHERE id = ${ahead}
            RETURNING extract(epoch FROM updated_at)::float8 * 1000 AS "renewedAtMs"`).pipe(
          Effect.provide(services.database),
          Effect.orDie,
        )
        renewedAtMs = moved!.renewedAtMs
        yield* sample("before_alarm")
        yield* Effect.gen(function* () {
          yield* TestClock.setTime(wakeAt! + 1)
          return yield* host.alarm()
        }).pipe(Effect.provide(TestClock.layer()))
        yield* sample("after_alarm")
      })
    )
    // This round ended without settling the answer, and its object handed the next round to that round's own object.
    expect(await row(app, last), JSON.stringify({ answerId: last, timing })).toMatchObject({ status: "streaming" })
    expect(router.routed).toEqual([expect.stringMatching(/^start /)])
    expect(router.routed[0]).not.toBe(`start ${executionId}`)
  }, 60_000)

  test.each(["permission", "refresh"] as const)("concurrent renewal drives share a healthy %s request", async (heldStep) => {
    const signIn = await signInHarness(app)
    const { cookies } = await signIn.signInAs()
    const { sessionId, database } = await app.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const [row] = yield* sql<{ readonly id: string }>`SELECT id FROM sessions ORDER BY role_generation DESC LIMIT 1`
      if (heldStep === "refresh") yield* sql`UPDATE sessions SET github_access_expires_at = now() WHERE id = ${row!.id}`
      return { sessionId: row!.id, database: (yield* TestDatabase.Scratch).database }
    }))
    try {
      const keys = await Effect.runPromise(SessionKeys.make(Redacted.make(SECRET)))
      const entered = Deferred.makeUnsafe<void>()
      const release = Deferred.makeUnsafe<void>()
      let calls = 0
      const hold = Effect.gen(function* () {
        calls++
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
      })
      const github = signIn.github.service
      const flows = ExecutionHost.remoteWithSignIn({ database, expiry: Expire.DEFAULT_EXPIRY }, {
        keys, repository: "smithersai/smithers", github: {
          ...github,
          permission: (...args) => heldStep === "permission" ? hold.pipe(Effect.andThen(github.permission(...args))) : github.permission(...args),
          refresh: (...args) => heldStep === "refresh" ? hold.pipe(Effect.andThen(github.refresh(...args))) : github.refresh(...args),
        },
      })
      signIn.github.permission = "admin"
      await withSchema(({ name, sql, url }) => Effect.gen(function* () {
        const object = memory()
        const executionId = `auth-race-${sessionId}`
        let storageReads = 0
        const storage: ExecutionHost.Storage = {
          ...object.storage,
          get: <A>(key: string) => Effect.suspend(() => {
            storageReads++
            return object.storage.get<A>(key)
          }),
        }
        const host = ExecutionHost.make(storage, {
          hostId: `object-${executionId}`, database: ExecutionHost.database(url, name), flows, router: recording().router,
        })
        yield* host.start(yield* ExecutionHost.intent(RecheckRole.RecheckRole, { executionId, payload: { sessionId } }))
        const alarm = yield* host.alarm().pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        // Run the competing drive through its first suspension before sampling. It must wait at the host's
        // permit, before even reading object storage, while the first provider request remains open.
        const readsWhileHeld = storageReads
        const advanceEntered = Deferred.makeUnsafe<void>()
        const advance = yield* Deferred.succeed(advanceEntered, undefined).pipe(
          Effect.andThen(host.alarm()),
          Effect.forkChild({ startImmediately: true }),
        )
        yield* Effect.gen(function* () {
          yield* Deferred.await(advanceEntered)
          expect(storageReads).toBe(readsWhileHeld)
          expect(calls).toBe(1)
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
        const outcomes = yield* Effect.all([Fiber.join(alarm), Fiber.join(advance)])
        expect(outcomes.map((outcome) => outcome._tag)).toEqual(["Settled", "Settled"])
        expect(yield* status(sql, name, executionId)).toBe("completed")
      }))
      expect(calls).toBe(1)
      expect(await signIn.session(cookies)).toMatchObject({ signedIn: true, role: "admin" })
      expect(signIn.github.calls.filter((step) => step === "refresh")).toHaveLength(heldStep === "refresh" ? 1 : 0)
    } finally {
      await app.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DELETE FROM sessions WHERE id = ${sessionId}`))
    }
  })

  test("with sign-in configured, the deployed flows run auth/RecheckRole and auth/RevokeGitHubToken over the app's tables", async () => {
    const signIn = await signInHarness(app)
    const { cookies } = await signIn.signInAs()
    expect(await signIn.session(cookies)).toMatchObject({ role: "member" })
    signIn.github.permission = "admin"
    const { sessionId, database } = await app.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const [row] = yield* sql<{ readonly id: string }>`SELECT id FROM sessions`
      return { sessionId: row!.id, database: (yield* TestDatabase.Scratch).database }
    }))
    const keys = await Effect.runPromise(SessionKeys.make(Redacted.make(SECRET)))
    const flows = ExecutionHost.remoteWithSignIn({ database, expiry: Expire.DEFAULT_EXPIRY }, {
      keys,
      github: signIn.github.service,
      repository: "smithersai/smithers",
    })
    expect(flows.flows).toEqual([
      Pause.Pause,
      Expire.Expire,
      SpendAlert.SpendAlert,
      DatabaseLoad.DatabaseLoad,
      DatabaseLoad.DatabaseLoadV2,
      SandboxSpend.SandboxSpend,
      BugReport.BugReport,
      RecheckRole.RecheckRole,
      RevokeGitHubToken.RevokeGitHubToken,
      ReplacedTokens.RevokeReplacedGitHubToken,
      ReplacedTokens.SweepReplacedGitHubTokens,
      ReplacedTokens.MaintainSessions,
    ])
    await withSchema(({ name, sql, url }) =>
      Effect.gen(function* () {
        const object = memory()
        const executionId = `auth-recheck-${sessionId}-1`
        const host = ExecutionHost.make(object.storage, {
          hostId: `object-${executionId}`,
          database: ExecutionHost.database(url, name),
          flows,
          router: recording().router,
        })
        yield* host.start(yield* ExecutionHost.intent(RecheckRole.RecheckRole, { executionId, payload: { sessionId } }))
        expect(yield* host.alarm()).toMatchObject({ _tag: "Settled" })
        expect(yield* status(sql, name, executionId)).toBe("completed")
      })
    )
    const identity = await signIn.session(cookies) as SessionState
    expect(identity).toMatchObject({ role: "admin" })
    if (!identity.signedIn) throw new Error("expected a signed-in person")
    // Signing out starts the revocation, which the same deployed flows run.
    await signIn.fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { origin: "http://smithers.test", cookie: cookie(cookies), [DEVICE_PERSON_HEADER]: identity.personId! },
    })
    expect(signIn.revocations).toEqual([sessionId])
    const [issued] = signIn.github.issued
    await withSchema(({ name, sql, url }) =>
      Effect.gen(function* () {
        const object = memory()
        const executionId = `auth-revoke-${sessionId}`
        const host = ExecutionHost.make(object.storage, {
          hostId: `object-${executionId}`,
          database: ExecutionHost.database(url, name),
          flows,
          router: recording().router,
        })
        yield* host.start(
          yield* ExecutionHost.intent(RevokeGitHubToken.RevokeGitHubToken, { executionId, payload: { sessionId } }),
        )
        expect(yield* host.alarm()).toMatchObject({ _tag: "Settled" })
        expect(yield* status(sql, name, executionId)).toBe("completed")
      })
    )
    expect(signIn.github.accepts(issued!.accessToken)).toBe(false)
    const [forgotten] = await app.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly forgotten: boolean }>`SELECT github_access IS NULL AS forgotten FROM sessions`))
    expect(forgotten!.forgotten).toBe(true)
  })

  test("with Code Storage configured, the deployed flows run repo/Clone over the app's tables", async () => {
    await resetRepos(app)
    const provider = scripted()
    provider.publish("octocat", "Spoon-Knife")
    const database = (await app.runPromise(Effect.service(TestDatabase.Scratch))).database
    const budgets = { clonesPerPerson: 3, maxRepositories: 100, maxStoredBytes: 3e9, maxReadBytes: 40e9, maxRepositoryBytes: 1e9, budgetUsd: 20 }
    const requested = await app.runPromise(
      Repos.request({ id: "github/octocat/spoon-knife", owner: "octocat", name: "Spoon-Knife" }, budgets, "octocat"),
    )
    if (requested.kind !== "started") throw new Error(`requested ${requested.kind}`)
    const flows = ExecutionHost.withRepoClone(ExecutionHost.remote({ database, expiry: Expire.DEFAULT_EXPIRY }), {
      database,
      codeStorage: provider.client,
      upstream: provider.upstream,
      budgets,
      deadline: Duration.minutes(10),
      index: () => Effect.succeed(3),
      installed: () => Effect.succeed(false),
    })
    expect(flows.flows).toEqual([Pause.Pause, Expire.Expire, SpendAlert.SpendAlert, DatabaseLoad.DatabaseLoad, DatabaseLoad.DatabaseLoadV2, SandboxSpend.SandboxSpend, BugReport.BugReport, RepoClone.Clone, RepoRefresh.Refresh])
    await withSchema(({ name, sql, url }) =>
      Effect.gen(function* () {
        const object = memory()
        const executionId = cloneExecutionId("github/octocat/spoon-knife", requested.cloneId)
        const host = ExecutionHost.make(object.storage, {
          hostId: `object-${executionId}`,
          database: ExecutionHost.database(url, name),
          flows,
          router: recording().router,
        })
        const { owner, name: repo, cloneId, requestedAt } = requested
        yield* host.start(
          yield* ExecutionHost.intent(RepoClone.Clone, {
            executionId,
            payload: { id: "github/octocat/spoon-knife", owner, name: repo, cloneId, requestedAt },
          }),
        )
        // The sync answers sync_in_progress once, so the first drive may park on the retry; drive until it settles.
        let driven = yield* host.alarm()
        for (let drives = 1; driven._tag !== "Settled" && drives < 20; drives++) driven = yield* host.alarm()
        expect(driven).toMatchObject({ _tag: "Settled" })
        expect(yield* status(sql, name, executionId)).toBe("completed")
      })
    )
    expect(await repositoryRow(app, "github/octocat/spoon-knife")).toMatchObject({ status: "ready" })
  })

  test("the deployed flows add the sandbox tools', the secrets', the personal models' and the domains' flows, as worker/Executions.ts composes them", async () => {
    const database = (await app.runPromise(Effect.service(TestDatabase.Scratch))).database
    // Never built: only the registration's composition is read.
    const machines = Layer.effect(Machines, Effect.die(new Error("no machine in this test")))
    const flows = ExecutionHost.withDomains(
      ExecutionHost.withPersonalModels(
        ExecutionHost.withSecrets(
          ExecutionHost.withSandboxTools(ExecutionHost.remote({ database, expiry: Expire.DEFAULT_EXPIRY }), database, machines),
          database,
        ),
        database,
        Layer.merge(SecretKeys.off, Layer.succeed(CodexAuth, { origin: "", clientId: "" })),
      ),
      database,
      DomainProvider.off,
    )
    expect(flows.flows).toEqual([
      Pause.Pause,
      Expire.Expire,
      SpendAlert.SpendAlert,
      DatabaseLoad.DatabaseLoad,
      DatabaseLoad.DatabaseLoadV2,
      SandboxSpend.SandboxSpend,
      BugReport.BugReport,
      SandboxCall.SandboxCall,
      SandboxKeep.Keep,
      ...SandboxCommand.Command.flows,
      SecretFlows.Put,
      SecretFlows.Delete,
      ModelFlows.Put,
      ModelFlows.Delete,
      ModelFlows.CodexLink,
      DomainFlows.Verify,
      DomainFlows.Remove,
    ])
    expect(Layer.isLayer(flows.registration)).toBe(true)
  })

  test("with the branches' machines, the deployed flows run terminal/Open over the app's tables", async () => {
    await resetBranches(app)
    const database = (await app.runPromise(Effect.service(TestDatabase.Scratch))).database
    const { branchId } = await tracked(app, "github/octocat/spoon-knife", "test-branch")
    const terminalId = crypto.randomUUID()
    await terminal(app, { id: terminalId, branchId, ownerId: "person-owner", status: "opening" })
    const machines: Array<string> = []
    const sandboxes = Layer.succeed(Sandboxes, Sandboxes.of({
      wake: (branch) => Effect.sync(() => machines.push(`wake ${branch.branchId}`)).pipe(Effect.as({ generation: 7 })),
      session: (_, id, ownerId) => Effect.sync(() => void machines.push(`session ${id} ${ownerId}`)),
    }))
    const flows = ExecutionHost.withTerminals(ExecutionHost.remote({ database, expiry: Expire.DEFAULT_EXPIRY }), database, sandboxes)
    expect(flows.flows).toEqual([Pause.Pause, Expire.Expire, SpendAlert.SpendAlert, DatabaseLoad.DatabaseLoad, DatabaseLoad.DatabaseLoadV2, SandboxSpend.SandboxSpend, BugReport.BugReport, TerminalOpen.TerminalOpen])
    await withSchema(({ name, sql, url }) =>
      Effect.gen(function* () {
        const object = memory()
        const executionId = openExecutionId(terminalId)
        const host = ExecutionHost.make(object.storage, {
          hostId: `object-${executionId}`,
          database: ExecutionHost.database(url, name),
          flows,
          router: recording().router,
        })
        yield* host.start(
          yield* ExecutionHost.intent(TerminalOpen.TerminalOpen, {
            executionId,
            payload: {
              terminalId,
              ownerId: "person-owner",
              branch: { branchId, owner: "octocat", name: "Spoon-Knife", branch: "test-branch" },
            },
          }),
        )
        expect(yield* host.alarm()).toMatchObject({ _tag: "Settled" })
        expect(yield* status(sql, name, executionId)).toBe("completed")
      })
    )
    expect(machines).toEqual([`wake ${branchId}`, `session ${terminalId} person-owner`])
    expect((await terminalRows(app, branchId))[0]).toMatchObject({ status: "open", generation: "7" })
  })
})


test("retry requires the engine cancellation receipt, not the object's stop request", () =>
  withSchema(({ name, url }) => Effect.gen(function* () {
    const attemptId = crypto.randomUUID()
    const executionId = `todo:${attemptId}`
    const object = memory()
    const database = ExecutionHost.database(url, name)
    const host = ExecutionHost.make(object.storage, {
      hostId: executionId, database,
      flows: { flows: [Pause.Pause], registration: Pause.registration(Pause.logged) },
      router: recording().router,
    })
    const stopped = TodoRuns.isStopped(database)
    yield* host.start(yield* ExecutionHost.intent(Pause.Pause, {
      executionId, payload: { label: "cancel-retry", pauseMs: 60_000 },
    }))
    yield* host.alarm()
    expect(yield* stopped(crypto.randomUUID())).toBe(false)
    expect(yield* stopped(attemptId)).toBe(false)
    yield* host.cancel()
    // Persisting a cancellation request does not settle a parked execution.
    expect(yield* stopped(attemptId)).toBe(false)
    yield* host.alarm()
    expect(yield* stopped(attemptId)).toBe(true)
  })),
)


test("a webhook signal cannot revive a durably cancelled execution", () =>
  withSchema(({ name, sql, url }) => Effect.gen(function* () {
    const Event = Flow.make("probe/CancelledSignal", {
      payload: {}, success: Schema.Json, error: WaitFor.WaitForRequestInvalid,
      body: Node.capture({ wait: WaitFor.action.name }, () => WaitFor.action.call({ name: "merge" })),
    })
    const object = memory()
    const executionId = crypto.randomUUID()
    const make = () => ExecutionHost.make(object.storage, {
      hostId: executionId, database: ExecutionHost.database(url, name),
      flows: { flows: [Event], registration: Layer.merge(Interpreter.layer(Event), WaitFor.layer).pipe(
        Layer.provideMerge(Action.layerImplementations),
      ) },
      router: recording().router,
    })
    const host = make()
    yield* host.start(yield* ExecutionHost.intent(Event, { executionId, payload: {} }))
    expect((yield* host.alarm())._tag).toBe("Parked")
    yield* host.cancel()
    const restarted = make()
    yield* restarted.signal(WaitFor.deferred("merge").name)
    yield* restarted.alarm()
    expect(yield* status(sql, name, executionId)).toBe("cancelled")
    yield* restarted.signal(WaitFor.deferred("merge").name)
    yield* restarted.alarm()
    expect(yield* status(sql, name, executionId)).toBe("cancelled")
  })),
)

test.each([0, 600_000])("webhook delivery leaves cancelled work for its budgeted alarm (%s ms)", (driveBudgetMs) =>
  withSchema(({ name, sql, url }) => Effect.gen(function* () {
    let actions = 0
    const After = Action.make("probe/AfterCancelledSignal", { payload: {}, success: Schema.Json })
    const Event = Flow.make("probe/SignalAdmission", {
      payload: {}, success: Schema.Json, error: WaitFor.WaitForRequestInvalid,
      body: Node.capture({ wait: WaitFor.action.name, after: After.name }, () =>
        WaitFor.action.call({ name: "merge" }).pipe(Node.andThen(After.call({})))),
    })
    const object = memory()
    const executionId = crypto.randomUUID()
    const make = (budget?: number) => ExecutionHost.make(object.storage, {
      hostId: executionId, database: ExecutionHost.database(url, name), driveBudgetMs: budget,
      flows: { flows: [Event], registration: Layer.mergeAll(
        Interpreter.layer(Event), WaitFor.layer,
        After.toLayer(() => Effect.sync(() => { actions++; return null })),
      ).pipe(Layer.provideMerge(Action.layerImplementations)) },
      router: recording().router,
    })
    const host = make()
    yield* host.start(yield* ExecutionHost.intent(Event, { executionId, payload: {} }))
    expect((yield* host.alarm())._tag).toBe("Parked")
    // Both fresh delivery and registration recovery of a repeated delivery
    // persist readiness without starting an unbudgeted drain.
    yield* host.signal(WaitFor.deferred("merge").name)
    yield* host.signal(WaitFor.deferred("merge").name)
    expect(yield* status(sql, name, executionId)).toBe("suspended")
    expect(actions).toBe(0)
    yield* host.cancel()
    const restarted = make(driveBudgetMs)
    yield* restarted.signal(WaitFor.deferred("merge").name)
    expect((yield* restarted.alarm())._tag).toBe("Settled")
    expect(yield* status(sql, name, executionId)).toBe("cancelled")
    yield* restarted.signal(WaitFor.deferred("merge").name)
    expect((yield* restarted.alarm())._tag).toBe("Settled")
    expect(yield* status(sql, name, executionId)).toBe("cancelled")
    expect(actions).toBe(0)
  })),
)

test("a signal before any execution intent does not create state or schedule work", () =>
  withSchema(({ name, sql, url }) => Effect.gen(function* () {
    const object = memory()
    const routes = recording()
    const host = ExecutionHost.make(object.storage, {
      hostId: "not-started", database: ExecutionHost.database(url, name),
      flows: { flows: [Pause.Pause], registration: Pause.registration(Pause.logged) },
      router: routes.router,
    })
    yield* host.signal(WaitFor.deferred("merge").name)
    expect(object.values.size).toBe(0)
    expect(object.alarm()).toBeNull()
    expect(routes.routed).toEqual([])
    expect(yield* sql`SELECT schema_name FROM information_schema.schemata WHERE schema_name = ${name}`).toEqual([])
  })))
