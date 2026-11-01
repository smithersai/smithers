// The fleet (decision 0143, docs/features/fleet.md): `project`'s rules alone, then the projection and its alerts
// against the compose Postgres on this file's own schema: the job store an `ExternalAgent` step drives, the routes a
// runner pulls its jobs through, `ops/FleetAlert` and `ops/RunnerHealth` on the Node host's durable engine
// (worker/test/flowHost.ts), alerts to the local providers (worker/test/alertProviders.ts). Time is the database's:
// a test moves a row's timestamps back rather than wait.
import { AgentRunner } from "@smthrs/agent"
import { digestSync } from "@smthrs/crypto"
import { Channels } from "@smthrs/notifications"
import { Effect, Exit, Redacted } from "effect"
import { HttpEffect } from "effect/http"
import { SqlClient } from "effect/sql"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as FleetAlert from "../flows/FleetAlert.ts"
import * as TodoSession from "../flows/TodoSession.ts"
import { type AlertProviders, startAlertProviders } from "../test/alertProviders.ts"
import { runFlow } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import * as RunContentTest from "../test/runContent.ts"
import * as RunnersApi from "./Api.ts"
import * as Fleet from "./Fleet.ts"
import * as Jobs from "./Jobs.ts"
import * as Store from "./Store.ts"

const runtime = testFile("fleet")
const REPO = "github/acme/widgets"
const HOME = "github/smithersai/smithers"
const BASE = "0123456789abcdef0123456789abcdef01234567"
const PROMPT = "PROMPT-SENTINEL-71c2 add alpha"

beforeEach(() =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`TRUNCATE agent_runs, fleet_alerts, agent_jobs, runners, runner_changes, agents, agent_changes, notifications,
      alert_channels, alert_deliveries, github_repo_roles, sessions, people, todo_attempts, todos, stacks
      RESTART IDENTITY CASCADE`)))

const database = () => runtime.runPromise(Effect.map(Effect.service(TestDatabase.Scratch), (scratch) => scratch.database))
const query = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => runtime.runPromise(effect)
const sql = <A extends object = Record<string, unknown>>(statement: string) =>
  query(Effect.flatMap(SqlClient.SqlClient, (client) => Effect.orDie(client.unsafe<A>(statement))))

const agent: AgentRunner.Agent = { name: "coder", labels: ["linux"], profile: "coder-profile", maxHours: 4, restarts: 1 }
const taskOf = (attemptId?: string): AgentRunner.Task => ({
  agent,
  repository: REPO,
  base: BASE,
  system: [],
  prompt: PROMPT,
  limits: { files: 2, bytes: 8 },
  ...(attemptId === undefined ? {} : { context: { attemptId } }),
})

let invocations = 0
const by = (): Store.By => ({ actorId: "person-admin", invocationKey: `fleet-${++invocations}` })

/** Registers runner `name` and answers its token. */
const register = async (name: string) => {
  const token = `token-${name}-${crypto.randomUUID()}`
  await query(Store.addRunner({ repoId: REPO, name, tokenSha256: digestSync(token), labels: ["linux"], capacity: 2 }, by()))
  return token
}

