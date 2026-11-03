// External agents on runners (decision 0136) against the compose Postgres, on this file's own schema: the Admin
// routes and flows, the job store an `ExternalAgent` step drives, and the routes a runner pulls its jobs through. The
// flows run for real on the Node host's durable engine (worker/test/flowHost.ts). Nothing is scripted but who is signed
// in.
import { AgentRunner, Transcript } from "@smthrs/agent"
import { digestSync } from "@smthrs/crypto"
import { Action, Fault, type Flow, FlowRuntime } from "@smthrs/flow"
import { Database as FlowsDatabase, Journal } from "@smthrs/flows"
import { Notification, NotificationQueue, SteerPayload } from "@smthrs/notifications"
import { Context, Effect, Exit, Layer, Logger, Option, Scope } from "effect"
import { ConnectionError, SqlError } from "effect/sql/SqlError"
import { HttpEffect } from "effect/http"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as MigrationReauthorization from "../../db/migrations/0095_runner_reauthorization.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as Actor from "../Actor.ts"
import { BranchRoles } from "../branch/Access.ts"
import type * as RepoRoles from "../github/RepoRoles.ts"
import * as TodoSession from "../flows/TodoSession.ts"
import * as ExecutionHost from "../ExecutionHost.ts"
import * as Flows from "../Flows.ts"
import * as FlowHost from "../test/flowHost.ts"
import * as RunContentTest from "../test/runContent.ts"
import { branchRoles, signedIn, signedOut, testFile } from "../test/harness.ts"
import * as Admin from "./Admin.ts"
import type * as Fence from "./Fence.ts"
import * as AdminFlows from "./AdminFlows.ts"
import * as RunnersApi from "./Api.ts"
import * as Jobs from "./Jobs.ts"
import * as RunContent from "./RunContent.ts"
import * as Store from "./Store.ts"

const runtime = testFile("runners")
const REPO = "github/acme/widgets"
const BASE = "0123456789abcdef0123456789abcdef01234567"

beforeEach(() =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`TRUNCATE agent_jobs, runners, runner_changes, agents, agent_changes, github_repositories, github_repo_roles,
      admin_receipts, admin_generations RESTART IDENTITY CASCADE`)))

const database = () => runtime.runPromise(Effect.map(Effect.service(TestDatabase.Scratch), (scratch) => scratch.database))
const query = <A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) => runtime.runPromise(effect)
const sql = <A extends object>(strings: TemplateStringsArray, ...values: Array<unknown>) =>
  query(Effect.flatMap(SqlClient.SqlClient, (client) => client<A>(strings, ...(values as Array<never>))))

const admin: Actor.Actor = { subject: { kind: "person", id: "person-admin" }, role: "admin" }
const member: Actor.Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }

const agent: AgentRunner.Agent = { name: "coder", labels: ["linux"], profile: "coder-profile", maxHours: 4, restarts: 1 }
const taskOf = (overrides: Partial<AgentRunner.Task> = {}): AgentRunner.Task => ({
  agent,
  repository: REPO,
  base: BASE,
  system: [],
  prompt: "PROMPT-SENTINEL add alpha",
  limits: { files: 2, bytes: 8 },
  ...overrides,
})

/** Records the App's installation on `repoId`, as installation discovery does (worker/github/Store.ts). */
const recordInstallation = (repoId = REPO) =>
  sql`INSERT INTO github_repositories (repo_id, installation_id) VALUES (${repoId}, 42)
    ON CONFLICT (repo_id) DO UPDATE SET installation_id = 42`

let invocations = 0
const by = (): Store.By => ({ actorId: "person-admin", invocationKey: `test-${++invocations}` })

/** Registers runner `name` and answers its token. */
const register = async (name: string, labels: ReadonlyArray<string> = ["linux", "nyc"], capacity = 2) => {
  const token = `token-${name}-${crypto.randomUUID()}`
  await recordInstallation()
  await query(Store.addRunner({ repoId: REPO, name, tokenSha256: digestSync(token), labels, capacity, repoAuthorized: true }, by()))
  return token
}

/**
 * The runner routes over this file's schema, a claim asking again every 50 ms, a TODO's job writing its transcript to
 * its run as ChatApi's does, over `transcripts` (one SQLite store per run unless set), and a heartbeat carrying the
 * steers `steering` hands out.
 */
