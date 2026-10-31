// External agents on runners (decision 0136) against the compose Postgres, on this file's own schema: the Admin
// routes and flows, the job store an `ExternalAgent` step drives, and the routes a runner pulls its jobs through. The
// flows run for real on the Node host's durable engine (worker/test/flowHost.ts). Nothing is scripted but who is signed
// in.
import { AgentRunner } from "@smthrs/agent"
import { digestSync } from "@smthrs/crypto"
import { Action, Fault, type Flow, FlowRuntime } from "@smthrs/flow"
import { Context, Effect, Exit, Layer, Option, Scope } from "effect"
import { HttpEffect } from "effect/http"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as Actor from "../Actor.ts"
import * as TodoSession from "../flows/TodoSession.ts"
import * as Flows from "../Flows.ts"
import * as FlowHost from "../test/flowHost.ts"
import { branchRoles, signedIn, signedOut, testFile } from "../test/harness.ts"
import * as Admin from "./Admin.ts"
import * as AdminFlows from "./AdminFlows.ts"
import * as RunnersApi from "./Api.ts"
import * as Jobs from "./Jobs.ts"
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

/** The runner routes over this file's schema, a claim asking again every 50 ms. */
const routes = async (onClaimed?: (task: AgentRunner.Task) => Effect.Effect<void, unknown>) => {
  const handler = HttpEffect.toWebHandler(
    RunnersApi.make(await database(), { pollMillis: 50, ...(onClaimed === undefined ? {} : { onClaimed }) }).fetch,
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
    expect(RunnersApi.handles("/api/runners")).toBe(false)
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
      expect(await asAdmin.send("runners/nyc-01", "PUT", runner)).toEqual({ status: 202, body: { name: "nyc-01" } })
      expect(await sql`SELECT name, labels, capacity, added_by AS "addedBy" FROM runners`).toEqual([
        { name: "nyc-01", labels: ["linux"], capacity: 4, addedBy: "person-admin" },
      ])
      expect((await asAdmin.send("agents/smithers", "PUT", { labels: [], profile: "p" })).status).toBe(400)
      expect((await asAdmin.send("agents/coder", "PUT", { labels: [], profile: "p", maxHours: 13 })).status).toBe(400)
      expect((await asAdmin.send("agents/coder", "PUT", { labels: ["linux"], profile: "coder-profile", coding: true })).status)
        .toBe(202)
      expect(await query(Store.codingAgent(REPO))).toEqual(Option.some(agent))
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
    const handler = HttpEffect.toWebHandler(RunnersApi.make(down).fetch)
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