/** The runner routes over this file's schema, a TODO's job writing its transcript to its run as ChatApi's does. */
const routes = async () => {
  const handler = HttpEffect.toWebHandler(
    RunnersApi.make(await database(), { pollMillis: 50, runOf: TodoSession.runOf }).fetch
      .pipe(Effect.provide(RunContentTest.transcripts().layer)),
  )
  const call = async <A>(route: keyof typeof AgentRunner.ROUTES, token: string, body: unknown) => {
    const response = await handler(new Request(`http://localhost${AgentRunner.ROUTES[route]}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }))
    return { status: response.status, body: (await response.json()) as A }
  }
  const claim = async (token: string, machine?: AgentRunner.Machine) =>
    (await call<{ readonly job: AgentRunner.Job | null }>("claim", token, {
      profiles: ["coder-profile"],
      free: 1,
      running: [],
      waitSeconds: 0,
      ...(machine === undefined ? {} : { machine }),
    })).body.job!
  return { call, claim }
}

/** The job store with the fleet's alerts, keeping each alert it raises. */
const store = async (settings: Partial<Fleet.Settings> = {}) => {
  const raised: Array<Fleet.Alert> = []
  const jobs = Jobs.make(await database(), {
    settings: { ...Fleet.DEFAULTS, ...settings },
    raise: (alert) => Effect.sync(() => void raised.push(alert)),
  })
  return { jobs, raised }
}

const run = (key: string) => sql<Record<string, unknown>>(`SELECT * FROM agent_runs WHERE key = '${key}'`).then((rows) => rows[0]!)

/** A TODO with a running attempt, committed by `committer`: its attempt's id. */
const todo = async (committer: string, number = 7) => {
  const todoId = crypto.randomUUID()
  const attemptId = crypto.randomUUID()
  await sql(`INSERT INTO stacks (repo_id) VALUES ('${REPO}') ON CONFLICT DO NOTHING`)
  await sql(`
    INSERT INTO todos (id, repo_id, number, title, state, position, created_by, created_login)
    VALUES ('${todoId}', '${REPO}', ${number}, 'drive foldkit', 'working', ${number}, '${committer}', 'maya')`)
  await sql(`
    INSERT INTO todo_attempts (id, todo_id, repo_id, ordinal, revision, status)
    VALUES ('${attemptId}', '${todoId}', '${REPO}', 1, 1, 'running')`)
  return attemptId
}

const at = (ms: number) => new Date(ms)

describe("project", () => {
  const now = Date.parse("2026-10-31T12:00:00Z")
  const job = (overrides: Partial<Fleet.Job> = {}): Fleet.Job => ({
    key: "k#g1",
    repoId: REPO,
    status: "claimed",
    outcome: null,
    cancelRequested: false,
    claimedAt: at(now - 20 * 60_000),
    settledAt: null,
    accountLabel: null,
    cpuSeconds: null,
    usage: null,
    firstEventAt: null,
    lastEventAt: null,
    transcriptBytes: null,
    runnerId: "r1",
    runner: "nyc-01",
    runnerSeenAt: at(now - 5000),
    now: at(now),
    ...overrides,
  })
  const run = (overrides: Partial<Fleet.Run> = {}): Fleet.Run => ({
    state: "working",
    reason: null,
    runner: null,
    accountLabel: null,
    queuedAt: at(now - 21 * 60_000),
    claimedAt: null,
    firstEventAt: null,
    lastEventAt: null,
    activityAt: null,
    endedAt: null,
    contextTokens: null,
    costUsd: null,
    transcriptBytes: null,
    cpuSeconds: null,
    cpuMark: null,
    alerted: [],
    ...overrides,
  })

  test("a run with no event for the stall threshold and no CPU evidence reads Stalled, once per stretch of quiet", () => {
    const quiet = Fleet.project(job({ lastEventAt: at(now - 11 * 60_000) }), run(), Fleet.DEFAULTS)
    expect(quiet.next.state).toBe("stalled")
    const id = Fleet.alertId.stalled("k#g1", now - 11 * 60_000)
    expect(quiet.due).toEqual([{ alertId: id, kind: "stalled", repoId: REPO, subject: "k#g1" }])
    expect(Fleet.project(job({ lastEventAt: at(now - 11 * 60_000) }), run({ alerted: [id] }), Fleet.DEFAULTS).due).toEqual([])
    // An event within the threshold is work.
    expect(Fleet.project(job({ lastEventAt: at(now - 9 * 60_000) }), run(), Fleet.DEFAULTS).next.state).toBe("working")
  })

  test("a quiet build is work: 5 CPU seconds past the mark move the activity to now and the mark up", () => {
    const busy = Fleet.project(job({ cpuSeconds: 400 }), run({ cpuMark: 300, activityAt: at(now - 15 * 60_000) }), Fleet.DEFAULTS)
    expect(busy.next).toMatchObject({ state: "working", cpuMark: 400, activityAt: at(now) })
    expect(busy.due).toEqual([])
    // Under 5 seconds more is no evidence: the mark stays, and 15 minutes of quiet is a stall.
    const idle = Fleet.project(job({ cpuSeconds: 304 }), run({ cpuMark: 300, activityAt: at(now - 15 * 60_000) }), Fleet.DEFAULTS)
    expect(idle.next).toMatchObject({ state: "stalled", cpuMark: 300 })
    // The first CPU report sets the mark; it proves work once the tree used 5 seconds since it started.
    expect(Fleet.project(job({ cpuSeconds: 2 }), run(), Fleet.DEFAULTS).next).toMatchObject({ cpuMark: 2, state: "stalled" })
    expect(Fleet.project(job({ cpuSeconds: 18 }), run(), Fleet.DEFAULTS).next).toMatchObject({ cpuMark: 18, state: "working" })
  })

  test("a stall recovers when work shows again; a stopping run never stalls", () => {
    const back = Fleet.project(job({ lastEventAt: at(now - 1000) }), run({ state: "stalled" }), Fleet.DEFAULTS)
    expect(back.next.state).toBe("working")
    expect(back.recovered).toEqual(["stalled"])
    expect(Fleet.project(job({ cancelRequested: true }), run(), Fleet.DEFAULTS).next.state).toBe("stopping")
  })

  test("a queued run waits, and alerts after the wait threshold; a claim recovers its incident", () => {
    const queued = job({ status: "queued", claimedAt: null, runnerId: null, runner: null, runnerSeenAt: null })
    expect(Fleet.project(queued, run({ state: "queued", queuedAt: at(now - 4 * 60_000) }), Fleet.DEFAULTS).due).toEqual([])
    const long = Fleet.project(queued, run({ state: "queued" }), Fleet.DEFAULTS)
    expect(long.next.state).toBe("queued")
    expect(long.due.map((alert) => alert.kind)).toEqual(["waiting"])
    const claimed = Fleet.project(job({ claimedAt: at(now) }), run({ state: "queued", alerted: [Fleet.alertId.waiting("k#g1")] }), Fleet.DEFAULTS)
    expect(claimed.recovered).toEqual(["waiting"])
  })

  test("a claimed job's runner unseen past the threshold alerts once per outage; a cost past the cap alerts", () => {
    // Alerting when the view reads Offline leaves a 30 s probe its handoff inside the 90 s an outage has to reach the bell.
    expect(Fleet.DEFAULTS.offlineSeconds).toBe(Fleet.UNREACHABLE_SECONDS)
    expect(Fleet.project(job({ lastEventAt: at(now), runnerSeenAt: at(now - 44_000) }), run(), Fleet.DEFAULTS).due).toEqual([])
    const seen = now - 46_000
    const off = Fleet.project(job({ lastEventAt: at(now), runnerSeenAt: at(seen) }), run(), Fleet.DEFAULTS)
    expect(off.due).toEqual([{ alertId: Fleet.alertId.offline("r1", seen), kind: "offline", repoId: REPO, subject: "r1" }])
    const capped = { ...Fleet.DEFAULTS, maxRunUsd: 5 }
    const dear = Fleet.project(job({ lastEventAt: at(now), usage: { costUsd: 6.5, contextTokens: 9 } }), run(), capped)
    expect(dear.next).toMatchObject({ costUsd: 6.5, contextTokens: 9 })
    expect(dear.due.map((alert) => alert.kind)).toEqual(["cost"])
    expect(Fleet.project(job({ lastEventAt: at(now), usage: { costUsd: 6.5 } }), run(), Fleet.DEFAULTS).due).toEqual([])
  })

  test("an ended job reads its outcome: done with its usage, failed with its code, stopped, retried", () => {
    const ended = (status: Fleet.Job["status"], outcome: unknown) =>
      Fleet.project(job({ status, outcome, settledAt: at(now) }), run(), Fleet.DEFAULTS).next
    expect(ended("done", { _tag: "Done", usage: { contextTokens: 5 } })).toMatchObject({ state: "done", contextTokens: 5, endedAt: at(now) })
    expect(ended("failed", { _tag: "Failed", reason: "machine_lost" })).toMatchObject({ state: "failed", reason: "machine_lost" })
    expect(ended("cancelled", { _tag: "Cancelled", processTreeGone: true }).state).toBe("stopped")
    expect(ended("retryable", { _tag: "Retryable" }).state).toBe("retried")
    expect(Fleet.changed(run(), run())).toBe(false)
    expect(Fleet.changed(run(), run({ activityAt: at(now) }))).toBe(true)
  })
})

describe("the projection on Postgres", () => {
  test("a job's run: queued with its TODO, Working on its claim with the machine's facts, the heartbeat's account, CPU and usage, then Done", async () => {
    const token = await register("nyc-01")
    const attemptId = await todo("person-maya")
    const { jobs } = await store()
    const { call, claim } = await routes()
    await Effect.runPromise(jobs.start(taskOf(attemptId), "todo-run#g1"))
    expect(await run("todo-run#g1")).toMatchObject({
      repo_id: REPO, agent: "coder", generation: 1, run_id: `todo:${attemptId}`, number: 7, title: "drive foldkit", state: "queued",
    })
    const job = await claim(token, { version: "1.0.0-rc.16", load1: 3.14159, diskFreeGb: 212.4 })
    expect(await run(job.key)).toMatchObject({ state: "working", runner: "nyc-01" })
    expect((await sql(`SELECT version, load1, disk_free_gb FROM runners`))[0]).toEqual({ version: "1.0.0-rc.16", load1: 3.1, disk_free_gb: 212 })
    await call("heartbeat", token, { key: job.key, claim: job.claim, account: "acct-3", cpuSeconds: 1.5, usage: { contextTokens: 812000 } })
    expect(await Effect.runPromise(jobs.status(job.key))).toEqual({ _tag: "Running" })
    expect(await run(job.key)).toMatchObject({ account_label: "acct-3", cpu_seconds: 1.5, cpu_mark: 1.5, context_tokens: 812000n })
    // A probe that finds nothing new writes nothing.
    const before = (await run(job.key)).updated_at
    await Effect.runPromise(jobs.status(job.key))
    expect((await run(job.key)).updated_at).toEqual(before)
    const usage = { contextTokens: 900000, costUsd: 1.25 }
    await call("settle", token, { key: job.key, claim: job.claim, outcome: { _tag: "Done", changes: { additions: [], deletions: [] }, summary: "", usage } })
    expect(await run(job.key)).toMatchObject({ state: "done", context_tokens: 900000n, cost_usd: "1.2500" })
    // The run holds no task, prompt or summary.
    expect(JSON.stringify(await sql(`SELECT * FROM agent_runs`), (_, value) => (typeof value === "bigint" ? String(value) : value))).not.toContain("PROMPT-SENTINEL")
  })

  test("a stall raises one alert and recovers on CPU work; a queued run waits too long; a stop reads Stopping", async () => {
    const token = await register("nyc-01")
    const { jobs, raised } = await store()
    const { call, claim } = await routes()
    await Effect.runPromise(jobs.start(taskOf(), "silent#g1"))
    await Effect.runPromise(jobs.start(taskOf(), "late#g1"))
    const job = await claim(token)
    expect(job.key).toBe("silent#g1")
    // Eleven minutes of quiet since the claim.
    await sql(`UPDATE agent_runs SET activity_at = now() - interval '11 minutes' WHERE key = 'silent#g1'`)
    await sql(`UPDATE agent_jobs SET claimed_at = now() - interval '11 minutes' WHERE key = 'silent#g1'`)
    await sql(`UPDATE agent_runs SET queued_at = now() - interval '6 minutes' WHERE key = 'late#g1'`)
    await Effect.runPromise(jobs.status("silent#g1"))
    await Effect.runPromise(jobs.status("silent#g1"))
    await Effect.runPromise(jobs.status("late#g1"))
    expect((await run("silent#g1")).state).toBe("stalled")
    expect(raised.map((alert) => [alert.kind, alert.subject])).toEqual([["stalled", "silent#g1"], ["waiting", "late#g1"]])
    expect((await run("silent#g1")).alerted).toEqual([raised[0]!.alertId])
    await sql(`INSERT INTO fleet_alerts (id, kind, repo_id, subject, title, href) VALUES ('${raised[0]!.alertId}', 'stalled', '${REPO}', 'silent#g1', 't', '/x')`)
    // The agent's tree uses CPU: under 5 seconds is no evidence, 5 seconds past the mark is work.
    await call("heartbeat", token, { key: job.key, claim: job.claim, cpuSeconds: 3 })
    await Effect.runPromise(jobs.status("silent#g1"))
    expect((await run("silent#g1")).state).toBe("stalled")
    await call("heartbeat", token, { key: job.key, claim: job.claim, cpuSeconds: 9 })
    await Effect.runPromise(jobs.status("silent#g1"))
    expect((await run("silent#g1")).state).toBe("working")
    expect((await sql<{ closed: boolean }>(`SELECT closed_at IS NOT NULL AS closed FROM fleet_alerts`))[0]!.closed).toBe(true)
    await Effect.runPromise(jobs.cancel("silent#g1"))
    expect((await run("silent#g1")).state).toBe("stopping")
    await Effect.runPromise(jobs.cancel("late#g1"))
    expect((await run("late#g1")).state).toBe("stopped")
  })

  test("a TODO's run that died reads Failed crashed at once; a generation already over keeps its end, and a late settle changes neither", async () => {
    const token = await register("nyc-01")
    const { jobs } = await store()
    const { call, claim } = await routes()
    const attemptId = crypto.randomUUID()
    await Effect.runPromise(jobs.start(taskOf(attemptId), "over#g1"))
    await Effect.runPromise(jobs.start(taskOf(attemptId), "dead#g1"))
    await Effect.runPromise(jobs.start(taskOf(attemptId), "waiting#g1"))
    const over = await claim(token)
    expect(over.key).toBe("over#g1")
    await call("settle", token, { key: over.key, claim: over.claim, outcome: { _tag: "Failed", reason: "agent" } })
    const dead = await claim(token)
    expect(dead.key).toBe("dead#g1")
    const db = await database()
    await Effect.runPromise(Fleet.crashed(attemptId).pipe(Effect.provide(db)))
    const read = async (key: string) => {
      const { state, reason } = await run(key)
      return { state, reason }
    }
    expect(await read("dead#g1")).toEqual({ state: "failed", reason: "crashed" })
    expect(await read("waiting#g1")).toEqual({ state: "failed", reason: "crashed" })
    expect(await read("over#g1")).toEqual({ state: "failed", reason: "agent" })
    // Stopping the agent after that, and its runner settling, change nothing a person reads.
    await Effect.runPromise(Jobs.stop("dead").pipe(Effect.provide(db)))
    expect(await read("dead#g1")).toEqual({ state: "failed", reason: "crashed" })
    await call("settle", token, { key: dead.key, claim: dead.claim, outcome: { _tag: "Cancelled", processTreeGone: true } })
    expect(await read("dead#g1")).toEqual({ state: "failed", reason: "crashed" })
  })

  test("a person's Stop on a TODO's run reads Stopping while a runner holds it, and Stopped when none does", async () => {
    const token = await register("nyc-01")
    const { jobs } = await store()
    const { claim } = await routes()
    await Effect.runPromise(jobs.start(taskOf(), "held#g1"))
    await Effect.runPromise(jobs.start(taskOf(), "waiting#g1"))
    expect((await claim(token)).key).toBe("held#g1")
    const db = await database()
    const stop = (origin: string) => Effect.runPromise(Jobs.stop(origin).pipe(Effect.provide(db)))
    expect(await stop("held")).toBe(1)
    expect((await run("held#g1")).state).toBe("stopping")
    expect(await stop("waiting")).toBe(1)
    expect((await run("waiting#g1")).state).toBe("stopped")
  })

  test("a runner seen after an outage closes its incident; a request within 10 s of the last doesn't rewrite its row", async () => {
    const token = await register("nyc-01")
    const { call } = await routes()
    const id = (await sql<{ id: string }>(`SELECT id::text AS id FROM runners`))[0]!.id
    await call("heartbeat", token, { key: "none#g1", claim: crypto.randomUUID() })
    const seen = (await sql<{ seen_at: Date }>(`SELECT seen_at FROM runners`))[0]!.seen_at
    await call("heartbeat", token, { key: "none#g1", claim: crypto.randomUUID() })
    expect((await sql<{ seen_at: Date }>(`SELECT seen_at FROM runners`))[0]!.seen_at).toEqual(seen)
    await sql(`UPDATE runners SET seen_at = now() - interval '2 minutes'`)
    await sql(`INSERT INTO fleet_alerts (id, kind, repo_id, subject, title, href) VALUES ('o', 'offline', '${REPO}', '${id}', 't', '/x')`)
    await call("heartbeat", token, { key: "none#g1", claim: crypto.randomUUID() })
    expect((await sql<{ closed: boolean }>(`SELECT closed_at IS NOT NULL AS closed FROM fleet_alerts`))[0]!.closed).toBe(true)
  })
})

const BOT_TOKEN = "123456:SYNTHETIC_FLEET_BOT"
const APP_URL = "https://smithers.test/app"
const CHAT = "-1001234500001"

let providers: AlertProviders
beforeAll(async () => {
  providers = await startAlertProviders()
})
afterAll(() => providers.close())
beforeEach(() => void providers.received.splice(0))

const channels = () => Channels.layer({ telegram: { token: Redacted.make(BOT_TOKEN), url: providers.url } })

/** A person who holds `role` on the repository as GitHub said (`github_repo_roles`): their id. */
const holder = async (role: string, repo = REPO) => {
  const id = crypto.randomUUID()
  await sql(`INSERT INTO github_repo_roles (repo_id, person_id, role) VALUES ('${repo}', '${id}', '${role}')`)
  return id
}

const bells = () =>
  sql<{ recipient: string; subject: string; kind: string; title: string; href: string }>(
    `SELECT recipient, subject, kind, title, href FROM notifications ORDER BY recipient`,
  )

describe("ops/FleetAlert and ops/RunnerHealth on the Node host", () => {
  test("a stalled run: the committer and the repository's Maintainers hear it once, in the bell and on Telegram", async () => {
    await sql(`INSERT INTO alert_channels (channel, destinations, app_url, updated_by) VALUES ('telegram', '["${CHAT}"]'::jsonb, '${APP_URL}', 'p')`)
    const maintainer = await holder("maintainer")
    const admin = await holder("admin")
    await holder("member")
    await holder("maintainer", "github/acme/other")
    const attemptId = await todo("person-maya")
    const { jobs } = await store()
    await Effect.runPromise(jobs.start(taskOf(attemptId), "stall#g1"))
    const alert: Fleet.Alert = { alertId: Fleet.alertId.stalled("stall#g1", 1), kind: "stalled", repoId: REPO, subject: "stall#g1" }
    const registration = FleetAlert.registration(await database(), HOME, channels())

    const ran = await runFlow(FleetAlert.FleetAlert, alert, registration, { executionId: alert.alertId })

    expect(ran.status).toBe("completed")
    expect(Exit.isSuccess(ran.exit) && ran.exit.value).toEqual({ email: { outcome: "off" }, telegram: { outcome: "sent" } })
    const row = { subject: `fleet:${alert.alertId}`, kind: "fleet", title: "T7 drive foldkit · Stalled", href: "/acme/widgets/stack/7" }
    expect(await bells()).toEqual(
      [maintainer, admin, "person-maya"].sort().map((recipient) => ({ recipient, ...row })),
    )
    const telegram = providers.received.find((request) => request.provider === "telegram")
    expect(telegram!.body).toMatchObject({ chat_id: CHAT, text: "T7 drive foldkit · Stalled\n\nhttps://smithers.test/acme/widgets/stack/7" })
    // Again: no second bell, no second message.
    const again = await runFlow(FleetAlert.FleetAlert, alert, registration)
    expect(Exit.isSuccess(again.exit) && again.exit.value).toEqual({ email: { outcome: "off" }, telegram: { outcome: "existing" } })
    expect(await bells()).toHaveLength(3)
    expect(providers.received).toHaveLength(1)
    expect(JSON.stringify([await bells(), providers.received])).not.toContain("PROMPT-SENTINEL")
  })

  test("a runner offline reaches its Admins only; a failed TODO run its committer and Maintainers with its code", async () => {
    await register("nyc-01")
    const id = (await sql<{ id: string }>(`SELECT id::text AS id FROM runners`))[0]!.id
    const admin = await holder("admin")
    await holder("maintainer")
    const offline: Fleet.Alert = { alertId: Fleet.alertId.offline(id, 5), kind: "offline", repoId: REPO, subject: id }
    const registration = FleetAlert.registration(await database(), HOME)
    await runFlow(FleetAlert.FleetAlert, offline, registration)
    expect(await bells()).toEqual([
      { recipient: admin, subject: `fleet:${offline.alertId}`, kind: "fleet", title: "Runner nyc-01 offline", href: "/acme/widgets/-/fleet" },
    ])
    await sql(`TRUNCATE notifications`)
    const attemptId = await todo("person-maya", 8)
    await sql(`UPDATE todos SET failure = 'implement' WHERE number = 8`)
    const failed: Fleet.Alert = { alertId: Fleet.alertId.failed(attemptId), kind: "failed", repoId: REPO, subject: attemptId }
    await runFlow(FleetAlert.FleetAlert, failed, registration)
    expect((await bells()).map((bell) => bell.title)).toEqual(["T8 drive foldkit · Failed · implement", "T8 drive foldkit · Failed · implement", "T8 drive foldkit · Failed · implement"])
    // A subject that's gone rings nothing.
    const gone: Fleet.Alert = { alertId: "fleet-failed-gone", kind: "failed", repoId: REPO, subject: crypto.randomUUID() }
    const ran = await runFlow(FleetAlert.FleetAlert, gone, registration)
    expect(Exit.isSuccess(ran.exit) && ran.exit.value).toEqual({ email: { outcome: "off" }, telegram: { outcome: "off" } })
  })

  test("the deployment's own repository reaches its live sessions' Maintainers", async () => {
    const person = crypto.randomUUID()
    await sql(`INSERT INTO people (id, github_id, github_login) VALUES ('${person}', 1, 'will')`)
    await sql(`
      INSERT INTO sessions (id, token_digest, person_id, role, role_checked_at, expires_at)
      VALUES ('${crypto.randomUUID()}', '${crypto.randomUUID()}', '${person}', 'maintainer', now(), now() + interval '1 day')`)
    await query(Store.addRunner({ repoId: HOME, name: "nyc-02", tokenSha256: digestSync("t"), labels: [], capacity: 1 }, by()))
    await Effect.runPromise(Jobs.make(await database()).start({ ...taskOf(), repository: HOME }, "home#g1"))
    const alert: Fleet.Alert = { alertId: "fleet-waiting-home", kind: "waiting", repoId: HOME, subject: "home#g1" }
    await runFlow(FleetAlert.FleetAlert, alert, FleetAlert.registration(await database(), HOME))
    expect((await bells()).map((bell) => [bell.recipient, bell.title])).toEqual([[person, "Agent run · Waiting for a runner"]])
  })

  test("ops/RunnerHealth starts one Runner offline alert per outage, for runners unseen past the threshold", async () => {
    await register("nyc-01")
    await register("nyc-02")
    await register("never")
    await sql(`UPDATE runners SET seen_at = now() - interval '2 minutes' WHERE name = 'nyc-01'`)
    await sql(`UPDATE runners SET seen_at = now() WHERE name = 'nyc-02'`)
    const started: Array<Fleet.Alert> = []
    const registration = FleetAlert.healthRegistration(await database(), 60, (alert) => Effect.sync(() => void started.push(alert)))
    const ran = await runFlow(FleetAlert.RunnerHealth, { from: 0, until: 60_000 }, registration)
    expect(Exit.isSuccess(ran.exit) && ran.exit.value).toEqual({ offline: 1 })
    expect(started.map((alert) => alert.kind)).toEqual(["offline"])
    expect(started[0]!.alertId).toMatch(/^fleet-offline-[0-9a-f-]+-\d+$/)
  })
})