const routes = async (
  onClaimed?: (task: AgentRunner.Task) => Effect.Effect<void, unknown>,
  transcripts: Layer.Layer<RunContent.Transcripts> = RunContentTest.transcripts().layer,
  steering?: RunnersApi.Steering<never>,
) => {
  const handler = HttpEffect.toWebHandler(
    RunnersApi.make(await database(), {
      pollMillis: 50,
      runOf: TodoSession.runOf,
      ...(onClaimed === undefined ? {} : { onClaimed }),
      ...(steering === undefined ? {} : { steering }),
    }).fetch.pipe(Effect.provide(transcripts)),
  )
  const call = async <A>(route: keyof typeof AgentRunner.ROUTES, token: string | undefined, body: unknown) => {
    const response = await handler(new Request(`http://localhost${AgentRunner.ROUTES[route]}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }))
    return { status: response.status, body: (await response.json()) as A }
  }
  const claim = (token: string, wants: Partial<typeof AgentRunner.ClaimRequest.Type> = {}) =>
    call<{ readonly job: AgentRunner.Job | null }>("claim", token, {
      profiles: ["coder-profile"],
      free: 1,
      running: [],
      waitSeconds: 0,
      ...wants,
    })
  return { handler, call, claim }
}

/** The job store over this file's schema. */
const jobs = async () => Jobs.make(await database())

const done = (changes: AgentRunner.Changes = { additions: [{ path: "NOTES.md", contents: "YWxwaGEK" }], deletions: [] }) =>
  ({ _tag: "Done", changes, summary: "Added alpha.", usage: {} }) as const

describe("the job store and the runner routes", () => {
  test("a fleet database outage after claiming preserves the claim and records its code", async () => {
    const token = await register("projection-claim")
    await Effect.runPromise((await jobs()).start(taskOf(), "todo:claim-projection#g1"))
    const db = await database()
    const failure = new SqlError({ reason: new ConnectionError({ cause: "injected outage", message: "unavailable", operation: "execute" }) })
    let opened = 0
    const flaky = Layer.fresh(Layer.unwrap(Effect.sync(() => ++opened === 4 ? Layer.effect(SqlClient.SqlClient, Effect.fail(failure)) : db)))
    const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
    const handler = HttpEffect.toWebHandler(RunnersApi.make(flaky, { runOf: TodoSession.runOf }).fetch.pipe(
      Effect.provide(RunContentTest.transcripts().layer),
      Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((o) => void logs.push(Logger.formatStructured.log(o)))])),
    ))
    const response = await handler(new Request(`http://localhost${AgentRunner.ROUTES.claim}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ profiles: [agent.profile], free: 1, running: [], waitSeconds: 0 }),
    }))
    expect([response.status, await response.json()]).toEqual([200, { job: expect.objectContaining({ key: "todo:claim-projection#g1" }) }])
    expect(await sql`SELECT status FROM agent_jobs WHERE key = 'todo:claim-projection#g1'`).toEqual([{ status: "claimed" }])
    expect(logs).toContainEqual(expect.objectContaining({ message: "runner.claim", annotations: expect.objectContaining({ fleet: "sql:ConnectionError", outcome: "claimed" }) }))
  })
  test("a failed fleet projection preserves the admitted job and reports its code", async () => {
    const db = await database()
    let opened = 0
    const fault = new SqlError({ reason: new ConnectionError({ cause: "injected outage", message: "unavailable", operation: "execute" }) })
    const flaky = Layer.fresh(Layer.unwrap(Effect.sync(() => ++opened === 1 ? db : Layer.effect(SqlClient.SqlClient, Effect.fail(fault)))))
    const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
    const store = Jobs.make(flaky)
    await Effect.runPromise(store.start(taskOf(), "todo:projection#g1").pipe(
      Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((o) => void logs.push(Logger.formatStructured.log(o)))])),
    ))
    expect(await sql`SELECT key, status FROM agent_jobs WHERE key = 'todo:projection#g1'`).toEqual([{ key: "todo:projection#g1", status: "queued" }])
    expect(logs).toContainEqual(expect.objectContaining({ message: "fleet.project", annotations: expect.objectContaining({ outcome: "error", errorCode: "sql:ConnectionError" }) }))
  })

  test.each([false, true])("settlement acknowledges delivered steering even when its writer fails: %s", async (fails) => {
    const token = await register("delivery")
    const store = await jobs()
    const task = taskOf({ context: { attemptId: "delivery" } })
    await Effect.runPromise(store.start(task, "todo:delivery#g1"))
    const scope = Effect.runSync(Scope.make())
    try {
      const { engine } = await Effect.runPromise(Scope.provide(FlowHost.build(Layer.empty), scope))
      const server = (await runtime.runPromise(TestDatabase.serverUrl)).toString()
      const writer = ExecutionHost.database(server, engine.schema)
      const queue = NotificationQueue.layer.pipe(Layer.provideMerge(Journal.SqlJournal.layer({ capacity: 1024, overflow: "reject", sourceEventCache: 1 }).pipe(
        Layer.provideMerge(Layer.provideMerge(FlowsDatabase.DurableWriter.layer(), writer)),
      )))
      await Effect.runPromise(Effect.scoped(Effect.flatMap(NotificationQueue.NotificationQueue, (notifications) => notifications.admit("todo:delivery",
        Notification.humanSteer({ runId: "todo:delivery", id: "steer-one", actor: "person:member", attribution: { login: "maya", via: "person" }, payload: SteerPayload.encode({ kind: "Message", body: "Inspect" }) }),
      )).pipe(Effect.provide(queue))))
      const real = TodoSession.steering(writer)
      expect((await Effect.runPromise(real.pending(task))).map((steer) => steer.id)).toEqual(["steer-one"])
      const steering = fails ? { ...real, delivered: () => Effect.fail("injected steering outage") } : real
      const { call, claim } = await routes(undefined, undefined, steering)
      const job = (await claim(token, { machine: {} })).body.job!
      expect((await call("settle", token, { key: job.key, claim: job.claim, outcome: done(), delivered: ["steer-one"] })).body).toEqual({ recorded: true })
      expect((await Effect.runPromise(real.pending(task))).map((steer) => steer.id)).toEqual(fails ? ["steer-one"] : [])
      expect(await Effect.runPromise(store.status(job.key))).toMatchObject({ _tag: "Ended", outcome: { _tag: "Done" } })
    } finally { await Effect.runPromise(Scope.close(scope, Exit.void)) }
  })
  test("a steering store that can't answer hands out no steers and keeps the lease; a job asked to stop hands out none", async () => {
    const token = await register("nyc-01")
    const store = await jobs()
    await Effect.runPromise(store.start(taskOf(), "todo:s#g1"))
    const asked: Array<string> = []
    // A faulty steering service: the heartbeat must renew the lease all the same.
    const { call, claim } = await routes(undefined, undefined, {
      pending: () => Effect.sync(() => void asked.push("pending")).pipe(Effect.andThen(Effect.fail("down"))),
      delivered: (_task, key, ids) => Effect.sync(() => void asked.push(`delivered:${key}:${ids.join(",")}`)),
    })
    const job = (await claim(token)).body.job!
    expect((await call("heartbeat", token, { key: job.key, claim: job.claim, delivered: ["s1"] })).body).toEqual({
      held: true,
      cancel: false,
      leaseSeconds: 45,
    })
    expect(asked).toEqual(["delivered:todo:s#g1:s1", "pending"])
    await Effect.runPromise(store.cancel(job.key))
    expect((await call("heartbeat", token, { key: job.key, claim: job.claim })).body).toEqual({
      held: true,
      cancel: true,
      leaseSeconds: 45,
    })
    expect(asked).toHaveLength(2)
  })

  test("Stop ends every open generation of a step, and a later generation of it queues cancelled", async () => {
    const token = await register("nyc-01")
    const store = await jobs()
    const { call, claim } = await routes()
    // g1 claimed: stopped at its runner's next heartbeat.
    await Effect.runPromise(store.start(taskOf(), "todo:t#g1"))
    const job = (await claim(token)).body.job!
    expect(await query(Jobs.stop("todo:t"))).toBe(1)
    expect((await call("heartbeat", token, { key: job.key, claim: job.claim })).body).toMatchObject({ cancel: true })
    // A retryable settlement of a job asked to stop ends it cancelled, so no g2 follows.
    expect((await call("settle", token, { key: job.key, claim: job.claim, outcome: { _tag: "Retryable" } })).body)
      .toEqual({ recorded: true })
    expect(await Effect.runPromise(store.status("todo:t#g1"))).toEqual({
      _tag: "Ended",
      outcome: { _tag: "Cancelled", processTreeGone: true },
    })
    // g1 retryable, then stopped before g2 starts: g1 ends cancelled, and g2's start queues it cancelled.
    await Effect.runPromise(store.start(taskOf(), "todo:u#g1"))
    const second = (await claim(token)).body.job!
    await call("settle", token, { key: second.key, claim: second.claim, outcome: { _tag: "Retryable" } })
    expect(await query(Jobs.stop("todo:u"))).toBe(1)
    await Effect.runPromise(store.start(taskOf(), "todo:u#g2"))
    expect(await sql`SELECT key, status, cancel_requested FROM agent_jobs WHERE origin = 'todo:u' ORDER BY key`).toEqual([
      { key: "todo:u#g1", status: "cancelled", cancel_requested: true },
      { key: "todo:u#g2", status: "cancelled", cancel_requested: true },
    ])
    expect((await claim(token)).body.job).toBeNull()
    // Nothing open: a second Stop finds none.
    expect(await query(Jobs.stop("todo:u"))).toBe(0)
  })

  test("a job is queued once, claimed by a runner with its profile and labels, and settled with its change", async () => {
    const token = await register("nyc-01")
    const store = await jobs()
    const { call, claim } = await routes()
    await Effect.runPromise(store.start(taskOf(), "todo:1#g1"))
    await Effect.runPromise(store.start(taskOf({ prompt: "another" }), "todo:1#g1"))
    expect(await sql`SELECT key FROM agent_jobs`).toHaveLength(1)
    expect(await Effect.runPromise(store.status("todo:1#g1"))).toEqual({ _tag: "Running" })
    const claimed = await claim(token)
    expect(claimed.status).toBe(200)
    const job = claimed.body.job!
    expect(job).toMatchObject({ key: "todo:1#g1", generation: 1, task: taskOf(), reclaimed: false, leaseSeconds: 45 })
    expect(job.deadline).toBeGreaterThan(Date.now() + 3 * 3600_000)
    expect((await call("heartbeat", token, { key: job.key, claim: job.claim })).body).toEqual({
      held: true,
      cancel: false,
      leaseSeconds: 45,
    })
    expect((await call("settle", token, { key: job.key, claim: job.claim, outcome: done() })).body).toEqual({ recorded: true })
    expect(await Effect.runPromise(store.status("todo:1#g1"))).toEqual({ _tag: "Ended", outcome: done() })
    // The claim ended with the settlement.
    expect((await call("heartbeat", token, { key: job.key, claim: job.claim })).body).toMatchObject({ held: false })
    expect((await call("settle", token, { key: job.key, claim: job.claim, outcome: done() })).body).toEqual({ recorded: false })
  })

  test("a runner claims nothing it lacks the profile, the labels or the room for", async () => {
    const small = await register("small", ["linux"], 1)
    const mac = await register("mac", ["mac"])
    const store = await jobs()
    const { claim } = await routes()
    await Effect.runPromise(store.start(taskOf(), "todo:a#g1"))
    await Effect.runPromise(store.start(taskOf(), "todo:b#g1"))
    expect((await claim(small, { profiles: ["other"] })).body.job).toBeNull()
    expect((await claim(mac)).body.job).toBeNull()
    expect((await claim(small, { free: 0 })).body.job).toBeNull()
    expect((await claim(small, { running: [] })).body.job?.key).toBe("todo:a#g1")
    // At its capacity of one, the runner claims no second job, and gets its held one back instead.
    expect((await claim(small, { running: ["todo:a#g1"] })).body.job).toBeNull()
  })

  test("a runner that restarted gets its held job back with the same claim, even after its lease ran out", async () => {
    const token = await register("nyc-01")
    const store = await jobs()
    const { call, claim } = await routes()
    await Effect.runPromise(store.start(taskOf(), "todo:r#g1"))
    const first = (await claim(token)).body.job!
    await sql`UPDATE agent_jobs SET lease_until = now() - interval '1 minute'`
    // A lapsed lease doesn't free the job: it still reads Running.
    expect(await Effect.runPromise(store.status("todo:r#g1"))).toEqual({ _tag: "Running" })
    const again = (await claim(token, { running: [] })).body.job!
    expect(again).toMatchObject({ key: first.key, claim: first.claim, reclaimed: true })
    expect((await call("heartbeat", token, { key: first.key, claim: first.claim })).body).toMatchObject({ held: true })
  })

  test("a retryable end is replaced on the same runner, after its wait, until the agent's restarts are spent", async () => {
    const one = await register("nyc-01")
    const two = await register("nyc-02")
    const store = await jobs()
    const { call, claim } = await routes()
    await Effect.runPromise(store.start(taskOf(), "todo:x#g1"))
    const g1 = (await claim(one)).body.job!
    await call("settle", one, { key: g1.key, claim: g1.claim, outcome: { _tag: "Retryable", afterSeconds: 0 } })
    expect(await Effect.runPromise(store.status("todo:x#g1"))).toEqual({ _tag: "Again" })
    await Effect.runPromise(store.start(taskOf(), "todo:x#g2"))
    expect((await claim(two)).body.job).toBeNull()
    const g2 = (await claim(one)).body.job!
    expect(g2).toMatchObject({ key: "todo:x#g2", generation: 2, deadline: g1.deadline })
    await call("settle", one, { key: g2.key, claim: g2.claim, outcome: { _tag: "Retryable", afterSeconds: 3600 } })
    // The agent has one restart: generation 2's retryable end is its last.
    expect(await Effect.runPromise(store.status("todo:x#g2"))).toEqual({
      _tag: "Ended",
      outcome: { _tag: "Failed", reason: "exhausted" },
    })
    // Generation 2 waited the 0 seconds generation 1 asked for: it was due at once.
    const [held] = await sql<{ due: boolean }>`
      SELECT not_before <= now() AS due FROM agent_jobs WHERE key = 'todo:x#g2'`
    expect(held).toEqual({ due: true })
  })

  test("a generation after a retryable end with a wait isn't claimed before it", async () => {
    const token = await register("nyc-01")
    const store = await jobs()
    const { call, claim } = await routes()
    await Effect.runPromise(store.start(taskOf(), "todo:w#g1"))
    const g1 = (await claim(token)).body.job!
    await call("settle", token, { key: g1.key, claim: g1.claim, outcome: { _tag: "Retryable", afterSeconds: 3600 } })
    await Effect.runPromise(store.start(taskOf(), "todo:w#g2"))
    expect((await claim(token)).body.job).toBeNull()
  })

  test("a change over the job's limits is recorded too_large, and a retryable end of a stopped job cancelled", async () => {
    const token = await register("nyc-01")
    const store = await jobs()
    const { call, claim } = await routes()
    await Effect.runPromise(store.start(taskOf(), "todo:big#g1"))
    const big = (await claim(token)).body.job!
    const tooMany = done({ additions: [{ path: "a", contents: "" }, { path: "b", contents: "" }], deletions: ["c"] })
    await call("settle", token, { key: big.key, claim: big.claim, outcome: tooMany })
    expect(await Effect.runPromise(store.status(big.key))).toEqual({
      _tag: "Ended",
      outcome: { _tag: "Failed", reason: "too_large" },
    })
    await Effect.runPromise(store.start(taskOf(), "todo:stop#g1"))
    const stop = (await claim(token)).body.job!
    await Effect.runPromise(store.cancel(stop.key))
    expect((await call("heartbeat", token, { key: stop.key, claim: stop.claim })).body).toMatchObject({ held: true, cancel: true })
    await call("settle", token, { key: stop.key, claim: stop.claim, outcome: { _tag: "Retryable" } })
    expect(await Effect.runPromise(store.status(stop.key))).toEqual({
      _tag: "Ended",
      outcome: { _tag: "Cancelled", processTreeGone: true },
    })
  })

  test("a cancel that reaches the store before its start wins, and a queued job past its hours ends timeout", async () => {
    const token = await register("nyc-01")
    const store = await jobs()
    const { claim } = await routes()
    await Effect.runPromise(store.cancel("todo:c#g1"))
    await Effect.runPromise(store.start(taskOf(), "todo:c#g1"))
    expect(await Effect.runPromise(store.status("todo:c#g1"))).toEqual({
      _tag: "Ended",
      outcome: { _tag: "Cancelled", processTreeGone: true },
    })
    await Effect.runPromise(store.start(taskOf(), "todo:t#g1"))
    await sql`UPDATE agent_jobs SET deadline_at = now() - interval '1 second' WHERE key = 'todo:t#g1'`
    expect((await claim(token)).body.job).toBeNull()
    expect(await Effect.runPromise(store.status("todo:t#g1"))).toEqual({
      _tag: "Ended",
      outcome: { _tag: "Failed", reason: "timeout" },
    })
    // A key nothing started reads as another generation's.
    expect(await Effect.runPromise(store.status("todo:none#g1"))).toEqual({ _tag: "Again" })
  })

  test("onClaimed hears each claim and reclaim with its task; its failure or defect never refuses the claim", async () => {
    const token = await register("nyc-01")
    const store = await jobs()
    const heard: Array<string | undefined> = []
    const failures = ["fail", "die"]
    const { claim } = await routes((task) =>
      Effect.suspend(() => {
        heard.push(task.context?.attemptId)
        const next = failures.shift()
        return next === "fail" ? Effect.fail(new Error("hook")) : next === "die" ? Effect.die(new Error("hook")) : Effect.void
      })
    )
    await Effect.runPromise(store.start(taskOf({ context: { attemptId: "attempt-1" } }), "todo:h#g1"))
    expect((await claim(token)).body.job?.key).toBe("todo:h#g1")
    expect((await claim(token, { running: [] })).body.job?.reclaimed).toBe(true)
    expect((await claim(token, { running: [] })).body.job?.reclaimed).toBe(true)
    expect(heard).toEqual(["attempt-1", "attempt-1", "attempt-1"])
  })

  test("the routes refuse a missing, unknown or removed runner's token, other methods and bodies, and log no task", async () => {
    const token = await register("nyc-01")
    const { call, handler } = await routes()
    expect((await call("claim", undefined, {})).status).toBe(401)
    expect((await call("claim", "not-a-token", {})).status).toBe(401)
    expect((await call("claim", token, "{")).status).toBe(400)
    expect((await call("heartbeat", token, { key: "k#g1", claim: "not-a-uuid" })).body).toMatchObject({ held: false })
    expect((await call("settle", token, { key: "k#g1", claim: "not-a-uuid", outcome: done() })).body).toEqual({
      recorded: false,
    })
    expect((await handler(new Request(`http://localhost${AgentRunner.ROUTES.claim}`))).status).toBe(405)
    await query(Store.removeRunner({ repoId: REPO, name: "nyc-01" }, by()))
    expect((await call("claim", token, {})).status).toBe(401)
    expect(RunnersApi.handles("/api/runners/claim")).toBe(true)
    expect(RunnersApi.handles("/api/runners/events")).toBe(true)
    expect(RunnersApi.handles("/api/runners")).toBe(false)
  })
})

