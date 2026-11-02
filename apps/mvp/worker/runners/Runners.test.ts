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
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as Actor from "../Actor.ts"
import * as TodoSession from "../flows/TodoSession.ts"
import * as ExecutionHost from "../ExecutionHost.ts"
import * as Flows from "../Flows.ts"
import * as FlowHost from "../test/flowHost.ts"
import * as RunContentTest from "../test/runContent.ts"
import { branchRoles, signedIn, signedOut, testFile } from "../test/harness.ts"
import * as Admin from "./Admin.ts"
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
    sql`TRUNCATE agent_jobs, runners, runner_changes, agents, agent_changes RESTART IDENTITY CASCADE`)))

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

let invocations = 0
const by = (): Store.By => ({ actorId: "person-admin", invocationKey: `test-${++invocations}` })

/** Registers runner `name` and answers its token. */
const register = async (name: string, labels: ReadonlyArray<string> = ["linux", "nyc"], capacity = 2) => {
  const token = `token-${name}-${crypto.randomUUID()}`
  await query(Store.addRunner({ repoId: REPO, name, tokenSha256: digestSync(token), labels, capacity }, by()))
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
    const write = { repoId: REPO, name: "nyc-01", tokenSha256: "a".repeat(64), labels: ["linux"], capacity: 4 }
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
  const adminRoutes = async (actor: Actor.Actor | null) => {
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
      const response = await handler(new Request(`http://localhost/api/repos/acme/widgets/${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }))
      return { status: response.status, body: await response.json().catch(() => null) }
    }
    return { send, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
  }

  test("an Admin in person registers a runner and names the coding agent; anyone else is refused", async () => {
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
      expect(await asAdmin.send("runners/nyc-01", "PUT", runner)).toEqual({ status: 202, body: { name: "nyc-01" } })
      expect(await sql`SELECT name, labels, capacity, added_by AS "addedBy" FROM runners`).toEqual([
        { name: "nyc-01", labels: ["linux"], capacity: 4, addedBy: "person-admin" },
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
    const step = AdminFlows.step("admin/SetAgent", down, (p: { readonly repoId: string; readonly actorId: string }) => p.repoId, () => Effect.die("unused"))
    const payload = { repoId: REPO, actorId: "person-admin" }
    expect(failure(await Effect.runPromise(Effect.exit(step(payload).pipe(Effect.provideService(Action.CurrentInvocationKey, "k"))))))
      .toEqual(new AdminFlows.StoreUnavailable())
    const failing = AdminFlows.step("admin/SetAgent", await database(), (p: typeof payload) => p.repoId, () => Effect.fail("down"))
    expect(failure(await Effect.runPromise(Effect.exit(failing(payload).pipe(Effect.provideService(Action.CurrentInvocationKey, "k"))))))
      .toEqual(new AdminFlows.StoreUnavailable())
    const exit = await Effect.runPromise(Effect.exit(failing(payload)))
    expect(Exit.isFailure(exit) && exit.cause.reasons.some((reason) => reason._tag === "Die")).toBe(true)
  })

  test("each Admin write again under its invocation key changes nothing", async () => {
    const again = by()
    await query(Store.addRunner({ repoId: REPO, name: "nyc-01", tokenSha256: "c".repeat(64), labels: [], capacity: 1 }, by()))
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