describe("the runner events route", () => {
  const said = (seq: number, text: string, kind = "agent_message_chunk"): Transcript.Event => ({
    seq,
    at: Date.now() - 200,
    kind,
    update: { sessionUpdate: kind, content: { type: "text", text } },
  })
  const summaryOf = async (key: string) =>
    (await sql<{
      readonly first: boolean
      readonly last: boolean
      readonly events: string | null
      readonly bytes: string | null
    }>`SELECT first_event_at IS NOT NULL AS first, last_event_at IS NOT NULL AS last,
        transcript_events::text AS events, transcript_bytes::text AS bytes FROM agent_jobs WHERE key = ${key}`)[0]!

  test("a runner's events reach its job's run once each, scrubbed again; the job keeps its first event and its totals", async () => {
    const token = await register("nyc-01")
    const other = await register("nyc-02")
    const store = await jobs()
    const transcripts = RunContentTest.transcripts()
    const { call, claim } = await routes(undefined, transcripts.layer)
    await Effect.runPromise(store.start(taskOf({ context: { attemptId: "a1" } }), "todo:a1#g1"))
    const job = (await claim(token)).body.job!
    expect(await summaryOf(job.key)).toEqual({ first: false, last: false, events: null, bytes: null })
    const sent = await call("events", token, {
      key: job.key,
      claim: job.claim,
      events: [said(0, "hello"), said(1, "token ghp_abcdefgh1234 and ops@example.org")],
    })
    expect([sent.status, sent.body]).toEqual([200, { next: 2 }])
    const run = transcripts.of("todo:a1")
    expect(RunContent.page(run, -1).map((row) => (row.update.content as { text: string }).text)).toEqual([
      "hello",
      `token ${Transcript.REDACTED} and ${Transcript.REDACTED}`,
    ])
    expect(await summaryOf(job.key)).toMatchObject({ first: true, last: true, events: "2" })
    // An empty post only asks where the run stands.
    expect((await call("events", token, { key: job.key, claim: job.claim, events: [] })).body).toEqual({ next: 2 })
    // A gap answers where the runner sends from; a repeat is kept once. Totals wait 30 s between writes.
    expect((await call("events", token, { key: job.key, claim: job.claim, events: [said(3, "later"), said(1, "x")] })).body)
      .toEqual({ next: 2 })
    expect((await summaryOf(job.key)).events).toBe("2")
    await sql`UPDATE agent_jobs SET last_event_at = now() - interval '31 seconds' WHERE key = ${job.key}`
    expect((await call("events", token, { key: job.key, claim: job.claim, events: [said(2, "fill")] })).body)
      .toEqual({ next: 4 })
    expect((await summaryOf(job.key)).events).toBe("4")
    expect(Number((await summaryOf(job.key)).bytes)).toBe(RunContent.summary(run).bytes)
    // A settled job's last events still arrive from its runner; another runner, or an unknown job, is refused.
    await call("settle", token, { key: job.key, claim: job.claim, outcome: done() })
    expect((await call("events", token, { key: job.key, claim: job.claim, events: [said(4, "end")] })).body)
      .toEqual({ next: 5 })
    const refused = await call("events", other, { key: job.key, claim: job.claim, events: [said(5, "no")] })
    expect([refused.status, refused.body]).toEqual([409, { code: "not_held" }])
    expect((await call("events", token, { key: "todo:zz#g1", claim: job.claim, events: [] })).status).toBe(409)
    expect(RunContent.summary(run).events).toBe(5)
  })

  test("refuses an event a runner should have dropped, a job with no run, and a body that isn't events", async () => {
    const token = await register("nyc-01")
    const store = await jobs()
    const { call, claim } = await routes()
    await Effect.runPromise(store.start(taskOf({ context: { attemptId: "a2" } }), "todo:a2#g1"))
    const job = (await claim(token)).body.job!
    const dropped = await call("events", token, {
      key: job.key,
      claim: job.claim,
      events: [{ seq: 0, at: 1, kind: "available_commands_update", update: {} }],
    })
    expect([dropped.status, dropped.body]).toEqual([400, { code: "invalid" }])
    expect((await call("events", token, { key: job.key, claim: job.claim, events: [{ seq: -1 }] })).status).toBe(400)
    await Effect.runPromise(store.start(taskOf(), "plain#g1"))
    const plain = (await claim(token, { free: 2, running: [job.key] })).body.job!
    const none = await call("events", token, { key: plain.key, claim: plain.claim, events: [said(0, "hi")] })
    expect([none.status, none.body]).toEqual([409, { code: "no_transcript" }])
  })

  test("a run's transcript that can't be reached answers 503, so the runner keeps its spool and sends again", async () => {
    const token = await register("nyc-01")
    const store = await jobs()
    const unreachable = Layer.succeed(RunContent.Transcripts, RunContent.Transcripts.of({
      append: () => Effect.fail(new RunContent.TranscriptsUnavailable()),
    }))
    const { call, claim } = await routes(undefined, unreachable)
    await Effect.runPromise(store.start(taskOf({ context: { attemptId: "a3" } }), "todo:a3#g1"))
    const job = (await claim(token)).body.job!
    const answer = await call("events", token, { key: job.key, claim: job.claim, events: [said(0, "hi")] })
    expect([answer.status, answer.body]).toEqual([503, { code: "unavailable" }])
    expect(await summaryOf(job.key)).toMatchObject({ first: false })
  })
})

describe("the repository's runners and agents", () => {
  test("each Admin write records its change once per invocation key", async () => {
    const key = by()
    const write = { repoId: REPO, name: "nyc-01", tokenSha256: "a".repeat(64), labels: ["linux"], capacity: 4, repoAuthorized: true }
    expect(await query(Store.addRunner(write, key))).toBe("set")
    expect(await query(Store.addRunner({ ...write, capacity: 8 }, key))).toBe("repeat")
    expect(await sql`SELECT capacity FROM runners`).toEqual([{ capacity: 4 }])
    expect(await query(Store.setAgent({ repoId: REPO, agent, coding: true }, by()))).toBe("set")
    expect(await query(Store.setAgent({ repoId: REPO, agent: { ...agent, name: "other" }, coding: true }, by()))).toBe("set")
    expect(Option.map(await query(Store.codingAgent(REPO)), (each) => each.name)).toEqual(Option.some("other"))
    expect(await query(Store.removeAgent({ repoId: REPO, name: "other" }, by()))).toBe("removed")
    expect(await query(Store.removeAgent({ repoId: REPO, name: "other" }, by()))).toBe("missing")
    expect(await query(Store.codingAgent(REPO))).toEqual(Option.none())
    expect(await query(Store.removeRunner({ repoId: REPO, name: "nyc-01" }, by()))).toBe("removed")
    expect(await query(Store.removeRunner({ repoId: REPO, name: "nyc-01" }, by()))).toBe("missing")
  })

  test("todo/Agent reads the repository's coding agent, or Smithers' own", async () => {
    const step = TodoSession.agentStep(await database())
    expect(await Effect.runPromise(step({ attemptId: "a", repoId: REPO }))).toEqual({ agent: null })
    await query(Store.setAgent({ repoId: REPO, agent, coding: true }, by()))
    expect(await Effect.runPromise(step({ attemptId: "a", repoId: REPO }))).toEqual({ agent })
  })

  /** The Admin routes as `actor`, with flows run to their end on the Node host before the route answers. */
  const adminRoutes = async (actor: Actor.Actor | null, repo = "acme/widgets") => {
    const db = await database()
    const scope = Effect.runSync(Scope.make())
    const built = await Effect.runPromise(Scope.provide(FlowHost.build(AdminFlows.registration(db)), scope))
    const flows = Context.get(built.context, FlowRuntime.FlowRuntime)
    const starter = Flows.FlowStarter.of({
      start: (flow: Flow.Any, { executionId, payload }) =>
        (flows.execute(flow as never, { executionId, payload: payload as never }) as Effect.Effect<unknown, unknown>).pipe(
          Effect.provide(built.context),
          Effect.orDie,
          Effect.asVoid,
        ),
    })
    const api = await Effect.runPromise(Admin.make(db))
    const handler = HttpEffect.toWebHandler(api.fetch.pipe(
      Effect.provideService(Flows.FlowStarter, starter),
      Effect.provide(actor === null ? signedOut : signedIn(actor)),
      Effect.provide(branchRoles(db, "acme/widgets")),
    ))
    const send = async (path: string, method: string, body?: unknown) => {
      const response = await handler(new Request(`http://localhost/api/repos/${repo}/${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }))
      return { status: response.status, body: await response.json().catch(() => null) }
    }
    return { send, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
  }

  /**
   * The Admin routes as `actor` on `repo`: on `acme/private` its role GitHub gives is read from its `github_repo_roles`
   * row as RepoRoles would (with the row it came from); elsewhere the session's. Each flow starts only once `gate`
   * resolves, after `starting` says it was asked to (a flow run late).
   */
  const fencedRoutes = async (options: {
    readonly actor?: Actor.Actor
    readonly repo?: string
    readonly gate?: () => Promise<void>
    readonly starting?: () => void
  } = {}) => {
    const actor = options.actor ?? admin
    const db = await database()
    const scope = Effect.runSync(Scope.make())
    const built = await Effect.runPromise(Scope.provide(FlowHost.build(AdminFlows.registration(db)), scope))
    const flows = Context.get(built.context, FlowRuntime.FlowRuntime)
    const starter = Flows.FlowStarter.of({
      start: (flow: Flow.Any, { executionId, payload }) =>
        Effect.sync(() => options.starting?.()).pipe(
          Effect.andThen(Effect.promise(options.gate ?? (async () => {}))),
          Effect.andThen(flows.execute(flow as never, { executionId, payload: payload as never }) as Effect.Effect<unknown, unknown>),
          Effect.provide(built.context),
          Effect.orDie,
          Effect.asVoid,
        ),
    })
    const roles = Layer.succeed(BranchRoles, BranchRoles.of({
      roleOn: (who) => Effect.succeed(who.role),
      repoRoleOn: (who, repoId) =>
        repoId !== "github/acme/private"
          ? Effect.succeed({ role: who.role, held: Option.none() })
          : Effect.promise(async (): Promise<RepoRoles.Resolved> => {
            const [row] = await sql<{ readonly role: "admin" | "member" | null; readonly checkedAt: string }>`
              SELECT role, checked_at::text AS "checkedAt" FROM github_repo_roles
              WHERE repo_id = ${repoId} AND person_id = ${who.subject.id}`
            return row === undefined
              ? { role: null, held: Option.none() }
              : { role: row.role, held: Option.some({ repoId, personId: who.subject.id, role: row.role, checkedAt: row.checkedAt }) }
          }),
    }))
    const api = await Effect.runPromise(Admin.make(db))
    const handler = HttpEffect.toWebHandler(api.fetch.pipe(
      Effect.provideService(Flows.FlowStarter, starter),
      Effect.provide(signedIn(actor)),
      Effect.provide(roles),
    ))
    const send = async (path: string, method: string, body?: BodyInit) => {
      const response = await handler(new Request(`http://localhost/api/repos/${options.repo ?? "acme/private"}/${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body, duplex: "half" }),
      } as RequestInit))
      return { status: response.status, body: (await response.json().catch(() => null)) as { readonly execution?: string } | null }
    }
    const receipt = async (execution: string) => {
      const response = await handler(new Request(`http://localhost/api/runners/admin-receipts/${encodeURIComponent(execution)}`))
      return { status: response.status, body: await response.json() }
    }
    return { send, receipt, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
  }

  /** The Admin's role on `acme/private` as GitHub gave it, recorded now. */
  const recordRole = (role: "admin" | "member") =>
    sql`INSERT INTO github_repo_roles (repo_id, person_id, role, checked_at) VALUES ('github/acme/private', 'person-admin', ${role}, now())
      ON CONFLICT (repo_id, person_id) DO UPDATE SET role = EXCLUDED.role, checked_at = EXCLUDED.checked_at`

  /** A body that sends its first bytes, says so (`started`), then waits for `finish` to send the rest. */
  const stalledBody = (text: string) => {
    let started = () => {}
    const reading = new Promise<void>((done) => (started = done))
    let finish = () => {}
    const finished = new Promise<void>((done) => (finish = done))
    let sentHead = false
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sentHead) {
          sentHead = true
          controller.enqueue(new TextEncoder().encode(text.slice(0, 5)))
          started()
          return
        }
        await finished
        controller.enqueue(new TextEncoder().encode(text.slice(5)))
        controller.close()
      },
    })
    return { body, reading, finish }
  }

  /** A flow gate: `starting` resolves `asked` when the route starts the flow; the flow runs once `release` is called. */
  const gated = () => {
    let release = () => {}
    const released = new Promise<void>((done) => (release = done))
    let starting = () => {}
    const asked = new Promise<void>((done) => (starting = done))
    return { gate: () => released, starting, asked, release }
  }

  const RUNNER_BODY = JSON.stringify({ tokenSha256: "b".repeat(64), labels: [], capacity: 1 })

  // Astra's reviews of cef761ee and 9e90a48a: the route read the role before the body, and the flows wrote whatever
  // the authority was by then, so a body held open, or a flow run late, wrote after its registrant's role was revoked.
  // Every Admin action now carries one fence (worker/runners/Fence.ts), checked again where it writes.
  describe("the Admin action fence", () => {
    test("a registration whose body arrives after the registrant's repository role was revoked is refused, and writes nothing", async () => {
      await recordInstallation("github/acme/private")
      await recordRole("admin")
      const routes = await fencedRoutes()
      try {
        const stalled = stalledBody(RUNNER_BODY)
        const putting = routes.send("runners/nyc-01", "PUT", stalled.body)
        await stalled.reading
        await recordRole("member")
        stalled.finish()
        expect((await putting).status).toBe(403)
      } finally {
        await routes.close()
      }
      expect(await sql`SELECT count(*)::int AS n FROM runners`).toEqual([{ n: 0 }])
    })

    test("a runner or agent write whose flow runs after the repository role was revoked writes nothing, and says why", async () => {
      await recordInstallation("github/acme/private")
      for (const [path, body] of [
        ["runners/nyc-01", RUNNER_BODY],
        ["agents/coder", JSON.stringify({ labels: [], profile: "p", coding: true })],
      ] as const) {
        await recordRole("admin")
        const flow = gated()
        const routes = await fencedRoutes(flow)
        try {
          const putting = routes.send(path, "PUT", body)
          await flow.asked
          await recordRole("member")
          flow.release()
          const answer = await putting
          expect(answer.status).toBe(202)
          expect(await routes.receipt(answer.body!.execution!)).toMatchObject({
            status: 200,
            body: { outcome: "authorization_expired", op: "put" },
          })
        } finally {
          await routes.close()
        }
      }
      expect(await sql`SELECT (SELECT count(*)::int FROM runners) + (SELECT count(*)::int FROM agents) AS n`).toEqual([{ n: 0 }])
    })

    test("on the deployment's own repository, a sign-in session revoked while the body arrives writes nothing", async () => {
      const person = crypto.randomUUID()
      const session = crypto.randomUUID()
      await sql`INSERT INTO people (id, github_id, github_login) VALUES (${person}::uuid, 4242, 'octo-session')`
      await sql`
        INSERT INTO sessions (id, token_digest, person_id, role, role_checked_at, expires_at)
        VALUES (${session}::uuid, ${`digest-${session}`}, ${person}::uuid, 'admin', now(), now() + interval '1 day')`
      await recordInstallation()
      const routes = await fencedRoutes({
        actor: { subject: { kind: "person", id: person }, role: "admin", session },
        repo: "acme/widgets",
      })
      try {
        const stalled = stalledBody(RUNNER_BODY)
        const putting = routes.send("runners/nyc-01", "PUT", stalled.body)
        await stalled.reading
        await sql`UPDATE sessions SET revoked_at = now(), revoked_reason = 'sign_out' WHERE id = ${session}::uuid`
        stalled.finish()
        const answer = await putting
        expect(answer.status).toBe(202)
        expect((await routes.receipt(answer.body!.execution!)).body).toMatchObject({ outcome: "authorization_expired" })
      } finally {
        await routes.close()
      }
      expect(await sql`SELECT count(*)::int AS n FROM runners`).toEqual([{ n: 0 }])
      await sql`DELETE FROM sessions WHERE id = ${session}::uuid`
      await sql`DELETE FROM people WHERE id = ${person}::uuid`
    })

    test("an action with no fence, started before fences, writes nothing and records authorization_expired", async () => {
      const db = await database()
      const scope = Effect.runSync(Scope.make())
      try {
        const built = await Effect.runPromise(Scope.provide(FlowHost.build(AdminFlows.registration(db)), scope))
        const flows = Context.get(built.context, FlowRuntime.FlowRuntime)
        const payload = { repoId: REPO, name: "legacy", tokenSha256: "c".repeat(64), labels: ["linux"], capacity: 1, actorId: "person-admin" }
        await Effect.runPromise((flows.execute(AdminFlows.AddRunner, { executionId: "admin:legacy", payload }) as Effect.Effect<unknown, unknown>)
          .pipe(Effect.provide(built.context)))
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void))
      }
      expect(await sql`SELECT count(*)::int AS n FROM runners`).toEqual([{ n: 0 }])
      expect(await sql`SELECT kind, name, op, outcome FROM admin_receipts`).toEqual([
        { kind: "runners", name: "legacy", op: "put", outcome: "authorization_expired" },
      ])
    })

    test("an action whose fence expired writes nothing, though the role was granted again since", async () => {
      await recordInstallation("github/acme/private")
      await recordRole("admin")
      const [held] = await sql<{ readonly checkedAt: string }>`SELECT checked_at::text AS "checkedAt" FROM github_repo_roles`
      // Admitted days ago, demoted and granted again since: the role row is fresh and Admin, the fence long expired.
      await recordRole("member")
      await recordRole("admin")
      const change = await query(Store.addRunner(
        { repoId: "github/acme/private", name: "nyc-01", tokenSha256: "d".repeat(64), labels: [], capacity: 1, repoAuthorized: true },
        {
          actorId: "person-admin",
          invocationKey: crypto.randomUUID(),
          fenced: {
            kind: "runners",
            op: "put",
            fence: {
              execution: "runners-put:days-old",
              expiresAt: Date.now() - 3 * 86_400_000,
              generation: 0,
              authority: { _tag: "Repo", held: { repoId: "github/acme/private", personId: "person-admin", role: "admin", checkedAt: held!.checkedAt } },
            },
          },
        },
      ))
      expect(change).toBe("authorization_expired")
      expect(await sql`SELECT count(*)::int AS n FROM runners`).toEqual([{ n: 0 }])
    })

    test("a DELETE admitted before the runner was registered again is superseded, and the runner stays", async () => {
      await recordInstallation("github/acme/private")
      await recordRole("admin")
      const plain = await fencedRoutes()
      const flow = gated()
      const late = await fencedRoutes(flow)
      try {
        expect((await plain.send("runners/nyc-01", "PUT", RUNNER_BODY)).status).toBe(202)
        const deleting = late.send("runners/nyc-01", "DELETE")
        await flow.asked
        // Registered again (a token rotation) while the DELETE waited.
        expect((await plain.send("runners/nyc-01", "PUT", JSON.stringify({ tokenSha256: "e".repeat(64), labels: [], capacity: 1 }))).status)
          .toBe(202)
        flow.release()
        const answer = await deleting
        expect((await late.receipt(answer.body!.execution!)).body).toMatchObject({ outcome: "superseded", op: "delete" })
      } finally {
        await Promise.all([plain.close(), late.close()])
      }
      expect(await sql`SELECT token_sha256 AS sha, removed_at IS NULL AS live FROM runners`).toEqual([{ sha: "e".repeat(64), live: true }])
    })

    /** Holds `key`'s transaction lock in another connection until `release`: a write waits on it. */
    const holdKey = async (key: string) => {
      let release = () => {}
      const released = new Promise<void>((done) => (release = done))
      let locked = () => {}
      const locking = new Promise<void>((done) => (locked = done))
      const holder = query(Effect.flatMap(SqlClient.SqlClient, (client) =>
        client.withTransaction(Effect.gen(function* () {
          yield* client`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
          yield* Effect.sync(locked)
          yield* Effect.promise(() => released)
        }))))
      await locking
      return { release: async () => (release(), await holder) }
    }

    /** A person signed in with an Admin session (and an alias of it on another host), as sign-in records them. */
    const signedInAdmin = async () => {
      const person = crypto.randomUUID()
      const session = crypto.randomUUID()
      const alias = crypto.randomUUID()
      await sql`INSERT INTO people (id, github_id, github_login) VALUES (${person}::uuid, ${Math.floor(Math.random() * 1e9)}, 'octo-fence')`
      await sql`
        INSERT INTO sessions (id, token_digest, person_id, role, role_checked_at, expires_at)
        VALUES (${session}::uuid, ${`digest-${session}`}, ${person}::uuid, 'admin', now(), now() + interval '1 day')`
      await sql`INSERT INTO host_sessions (id, token_digest, parent_id, host) VALUES (${alias}::uuid, ${`alias-${alias}`}, ${session}::uuid, 'pr-1.example')`
      const actor: Actor.Actor = { subject: { kind: "person", id: person }, role: "admin", session, alias }
      return { person, session, alias, actor }
    }

    /** A write's `By` under a fence admitted now, `Local` unless `authority` says otherwise. */
    const fencedBy = (fence: Partial<Fence.Fence> & { readonly execution: string }, kind: "runners" | "agents" = "runners"): Store.By => ({
      actorId: "person-admin",
      invocationKey: crypto.randomUUID(),
      fenced: {
        kind,
        op: "put",
        fence: { expiresAt: Date.now() + 60_000, generation: 0, authority: { _tag: "Local" as const }, ...fence },
      },
    })

    // Astra's review of 29cacd16: the session was read unlocked and before the write's own wait, so a sign-out that
    // committed meanwhile went unseen; and an alias session's end didn't end what it admitted.
    test("a session, or its alias, ended while the write waits on its resource is seen, and writes nothing", async () => {
      await recordInstallation()
      for (const end of ["session", "alias"] as const) {
        const who = await signedInAdmin()
        const routes = await fencedRoutes({ actor: who.actor, repo: "acme/widgets" })
        const name = `nyc-${end}`
        const held = await holdKey(Store.resourceKey("runners", REPO, name))
        try {
          const putting = routes.send(`runners/${name}`, "PUT", RUNNER_BODY)
          if (end === "session") await sql`UPDATE sessions SET revoked_at = now(), revoked_reason = 'sign_out' WHERE id = ${who.session}::uuid`
          else await sql`UPDATE host_sessions SET revoked_at = now() WHERE id = ${who.alias}::uuid`
          await held.release()
          const answer = await putting
          expect((await routes.receipt(answer.body!.execution!)).body).toMatchObject({ outcome: "authorization_expired" })
        } finally {
          await routes.close()
        }
      }
      expect(await sql`SELECT count(*)::int AS n FROM runners`).toEqual([{ n: 0 }])
    })

    // Astra's review of 29cacd16: two first registrations of one name were both admitted against generation 0, and the
    // later overwrote the first.
    test("two registrations of a new name admitted at once: one writes, the other is superseded", async () => {
      await recordInstallation("github/acme/private")
      await recordRole("admin")
      const first = gated()
      const second = gated()
      const a = await fencedRoutes(first)
      const b = await fencedRoutes(second)
      try {
        const putA = a.send("runners/nyc-01", "PUT", JSON.stringify({ tokenSha256: "a".repeat(64), labels: [], capacity: 1 }))
        const putB = b.send("runners/nyc-01", "PUT", JSON.stringify({ tokenSha256: "b".repeat(64), labels: [], capacity: 1 }))
        await Promise.all([first.asked, second.asked])
        first.release()
        second.release()
        const outcomes = await Promise.all([putA, putB].map(async (putting, n) =>
          ((await (n === 0 ? a : b).receipt((await putting).body!.execution!)).body as { readonly outcome: string }).outcome))
        expect(outcomes.sort()).toEqual(["set", "superseded"])
      } finally {
        await Promise.all([a.close(), b.close()])
      }
      expect(await sql`SELECT count(*)::int AS n FROM runners`).toEqual([{ n: 1 }])
    })

    // Astra's review of 29cacd16: "make A the coding agent" admitted before B was made it cleared B when it ran late,
    // since only A's own generation was compared.
    test("a coding selection admitted before another agent was made the coding agent is superseded", async () => {
      await recordInstallation("github/acme/private")
      await recordRole("admin")
      const plain = await fencedRoutes()
      expect((await plain.send("agents/alpha", "PUT", JSON.stringify({ labels: [], profile: "p" }))).status).toBe(202)
      const flow = gated()
      const late = await fencedRoutes(flow)
      try {
        const selecting = late.send("agents/alpha", "PUT", JSON.stringify({ labels: [], profile: "p", coding: true }))
        await flow.asked
        expect((await plain.send("agents/beta", "PUT", JSON.stringify({ labels: [], profile: "p", coding: true }))).status).toBe(202)
        flow.release()
        expect((await late.receipt((await selecting).body!.execution!)).body).toMatchObject({ outcome: "superseded" })
      } finally {
        await Promise.all([plain.close(), late.close()])
      }
      expect(await sql`SELECT name FROM agents WHERE coding`).toEqual([{ name: "beta" }])
    })

    // Astra's review of 29cacd16: the expiry was judged before the write waited on its resource, so a write that waited
    // past it still wrote.
    test("a fence that expires while the write waits on its resource writes nothing", async () => {
      const held = await holdKey(Store.resourceKey("runners", REPO, "nyc-waits"))
      const writing = query(Store.addRunner(
        { repoId: REPO, name: "nyc-waits", tokenSha256: "a".repeat(64), labels: [], capacity: 1, repoAuthorized: true },
        fencedBy({ execution: "runners-put:waits", expiresAt: Date.now() + 300 }),
      ))
      await new Promise((done) => setTimeout(done, 600))
      await held.release()
      expect(await writing).toBe("authorization_expired")
      expect(await sql`SELECT count(*)::int AS n FROM runners`).toEqual([{ n: 0 }])
    })

    /** Holds the rows `lock` locks in another connection until `release`: a write that needs them waits. */
    const holdRows = async (lock: (client: SqlClient.SqlClient) => Effect.Effect<unknown, unknown>) => {
      let release = (_abort: boolean) => {}
      const released = new Promise<boolean>((done) => (release = done))
      let locked = () => {}
      const locking = new Promise<void>((done) => (locked = done))
      const holder = query(Effect.flatMap(SqlClient.SqlClient, (client) =>
        client.withTransaction(Effect.gen(function* () {
          yield* lock(client)
          yield* Effect.sync(locked)
          // Aborted, the transaction rolls back: what it wrote was never there.
          if (yield* Effect.promise(() => released)) return yield* Effect.fail("abort")
        })))).catch((error: unknown) => {
          if (error !== "abort" && !String(error).includes("abort")) throw error
        })
      await locking
      return { release: async () => (release(false), await holder), abort: async () => (release(true), await holder) }
    }

    // Astra's review of 6b13eb85: the session's expiry was judged in the statement that locked it, before the write
    // waited on the alias's lock, so a session that expired during that wait still admitted the write.
    test("a session that expires while the write waits on its alias's lock writes nothing", async () => {
      const who = await signedInAdmin()
      await sql`UPDATE sessions SET expires_at = clock_timestamp() + interval '400 milliseconds' WHERE id = ${who.session}::uuid`
      const held = await holdRows((client) => client`SELECT 1 FROM host_sessions WHERE id = ${who.alias}::uuid FOR UPDATE`)
      const writing = query(Store.addRunner(
        { repoId: REPO, name: "nyc-alias-wait", tokenSha256: "a".repeat(64), labels: [], capacity: 1, repoAuthorized: true },
        fencedBy({
          execution: "runners-put:alias-wait",
          authority: { _tag: "Session", personId: who.person, sessionId: who.session, alias: who.alias },
        }),
      ))
      await new Promise((done) => setTimeout(done, 800))
      // Released unchanged: only the clock ended the session.
      await held.release()
      expect(await writing).toBe("authorization_expired")
      expect(await sql`SELECT count(*)::int AS n FROM runners WHERE name = 'nyc-alias-wait'`).toEqual([{ n: 0 }])
    })

    // Astra's review of 6b13eb85: the write checked its authority and expiry, then waited on the runner's own row, which
    // runner activity locks without the resource's advisory lock, and wrote once it got it, the fence long expired.
    test("a fence that expires while the write waits on the runner's row lock writes nothing", async () => {
      for (const op of ["put", "delete"] as const) {
        const name = `nyc-row-${op}`
        const unfenced = { actorId: "person-admin", invocationKey: crypto.randomUUID() }
        const sha = (op === "put" ? "a" : "c").repeat(64)
        const write = { repoId: REPO, name, tokenSha256: sha, labels: [], capacity: 1, repoAuthorized: true }
        expect(await query(Store.addRunner(write, unfenced))).toBe("set")
        const generation = await query(Store.generationOf(Store.resourceKey("runners", REPO, name)))
        const held = await holdRows((client) => client`SELECT 1 FROM runners WHERE name = ${name} FOR UPDATE`)
        const by = fencedBy({ execution: `runners-${op}:row-wait`, expiresAt: Date.now() + 300, generation })
        const writing = op === "put"
          ? query(Store.addRunner({ ...write, tokenSha256: "b".repeat(64) }, by))
          : query(Store.removeRunner({ repoId: REPO, name }, { ...by, fenced: { ...by.fenced!, op: "delete" } }))
        await new Promise((done) => setTimeout(done, 700))
        await held.release()
        expect(await writing).toBe("authorization_expired")
        expect(await sql`SELECT token_sha256 AS sha, removed_at IS NULL AS live FROM runners WHERE name = ${name}`)
          .toEqual([{ sha, live: true }])
      }
    })

    // Astra's review of f7b3de5f and 281a40d4 (route-on 1): a write admitted while its authority held could wait on a
    // lock after admission, past the earliest of the fence's expiry, the session's and the role row's freshness, and
    // still commit. A new resource has no row to lock first: its token's unique index waits on another transaction.
    test("a write whose session ends while its new runner's token waits on another transaction writes nothing", async () => {
      const who = await signedInAdmin()
      await sql`UPDATE sessions SET expires_at = clock_timestamp() + interval '600 milliseconds' WHERE id = ${who.session}::uuid`
      const token = "e".repeat(64)
      const held = await holdRows((client) =>
        client`INSERT INTO runners (repo_id, name, labels, capacity, token_sha256, added_by)
          VALUES (${REPO}, 'nyc-holder', '{}', 1, ${token}, 'person-admin')`)
      const writing = query(Effect.exit(Store.addRunner(
        { repoId: REPO, name: "nyc-token-wait", tokenSha256: token, labels: [], capacity: 1, repoAuthorized: true },
        fencedBy({
          execution: "runners-put:token-wait",
          authority: { _tag: "Session", personId: who.person, sessionId: who.session, alias: who.alias },
        }),
      )))
      await new Promise((done) => setTimeout(done, 1_200))
      // The holder gives the token up (rolls back), after the session ended.
      await held.abort()
      const exit = await writing
      expect(Exit.isSuccess(exit) ? exit.value : "failed").not.toBe("set")
      expect(await sql`SELECT count(*)::int AS n FROM runners WHERE name = 'nyc-token-wait'`).toEqual([{ n: 0 }])
    })

    test("waits after admission that add up past the fence's expiry, each shorter than it, write nothing", async () => {
      const name = "nyc-cumulative"
      const write = { repoId: REPO, name, tokenSha256: "f".repeat(64), labels: [], capacity: 1, repoAuthorized: true }
      expect(await query(Store.addRunner(write, { actorId: "person-admin", invocationKey: crypto.randomUUID() }))).toBe("set")
      const key = Store.resourceKey("runners", REPO, name)
      const generation = await query(Store.generationOf(key))
      const execution = "runners-put:cumulative"
      // Two holders, each released after 700 ms of the write's wait on it: 1.4 s in all, against a 1 s fence.
      const generationRow = await holdRows((client) => client`UPDATE admin_generations SET generation = generation WHERE key = ${key}`)
      const receiptRow = await holdRows((client) =>
        client`INSERT INTO admin_receipts (execution, repo_id, kind, name, op, outcome, actor_id)
          VALUES (${execution}, ${REPO}, 'runners', ${name}, 'put', 'set', 'person-other')`)
      const writing = query(Effect.exit(Store.addRunner(
        { ...write, labels: ["moved"] },
        fencedBy({ execution, expiresAt: Date.now() + 1_000, generation }),
      )))
      await new Promise((done) => setTimeout(done, 700))
      await generationRow.release()
      await new Promise((done) => setTimeout(done, 700))
      await receiptRow.abort()
      const exit = await writing
      expect(Exit.isSuccess(exit) ? exit.value : "failed").not.toBe("set")
      expect(await sql`SELECT labels FROM runners WHERE name = ${name}`).toEqual([{ labels: [] }])
      expect(await sql`SELECT outcome FROM admin_receipts WHERE execution = ${execution}`)
        .not.toEqual([{ outcome: "set" }])
    })

    // Astra's review of 29cacd16: a refusal's receipt committed but its acknowledgement lost, the replay was admitted
    // again, and wrote, once the authority was granted again.
    test("a replay of a refused action answers its recorded refusal, and writes nothing", async () => {
      const write = { repoId: REPO, name: "nyc-replay", tokenSha256: "a".repeat(64), labels: [], capacity: 1, repoAuthorized: true }
      expect(await query(Store.addRunner(write, fencedBy({ execution: "runners-put:replay", expiresAt: Date.now() - 1 }))))
        .toBe("authorization_expired")
      // The same action again, as a replay, now with a fence that would hold.
      expect(await query(Store.addRunner(write, fencedBy({ execution: "runners-put:replay" })))).toBe("authorization_expired")
      expect(await sql`SELECT count(*)::int AS n FROM runners`).toEqual([{ n: 0 }])
    })

    // Astra's review of 29cacd16: an agent's generation lived on its row, so one removed and added again started over,
    // and an action admitted before wrote the new agent.
    test("an action admitted before an agent was removed and added again is superseded", async () => {
      const agentWrite = { repoId: REPO, agent: { ...agent, name: "gamma" }, coding: false }
      expect(await query(Store.setAgent(agentWrite, { actorId: "person-admin", invocationKey: crypto.randomUUID() }))).toBe("set")
      const admitted = await query(Store.generationOf(Store.resourceKey("agents", REPO, "gamma")))
      expect(await query(Store.removeAgent({ repoId: REPO, name: "gamma" }, { actorId: "person-admin", invocationKey: crypto.randomUUID() })))
        .toBe("removed")
      expect(await query(Store.setAgent(agentWrite, { actorId: "person-admin", invocationKey: crypto.randomUUID() }))).toBe("set")
      expect(await query(Store.removeAgent(
        { repoId: REPO, name: "gamma" },
        fencedBy({ execution: "agents-delete:late", generation: admitted, coding: 0 }, "agents"),
      ))).toBe("superseded")
      expect(await sql`SELECT name FROM agents`).toEqual([{ name: "gamma" }])
    })

    test("a receipt is read by the person who started the action, never an agent acting for them", async () => {
      const routes = await fencedRoutes({ actor: { ...admin, act: { kind: "agent", id: "agent-1" } } })
      try {
        expect((await routes.receipt("runners-put:any")).status).toBe(403)
      } finally {
        await routes.close()
      }
    })

    test("a write whose authority still holds is written, and its receipt says so", async () => {
      await recordInstallation("github/acme/private")
      await recordRole("admin")
      const routes = await fencedRoutes()
      try {
        const answer = await routes.send("runners/nyc-01", "PUT", RUNNER_BODY)
        expect(answer.status).toBe(202)
        expect(await routes.receipt(answer.body!.execution!)).toMatchObject({ status: 200, body: { kind: "runners", name: "nyc-01", op: "put", outcome: "set" } })
        expect((await routes.receipt("runners-put:nobody")).status).toBe(404)
      } finally {
        await routes.close()
      }
      expect(await sql`SELECT repo_id AS "repoId", name FROM runners`).toEqual([{ repoId: "github/acme/private", name: "nyc-01" }])
    })
  })

  test("an Admin in person registers a runner and names the coding agent; anyone else is refused", async () => {
    await recordInstallation()
    const asAdmin = await adminRoutes(admin)
    const asMember = await adminRoutes(member)
    const asNobody = await adminRoutes(null)
    const asAgent = await adminRoutes({ ...admin, act: { kind: "agent", id: "agent-1" } })
    try {
      const runner = { tokenSha256: "b".repeat(64), labels: ["linux"], capacity: 4 }
      expect((await asNobody.send("runners/nyc-01", "PUT", runner)).status).toBe(401)
      expect((await asMember.send("runners/nyc-01", "PUT", runner)).status).toBe(403)
      expect((await asAgent.send("runners/nyc-01", "PUT", runner)).status).toBe(403)
      expect((await asAdmin.send("runners/NYC", "PUT", runner)).status).toBe(400)
      expect((await asAdmin.send("runners/nyc-01", "PUT", { ...runner, capacity: 65 })).status).toBe(400)
      expect((await asAdmin.send("runners/nyc-01", "GET")).status).toBe(405)
      expect((await asAdmin.send("agents/coder", "POST")).status).toBe(405)
      expect(await asAdmin.send("runners/nyc-01", "PUT", runner)).toMatchObject({ status: 202, body: { name: "nyc-01" } })
      expect(await sql`SELECT name, labels, capacity, added_by AS "addedBy", repo_authorized_at IS NOT NULL AS authorized FROM runners`).toEqual([
        { name: "nyc-01", labels: ["linux"], capacity: 4, addedBy: "person-admin", authorized: true },
      ])
      expect((await asAdmin.send("agents/smithers", "PUT", { labels: [], profile: "p" })).status).toBe(400)
      expect((await asAdmin.send("agents/coder", "PUT", { labels: [], profile: "p", maxHours: 13 })).status).toBe(400)
      // Production 2026-11-01: a TODO committed in the seconds after the 202 read no agent and took its committer's
      // connection instead. The read says when the write has landed; only an Admin in person reads it.
      expect((await asAdmin.send("agents/coder", "GET")).status).toBe(404)
      expect((await asAdmin.send("agents/coder", "PUT", { labels: ["linux"], profile: "coder-profile", coding: true })).status)
        .toBe(202)
      expect(await query(Store.codingAgent(REPO))).toEqual(Option.some(agent))
      expect(await asAdmin.send("agents/coder", "GET")).toEqual({ status: 200, body: { name: "coder", coding: true } })
      expect((await asMember.send("agents/coder", "GET")).status).toBe(403)
      expect((await asNobody.send("agents/coder", "GET")).status).toBe(401)
      expect((await asAdmin.send("agents/coder", "DELETE")).status).toBe(202)
      expect((await asAdmin.send("runners/nyc-01", "DELETE")).status).toBe(202)
      expect(await query(Store.codingAgent(REPO))).toEqual(Option.none())
      expect(await sql`SELECT count(*)::int AS n FROM runners WHERE removed_at IS NOT NULL`).toEqual([{ n: 1 }])
      expect(Admin.handles("/api/repos/acme/widgets/agents/coder")).toBe(true)
      expect(Admin.handles("/api/repos/acme/widgets/agents")).toBe(false)
      expect(Admin.handles("/api/repos/acme/widgets/agents/%E0")).toBe(false)
    } finally {
      await Promise.all([asAdmin.close(), asMember.close(), asNobody.close(), asAgent.close()])
    }
  })

  // Production b9dca623: the route fell back to the deployment-wide role where Smithers had recorded no installation,
  // so a deployment Admin could register a runner on a private repository they can't read, and claim its jobs once the
  // installation was recorded.
  test("without a recorded installation, a deployment Admin registers no runner, agent or overflow", async () => {
    for (const repo of ["acme/private", "acme/widgets"]) {
      const asAdmin = await adminRoutes(admin, repo)
      try {
        expect(await asAdmin.send("runners/nyc-01", "PUT", { tokenSha256: "b".repeat(64), labels: [], capacity: 1 }))
          .toEqual({ status: 403, body: { code: "forbidden" } })
        expect((await asAdmin.send("agents/coder", "PUT", { labels: [], profile: "p" })).status).toBe(403)
        expect((await asAdmin.send("overflow/cloudflare", "PUT", {})).status).toBe(403)
      } finally {
        await asAdmin.close()
      }
    }
    expect(await sql`SELECT count(*)::int AS n FROM runners`).toEqual([{ n: 0 }])
  })

  test("with a recorded installation, the role must be the one GitHub gives there, never the deployment's", async () => {
    // The harness has no App to ask GitHub, so nobody holds a role on a repository other than the deployment's own.
    await recordInstallation("github/acme/private")
    const asAdmin = await adminRoutes(admin, "acme/private")
    try {
      expect((await asAdmin.send("runners/nyc-01", "PUT", { tokenSha256: "b".repeat(64), labels: [], capacity: 1 })).status)
        .toBe(403)
    } finally {
      await asAdmin.close()
    }
    expect(await sql`SELECT count(*)::int AS n FROM runners`).toEqual([{ n: 0 }])
  })

  // Astra's review of 5fc33348: migration 0089 marked a runner authorized where its repository's installation record was
  // older than its registration, but the old route's role also fell back to the deployment's on `not_found` (a
  // repository outside GITHUB_ALLOWED_REPOSITORIES, say). Migration `0095_runner_reauthorization` trusts no earlier registration.
  test("migration `0095_runner_reauthorization` leaves every runner unauthorized until an Admin registers it again through the route", async () => {
    await recordInstallation()
    const token = await register("legacy")
    const backfilled = await register("backfilled")
    // As 0089's backfill left it: authorized from its registration time.
    await sql`UPDATE runners SET repo_authorized_at = added_at WHERE name = 'backfilled'`
    await Effect.runPromise((await jobs()).start(taskOf(), "todo:legacy#g1"))
    await query(MigrationReauthorization.clearAuthorization)
    expect(await sql`SELECT count(*)::int AS n FROM runners WHERE repo_authorized_at IS NOT NULL`).toEqual([{ n: 0 }])
    const { claim } = await routes()
    expect(await claim(token)).toEqual({ status: 403, body: { code: "not_authorized" } })
    expect(await claim(backfilled)).toEqual({ status: 403, body: { code: "not_authorized" } })
    // Registered again by an Admin through the route, with the same token's SHA-256.
    const asAdmin = await adminRoutes(admin)
    try {
      expect((await asAdmin.send("runners/legacy", "PUT", { tokenSha256: digestSync(token), labels: ["linux", "nyc"], capacity: 2 }))
        .status).toBe(202)
    } finally {
      await asAdmin.close()
    }
    expect((await claim(token)).body).toMatchObject({ job: { key: "todo:legacy#g1" } })
    expect((await claim(backfilled)).status).toBe(403)
  })

  // Astra's review of 4cd69527: a runner holding a job across migration `0095_runner_reauthorization` kept renewing its lease, reading steers,
  // settling and appending transcript, since only claim and reclaim checked it was current.
  test("a runner holding a job heartbeats, settles and sends events only while current: authorized, installed, its token", async () => {
    const outcome = { _tag: "Done", changes: { additions: [], deletions: [] }, summary: "done", usage: {} }
    const cases: ReadonlyArray<readonly [string, () => Promise<unknown>, () => Promise<unknown>]> = [
      ["authorization cleared", () => query(MigrationReauthorization.clearAuthorization), () => sql`UPDATE runners SET repo_authorized_at = now()`],
      ["installation forgotten", () => sql`UPDATE github_repositories SET installation_id = NULL`, () => recordInstallation()],
    ]
    for (const [, end, restore] of cases) {
      await sql`TRUNCATE agent_jobs, runners, runner_changes RESTART IDENTITY CASCADE`
      const token = await register("nyc-01")
      const key = `todo:held-${crypto.randomUUID()}#g1`
      await Effect.runPromise((await jobs()).start(taskOf({ context: { attemptId: crypto.randomUUID() } }), key))
      const { call, claim } = await routes()
      const job = (await claim(token)).body.job!
      const [before] = await sql<{ readonly lease: string }>`SELECT lease_until::text AS lease FROM agent_jobs`
      await end()
      expect(await call("heartbeat", token, { key: job.key, claim: job.claim })).toEqual({ status: 403, body: { code: "not_authorized" } })
      const event: Transcript.Event = {
        seq: 0,
        at: Date.now(),
        kind: "agent_message_chunk",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
      }
      expect(await call("events", token, { key: job.key, claim: job.claim, events: [event] }))
        .toEqual({ status: 403, body: { code: "not_authorized" } })
      expect(await call("settle", token, { key: job.key, claim: job.claim, outcome })).toEqual({ status: 403, body: { code: "not_authorized" } })
      expect(await sql`SELECT status, lease_until::text AS lease, transcript_events AS events FROM agent_jobs`)
        .toEqual([{ status: "claimed", lease: before!.lease, events: null }])
      // Current again: the same job goes on.
      await restore()
      expect((await call<{ readonly held: boolean }>("heartbeat", token, { key: job.key, claim: job.claim })).body.held).toBe(true)
      expect((await call("settle", token, { key: job.key, claim: job.claim, outcome })).body).toEqual({ recorded: true })
    }
    // The token rotated after the request authenticated, before the settlement: a transaction holds the runner's row
    // with the new token while the request's mark of the runner seen waits for it.
    await sql`TRUNCATE agent_jobs, runners, runner_changes RESTART IDENTITY CASCADE`
    const token = await register("nyc-01")
    await Effect.runPromise((await jobs()).start(taskOf(), "todo:rotated#g1"))
    const { call, claim } = await routes()
    const job = (await claim(token)).body.job!
    for (const route of ["heartbeat", "settle"] as const) {
      await sql`UPDATE runners SET seen_at = now() - interval '1 hour', token_sha256 = ${digestSync(token)}`
      let commit = () => {}
      const committed = new Promise<void>((done) => (commit = done))
      let rotated = () => {}
      const rotating = new Promise<void>((done) => (rotated = done))
      const locker = query(Effect.flatMap(SqlClient.SqlClient, (client) =>
        client.withTransaction(Effect.gen(function* () {
          yield* client`UPDATE runners SET token_sha256 = ${digestSync("rotated")} WHERE name = 'nyc-01'`
          yield* Effect.sync(rotated)
          yield* Effect.promise(() => committed)
        }))))
      await rotating
      const asked = call(route, token, route === "settle" ? { key: job.key, claim: job.claim, outcome } : { key: job.key, claim: job.claim })
      await new Promise((done) => setTimeout(done, 500))
      commit()
      await locker
      expect(await asked).toEqual({ status: 403, body: { code: "not_authorized" } })
    }
    expect(await sql`SELECT status FROM agent_jobs`).toEqual([{ status: "claimed" }])
  })

  // Astra's review of f42f8b6b: the check sat in a statement that locked no runner or installation row, so a
  // revocation that committed while the operation waited went unseen.
  test("a revocation that commits while the acting operation waits on it is seen: refused, nothing written", async () => {
    const outcome = { _tag: "Done", changes: { additions: [], deletions: [] }, summary: "done", usage: {} }
    const revocations = [
      ["authorization cleared", `UPDATE runners SET repo_authorized_at = NULL`],
      ["installation forgotten", `UPDATE github_repositories SET installation_id = NULL`],
    ] as const
    for (const route of ["heartbeat", "settle", "events"] as const) {
      for (const [, revoke] of revocations) {
        await sql`TRUNCATE agent_jobs, runners, runner_changes RESTART IDENTITY CASCADE`
        const token = await register("nyc-01")
        const key = `todo:fence-${crypto.randomUUID()}#g1`
        await Effect.runPromise((await jobs()).start(taskOf({ context: { attemptId: crypto.randomUUID() } }), key))
        const { call, claim } = await routes()
        const job = (await claim(token)).body.job!
        const [before] = await sql<{ readonly lease: string }>`SELECT lease_until::text AS lease FROM agent_jobs`
        // The revocation holds its row, uncommitted, while the operation (its runner seen moments ago, so its request
        // authenticates without waiting) reaches its own check.
        let commit = () => {}
        const committed = new Promise<void>((done) => (commit = done))
        let held = () => {}
        const holding = new Promise<void>((done) => (held = done))
        const revoker = query(Effect.flatMap(SqlClient.SqlClient, (client) =>
          client.withTransaction(Effect.gen(function* () {
            yield* client.unsafe(revoke)
            yield* Effect.sync(held)
            yield* Effect.promise(() => committed)
          }))))
        await holding
        const event: Transcript.Event = {
          seq: 0,
          at: Date.now(),
          kind: "agent_message_chunk",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
        }
        const body = route === "settle"
          ? { key: job.key, claim: job.claim, outcome }
          : route === "events"
          ? { key: job.key, claim: job.claim, events: [event] }
          : { key: job.key, claim: job.claim }
        const acting = call(route, token, body)
        await new Promise((done) => setTimeout(done, 500))
        commit()
        await revoker
        expect([route, await acting]).toEqual([route, { status: 403, body: { code: "not_authorized" } }])
        expect(await sql`SELECT status, lease_until::text AS lease, transcript_events AS events FROM agent_jobs`)
          .toEqual([{ status: "claimed", lease: before!.lease, events: null }])
      }
    }
  })

  // Astra's review of 99f0dc17: only the job store's probe ended a claimed job past its hours, so with the probe
  // stalled, a runner that gave up settling locally got the same overdue claim back for good, and it filled its slot.
  test("a claim ends the runner's overdue claims itself, without the probe, and frees its capacity", async () => {
    const token = await register("nyc-01", ["linux", "nyc"], 1)
    const store = await jobs()
    await Effect.runPromise(store.start(taskOf(), "todo:overdue#g1"))
    const { claim } = await routes()
    expect((await claim(token)).body.job?.key).toBe("todo:overdue#g1")
    // Past its deadline and the grace to settle it; nothing probed it.
    await sql`UPDATE agent_jobs SET deadline_at = now() - interval '6 minutes' WHERE key = 'todo:overdue#g1'`
    await Effect.runPromise(store.start(taskOf(), "todo:next#g1"))
    expect((await claim(token)).body.job).toMatchObject({ key: "todo:next#g1", reclaimed: false })
    expect(await sql`SELECT key, status, outcome->>'reason' AS reason FROM agent_jobs ORDER BY key`).toEqual([
      { key: "todo:next#g1", status: "claimed", reason: null },
      { key: "todo:overdue#g1", status: "failed", reason: "timeout" },
    ])
  })

  // Astra's review of 99f0dc17: the heartbeat refused a runner no longer current before reading a Stop, so a suspended
  // job could not be stopped while the refusal lasted, and held its slot to its deadline.
  test("a Stop reaches a runner no longer current through its own claim's heartbeat, and the host ends the job", async () => {
    const token = await register("nyc-01")
    const store = await jobs()
    await Effect.runPromise(store.start(taskOf(), "todo:stopped#g1"))
    const { call, claim } = await routes()
    const job = (await claim(token)).body.job!
    await query(MigrationReauthorization.clearAuthorization)
    expect(await call("heartbeat", token, { key: job.key, claim: job.claim })).toEqual({ status: 403, body: { code: "not_authorized" } })
    await Effect.runPromise(store.cancel(job.key))
    // Another claim id of the same job is no one's: refused, nothing more.
    expect(await call("heartbeat", token, { key: job.key, claim: crypto.randomUUID() }))
      .toEqual({ status: 403, body: { code: "not_authorized" } })
    // The answer is lost on its way after the host committed: the runner beats again with the same claim, and hears
    // it again (Astra's review of 5ac18ab4), and still nothing else.
    for (let n = 0; n < 2; n++) {
      expect(await call("heartbeat", token, { key: job.key, claim: job.claim }))
        .toEqual({ status: 403, body: { code: "not_authorized", cancel: true } })
    }
    expect(await call("heartbeat", token, { key: job.key, claim: crypto.randomUUID() }))
      .toEqual({ status: 403, body: { code: "not_authorized" } })
    expect(await sql`SELECT status, outcome, lease_until AS lease FROM agent_jobs`).toEqual([
      { status: "cancelled", outcome: { _tag: "Cancelled", processTreeGone: false }, lease: null },
    ])
  })

  // Astra's review of cef761ee: a runner whose token was rotated, or that was retired, got 401 before the Stop path,
  // so its suspended job held its slot to the deadline.
  test("a Stop reaches a runner whose token was rotated, or that was retired, on its own claim's heartbeat, and nothing else", async () => {
    for (const revoke of [`UPDATE runners SET token_sha256 = '${"e".repeat(64)}'`, `UPDATE runners SET removed_at = now()`]) {
      await sql`TRUNCATE agent_jobs, runners, runner_changes RESTART IDENTITY CASCADE`
      const token = await register("nyc-01")
      const store = await jobs()
      await Effect.runPromise(store.start(taskOf(), "todo:past#g1"))
      const { call, claim } = await routes()
      const job = (await claim(token)).body.job!
      await query(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(revoke)))
      // No Stop yet: nobody, as before.
      expect(await call("heartbeat", token, { key: job.key, claim: job.claim })).toEqual({ status: 401, body: { code: "authentication" } })
      await Effect.runPromise(store.cancel(job.key))
      // Another claim id, or another route, hears nothing.
      expect(await call("heartbeat", token, { key: job.key, claim: crypto.randomUUID() }))
        .toEqual({ status: 401, body: { code: "authentication" } })
      expect((await call("settle", token, { key: job.key, claim: job.claim, outcome: { _tag: "Cancelled", processTreeGone: true } })).status)
        .toBe(401)
      for (let n = 0; n < 2; n++) {
        expect(await call("heartbeat", token, { key: job.key, claim: job.claim }))
          .toEqual({ status: 401, body: { code: "authentication", cancel: true } })
      }
      expect(await sql`SELECT status, outcome, lease_until AS lease FROM agent_jobs`).toEqual([
        { status: "cancelled", outcome: { _tag: "Cancelled", processTreeGone: false }, lease: null },
      ])
    }
  })

  // Astra's review of ad7d1be9: a job claimed before the deploy had no claiming token's digest, so a Stop never reached
  // its runner once its token was rotated. The migration backfills it, and a heartbeat sets one still missing.
  test("a job claimed before the deploy hears a Stop after a rotation: backfilled by the migration, or set by a heartbeat", async () => {
    for (const how of ["migration", "heartbeat"] as const) {
      await sql`TRUNCATE agent_jobs, runners, runner_changes RESTART IDENTITY CASCADE`
      const token = await register("nyc-01")
      const store = await jobs()
      await Effect.runPromise(store.start(taskOf(), "todo:upgraded#g1"))
      const { call, claim } = await routes()
      const job = (await claim(token)).body.job!
      // As it stood before the deploy.
      await sql`UPDATE agent_jobs SET claimed_token_sha256 = NULL`
      if (how === "migration") await query(MigrationReauthorization.backfillClaimedTokens)
      else expect((await call<{ readonly held: boolean }>("heartbeat", token, { key: job.key, claim: job.claim })).body.held).toBe(true)
      expect(await sql`SELECT claimed_token_sha256 AS sha FROM agent_jobs`).toEqual([{ sha: digestSync(token) }])
      await sql`UPDATE runners SET token_sha256 = ${"e".repeat(64)}`
      await Effect.runPromise(store.cancel(job.key))
      expect(await call("heartbeat", token, { key: job.key, claim: job.claim }))
        .toEqual({ status: 401, body: { code: "authentication", cancel: true } })
    }
  })

  // Astra's review of 4cd69527: the migration took its locks with no bound, so a long reader of `agent_jobs` would queue
  // the runner routes behind it. It fails within its lock timeout, rewrites no runner already clear, and puts the
  // transaction's timeouts back for the migrations after it.
  test("migration `0095_runner_reauthorization` fails fast behind a held reader, rewrites no row already clear, and restores the timeouts", async () => {
    await recordInstallation()
    await register("authorized")
    await register("clear")
    await sql`UPDATE runners SET repo_authorized_at = NULL WHERE name = 'clear'`
    const [clear] = await sql<{ readonly xmin: string }>`SELECT xmin::text FROM runners WHERE name = 'clear'`
    const db = await database()
    const run = Effect.flatMap(SqlClient.SqlClient, (client) =>
      client.withTransaction(Effect.gen(function* () {
        const [before] = yield* client<{ readonly lock: string }>`SELECT current_setting('lock_timeout') AS lock`
        yield* MigrationReauthorization.migration
        const [after] = yield* client<{ readonly lock: string }>`SELECT current_setting('lock_timeout') AS lock`
        return [before!.lock, after!.lock]
      }))).pipe(Effect.provide(db))
    // A reader holding `agent_jobs` for longer than the migration may wait.
    let release = () => {}
    const released = new Promise<void>((done) => (release = done))
    let reading = () => {}
    const read = new Promise<void>((done) => (reading = done))
    const reader = query(Effect.flatMap(SqlClient.SqlClient, (client) =>
      client.withTransaction(Effect.gen(function* () {
        yield* client`SELECT count(*) FROM agent_jobs`
        yield* Effect.sync(reading)
        yield* Effect.promise(() => released)
      }))))
    await read
    const startedAt = Date.now()
    const blocked = await Effect.runPromise(Effect.exit(run))
    expect(Exit.isFailure(blocked)).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(15_000)
    release()
    await reader
    // Nothing held: it runs, and leaves the transaction's timeouts as it found them.
    const [before, after] = await Effect.runPromise(run)
    expect(after).toBe(before)
    expect(await sql`SELECT name FROM runners WHERE repo_authorized_at IS NOT NULL`).toEqual([])
    expect(await sql`SELECT xmin::text FROM runners WHERE name = 'clear'`).toEqual([clear])
  }, 60_000)

  // Astra's review of 5fc33348: an `admin/AddRunner` admitted by the old route's fallback, whose write resumes after a
  // deploy, was stamped authorized whatever admitted it.
  // A fenced registration that doesn't say the route took the repository's Admin role (`repoAuthorized`) registers its
  // runner unauthorized. One with no fence at all is refused outright (the Admin action fence's own test).
  test("an admin/AddRunner that doesn't say the route proved the repository's Admin role registers its runner unauthorized", async () => {
    await recordInstallation()
    const db = await database()
    const scope = Effect.runSync(Scope.make())
    try {
      const built = await Effect.runPromise(Scope.provide(FlowHost.build(AdminFlows.registration(db)), scope))
      const flows = Context.get(built.context, FlowRuntime.FlowRuntime)
      const token = "token-pending-legacy"
      const payload = {
        repoId: REPO,
        name: "pending",
        tokenSha256: digestSync(token),
        labels: ["linux"],
        capacity: 1,
        actorId: "person-admin",
        fence: { execution: "runners-put:pending", expiresAt: Date.now() + 60_000, generation: 0, authority: { _tag: "Local" as const } },
      }
      await Effect.runPromise((flows.execute(AdminFlows.AddRunner, { executionId: "admin:legacy", payload }) as Effect.Effect<unknown, unknown>)
        .pipe(Effect.provide(built.context)))
      expect(await sql`SELECT name, repo_authorized_at IS NOT NULL AS authorized FROM runners`).toEqual([
        { name: "pending", authorized: false },
      ])
      const { claim } = await routes()
      expect(await claim(token)).toEqual({ status: 403, body: { code: "not_authorized" } })
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  })

  test("a runner on a repository with no recorded installation claims none of its jobs", async () => {
    const token = await register("nyc-01")
    await sql`DELETE FROM github_repositories`
    await Effect.runPromise((await jobs()).start(taskOf(), "todo:uninstalled#g1"))
    const { claim } = await routes()
    expect((await claim(token)).body).toEqual({ job: null })
    await recordInstallation()
    expect((await claim(token)).body.job?.key).toBe("todo:uninstalled#g1")
  })

  // Astra's review of 5fc33348: a claim with `running: []` handed back a held job by its runner id alone, though a new
  // claim checks the token, the authorization and the recorded installation.
  test("a runner reclaims a held job only while its token, its authorization and the repository's installation hold", async () => {
    const token = await register("nyc-01")
    await Effect.runPromise((await jobs()).start(taskOf(), "todo:held#g1"))
    const { claim } = await routes()
    expect((await claim(token)).body.job?.reclaimed).toBe(false)
    expect((await claim(token)).body.job?.reclaimed).toBe(true)
    // The installation forgotten.
    await sql`UPDATE github_repositories SET installation_id = NULL`
    expect((await claim(token)).body).toEqual({ job: null })
    await recordInstallation()
    expect((await claim(token)).body.job?.reclaimed).toBe(true)
    // The token rotated after the request authenticated, before it reclaimed: a transaction holds the runner's row with
    // the new token while the request's mark of the runner seen waits for it.
    await sql`UPDATE runners SET seen_at = now() - interval '1 hour'`
    let commit = () => {}
    const committed = new Promise<void>((done) => (commit = done))
    let rotated = () => {}
    const rotating = new Promise<void>((done) => (rotated = done))
    const locker = query(Effect.flatMap(SqlClient.SqlClient, (client) =>
      client.withTransaction(Effect.gen(function* () {
        yield* client`UPDATE runners SET token_sha256 = ${digestSync("rotated")} WHERE name = 'nyc-01'`
        yield* Effect.sync(rotated)
        yield* Effect.promise(() => committed)
      }))))
    await rotating
    const reclaiming = claim(token)
    await new Promise((done) => setTimeout(done, 500))
    commit()
    await locker
    expect((await reclaiming).body).toEqual({ job: null })
    expect((await claim(token)).status).toBe(401)
  })
})

/** The typed failure an exit ended with, if any. */
const failure = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit) ? (exit.cause.reasons.find((reason) => reason._tag === "Fail") as { error: unknown } | undefined)?.error : undefined

/** A database that is down: every operation over it fails. */
const down = Layer.effect(SqlClient.SqlClient, Effect.fail(new Error("database down")))

describe("unhappy paths, through a database that is down or a starter that refuses", () => {
  test("the job store fails AgentJobsUnavailable, an infra fault the engine retries, for every operation", async () => {
    const store = Jobs.make(down)
    for (const operation of [store.start(taskOf(), "todo:d#g1"), store.status("todo:d#g1"), store.cancel("todo:d#g1")]) {
      const exit = await Effect.runPromise(Effect.exit(operation))
      expect(exit).toEqual(Exit.fail(new AgentRunner.AgentJobsUnavailable()))
    }
    expect(Fault.of(new AgentRunner.AgentJobsUnavailable()).class).toBe("infra")
  })

  test("todo/Agent fails CodingUnavailable, and the runner routes answer 503", async () => {
    expect(failure(await Effect.runPromise(Effect.exit(TodoSession.agentStep(down)({ attemptId: "a", repoId: REPO })))))
      .toEqual(new TodoSession.CodingUnavailable())
    const handler = HttpEffect.toWebHandler(RunnersApi.make(down, { runOf: TodoSession.runOf }).fetch.pipe(Effect.provide(RunContentTest.transcripts().layer)))
    const response = await handler(new Request(`http://localhost${AgentRunner.ROUTES.claim}`, {
      method: "POST",
      headers: { authorization: "Bearer some-token" },
      body: "{}",
    }))
    expect([response.status, await response.json()]).toEqual([503, { code: "unavailable" }])
  })

  test("a runner's body past the routes' limit is refused 413, and one that isn't UTF-8 or a heartbeat 400", async () => {
    const token = await register("nyc-01")
    const { call, handler } = await routes()
    expect((await call("settle", token, "x".repeat(2 * 1024 * 1024 + 1))).status).toBe(413)
    expect((await call("heartbeat", token, { key: "" })).status).toBe(400)
    const notUtf8 = await handler(new Request(`http://localhost${AgentRunner.ROUTES.claim}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: new Uint8Array([0xff, 0xfe, 0xfd]),
    }))
    expect(notUtf8.status).toBe(400)
  })

  test("an Admin step fails StoreUnavailable over a database that is down, and dies without an invocation key", async () => {
    const action = { kind: "agents", op: "put" } as const
    const payload = {
      repoId: REPO,
      actorId: "person-admin",
      fence: { execution: "agents-put:down", expiresAt: Date.now() + 60_000, generation: 0, authority: { _tag: "Local" as const } },
    }
    const step = AdminFlows.step("admin/SetAgent", down, (p: typeof payload) => p.repoId, action, () => Effect.die("unused"))
    expect(failure(await Effect.runPromise(Effect.exit(step(payload).pipe(Effect.provideService(Action.CurrentInvocationKey, "k"))))))
      .toEqual(new AdminFlows.StoreUnavailable())
    const failing = AdminFlows.step("admin/SetAgent", await database(), (p: typeof payload) => p.repoId, action, () => Effect.fail("down"))
    expect(failure(await Effect.runPromise(Effect.exit(failing(payload).pipe(Effect.provideService(Action.CurrentInvocationKey, "k"))))))
      .toEqual(new AdminFlows.StoreUnavailable())
    const exit = await Effect.runPromise(Effect.exit(failing(payload)))
    expect(Exit.isFailure(exit) && exit.cause.reasons.some((reason) => reason._tag === "Die")).toBe(true)
  })

  test("each Admin write again under its invocation key changes nothing", async () => {
    const again = by()
    await query(Store.addRunner({ repoId: REPO, name: "nyc-01", tokenSha256: "c".repeat(64), labels: [], capacity: 1, repoAuthorized: true }, by()))
    expect(await query(Store.removeRunner({ repoId: REPO, name: "nyc-01" }, again))).toBe("removed")
    expect(await query(Store.removeRunner({ repoId: REPO, name: "nyc-01" }, again))).toBe("repeat")
    const set = by()
    expect(await query(Store.setAgent({ repoId: REPO, agent, coding: false }, set))).toBe("set")
    expect(await query(Store.setAgent({ repoId: REPO, agent, coding: true }, set))).toBe("repeat")
    expect(await query(Store.codingAgent(REPO))).toEqual(Option.none())
    const remove = by()
    expect(await query(Store.removeAgent({ repoId: REPO, name: "coder" }, remove))).toBe("removed")
    expect(await query(Store.removeAgent({ repoId: REPO, name: "coder" }, remove))).toBe("repeat")
  })

  test("an Admin route answers 503 when its flow can't start or who is asking can't be read", async () => {
    await recordInstallation()
    const db = await database()
    const api = await Effect.runPromise(Admin.make(db))
    const refusing = Flows.FlowStarter.of({ start: () => Effect.fail(new Flows.StartUnavailable({ errorCode: "down" })) })
    const as = (sessions: Layer.Layer<Actor.Sessions>) =>
      HttpEffect.toWebHandler(api.fetch.pipe(
        Effect.provideService(Flows.FlowStarter, refusing),
        Effect.provide(sessions),
        Effect.provide(branchRoles(db, "acme/widgets")),
      ))
    const send = (handler: ReturnType<typeof as>, path: string, method: string, body?: unknown) =>
      handler(new Request(`http://localhost/api/repos/acme/widgets/${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })).then((response) => response.status)
    const asAdmin = as(signedIn(admin))
    expect(await send(asAdmin, "runners/nyc-01", "DELETE")).toBe(503)
    expect(await send(asAdmin, "runners/nyc-01", "PUT", { tokenSha256: "d".repeat(64), labels: [], capacity: 1 })).toBe(503)
    expect(await send(asAdmin, "agents/coder", "PUT", { labels: [], profile: "p" })).toBe(503)
    expect(await send(asAdmin, "agents/coder", "PUT", "x".repeat(9 * 1024))).toBe(413)
    expect(await send(asAdmin, "agents/coder", "PUT", "{")).toBe(400)
    const notUtf8 = await asAdmin(new Request("http://localhost/api/repos/acme/widgets/agents/coder", {
      method: "PUT",
      body: new Uint8Array([0xff, 0xfe, 0xfd]),
    }))
    expect(notUtf8.status).toBe(400)
    const broken = Layer.succeed(Actor.Sessions, Actor.Sessions.of({ resolve: Effect.die(new Error("sessions")) }))
    expect(await send(as(broken), "agents/coder", "DELETE")).toBe(503)
  })
})
