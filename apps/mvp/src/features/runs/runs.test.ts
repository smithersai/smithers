import { FlowRuntime } from "@smthrs/flow"
import { EngineStore } from "@smthrs/flows"
import * as RunSteps from "./steps"
import { InspectionJournal } from "@smthrs/gateway"
// The acts on runs and the run reads (src/features/runs, decision 0014 §2 and §6, docs/features/runs.md#acts), on this
// device's engine as the browser's engine worker registers them, over the compose Postgres, against ChatApi's real
// handler. A person's flow is the run they act on; the model is the only scripted seam.
import { Cause, Deferred, Effect, Exit, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { tracked } from "../../../worker/test/branch.ts"
import { contents, stop, testFile, usage } from "../../../worker/test/harness.ts"
import { answerRow, cell, member, openAgent } from "../../test/agent"
import { FlowNew, FlowRun, FlowSave } from "../flows-ui/flows"
import { roundExecutionId } from "../flows-ui/round"
import { listed, retriedRunId, retryActId, runPath, settled } from "./contract"
import { retryable } from "./retry"
import { Cancel, Inspect, List, Resume, Retry, RetryFrom } from "./flows"
import { versioned } from "./steps"

const runtime = testFile("runs_acts")

beforeEach(() =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE flow_drafts, flow_revisions, flows CASCADE`))
)

/** A run of the agent takes several sealed model steps; under a loaded machine one test may take a minute. */
const SLOW = 240_000

type Request = Parameters<Parameters<typeof openAgent>[1]>[0]

const said = (request: Request) => [...request.system.map((part) => part.text), ...contents(request)].join("\n")
const answer = (source: string) => Stream.make({ type: "text-delta" as const, id: "t", text: cell(source) }, usage, stop)

const drafted = {
  description: "Say hello.",
  instructions: "Say hello.",
  flows: [],
  questions: [],
  summary: "Says hello.",
}

/**
 * A model that drafts a flow that says hello, and runs it: `stall` running calls wait forever (a run that is live),
 * and the rest answer.
 */
const model = (stall = 0) => {
  const running: Array<Request> = []
  const script = (request: Request) => {
    const text = said(request)
    if (text.includes("You draft a person's own flow")) return answer(`ctx.done(${JSON.stringify(drafted)})`)
    if (text.includes("You run one of the person's own flows")) {
      running.push(request)
      return running.length <= stall ? Stream.never : answer('ctx.done("Hello.")')
    }
    return Stream.empty
  }
  return { script, running }
}

const opened: Array<() => Promise<void>> = []
afterEach(async () => {
  // The newest first: a later engine on an earlier one's schema closes before the earlier one drops it.
  for (const close of opened.splice(0).reverse()) await close()
})

/** ChatApi and this device's engine, with a saved flow `hello`. */
const device = async (stall = 0) => {
  const m = model(stall)
  const agent = await openAgent(runtime, m.script, { actor: member, partsEvery: "20 millis" })
  const engine = await agent.engine()
  opened.push(engine.kill)
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.exit(effect))
  const draftId = crypto.randomUUID()
  await run(engine.flows.execute(FlowNew, { executionId: roundExecutionId(draftId, 0), payload: { name: "hello", request: "Say hello" } }))
  expect(await run(engine.flows.execute(FlowSave, { executionId: crypto.randomUUID(), payload: { draftId } })))
    .toMatchObject({ _tag: "Success" })
  return { agent, engine, run, model: m }
}

type Device = Awaited<ReturnType<typeof device>>

/** Reads `runId` through `run/inspect`. */
const inspect = async (d: Device, runId: string) => {
  const exit = await d.run(d.engine.flows.execute(Inspect, { executionId: crypto.randomUUID(), payload: { runId } }))
  if (Exit.isFailure(exit)) throw new Error(`inspect failed: ${JSON.stringify(exit)}`)
  return exit.value
}

/** Waits until `check` holds of `runId`, for up to 150 s on a loaded machine: the run as it was when it held. */
const until = async (d: Device, runId: string, check: (run: Awaited<ReturnType<typeof inspect>>) => boolean) => {
  let held: Awaited<ReturnType<typeof inspect>> | undefined
  await vi.waitFor(async () => {
    const run = await inspect(d, runId)
    expect(check(run)).toBe(true)
    held = run
  }, { timeout: 150_000, interval: 100 })
  return held!
}

/** Runs `statement` in the engine's own schema, whose triggers name its tables unqualified. */
const inEngine = <A>(d: Device, statement: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>) =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.withTransaction(Effect.andThen(sql`SET LOCAL search_path TO ${sql(d.engine.schema)}`, statement(sql)))))

/** Starts `hello` as a run of its own and leaves it running. */
const startHello = async (d: Device, runId = crypto.randomUUID()) => {
  await Effect.runPromise(d.engine.flows.execute(FlowRun, { executionId: runId, payload: { name: "hello" }, discard: true }))
  return runId
}

const refusal = (exit: Exit.Exit<unknown, unknown>) => JSON.stringify(exit).match(/"code":"([a-z_]+)"/)?.[1]

describe("the pure rules", () => {
  test("which flows are retried, listed and settled", () => {
    expect(retryable("flow/run")).toBe(true)
    expect(retryable("chat/Answer")).toBe(false)
    expect(retryable("run/cancel")).toBe(false)
    expect(retryable("flow/run/prompt")).toBe(false)
    expect(retryable("gone/flow")).toBe(false)
    expect(listed("flow/run")).toBe(true)
    expect(listed("run/retry")).toBe(false)
    expect(settled("cancelled")).toBe(true)
    expect(settled("suspended")).toBe(false)
    expect(runPath("retry:a/run")).toBe("/app/runs/retry%3Aa%2Frun")
    expect(retryActId("a", 2)).toBe("retry:a:2")
    expect(retriedRunId("retry:a:2")).toBe("retry:a:2/run")
  })

  test("versioned drops a person's flow's pinned revision for the current one, and keeps everything else", () => {
    expect(versioned("flow/run", { name: "hello", revision: 2 }, "current")).toEqual({ name: "hello" })
    expect(versioned("flow/run", { name: "hello", revision: 2, flowId: "f" }, "current")).toEqual({ name: "hello" })
    expect(versioned("flow/run", { name: "hello", revision: 2 }, "pinned")).toEqual({ name: "hello", revision: 2 })
    expect(versioned("app/theme/set", { mode: "dark" }, "current")).toEqual({ mode: "dark" })
    expect(versioned("flow/run", null, "current")).toBe(null)
  })
})

describe("run/list and run/inspect", () => {
  test("a finished run lists with its flow and status, and reads with its steps and result; acts aren't listed", async () => {
    const d = await device()
    const runId = crypto.randomUUID()
    expect(await d.run(d.engine.flows.execute(FlowRun, { executionId: runId, payload: { name: "hello" } })))
      .toEqual(Exit.succeed("Hello."))
    const read = await inspect(d, runId)
    expect(read).toMatchObject({ runId, flow: "flow/run", status: "completed", result: JSON.stringify("Hello.") })
    expect(read.steps.map((step) => step.action)).toContain("flow/run/load")
    expect(read.seq).toBeGreaterThan(0)

    const list = await d.run(d.engine.flows.execute(List, { executionId: crypto.randomUUID(), payload: {} }))
    expect(Exit.isSuccess(list)).toBe(true)
    const runs = (list as unknown as Exit.Success<{ runs: ReadonlyArray<{ runId: string; flow: string }> }>).value.runs
    expect(runs.find((run) => run.runId === runId)).toMatchObject({ flow: "flow/run", status: "completed" })
    expect(runs.some((run) => run.flow.startsWith("run/"))).toBe(false)

    expect(refusal(await d.run(d.engine.flows.execute(Inspect, { executionId: crypto.randomUUID(), payload: { runId: "nothing" } }))))
      .toBe("not_found")
  }, SLOW)
})

describe("run/cancel on Cloudflare", () => {
  test("Cloudflare's refusals: who may not stop it is forbidden, a run it doesn't hold not_found; no answer fails the step", async () => {
    const agent = await openAgent(runtime, () => Stream.empty, { actor: member })
    // ChatApi's stop route as a gateway answers it: each test case one answer (docs/features/actions.md#acts).
    let answer = new Response(JSON.stringify({ code: "forbidden" }), { status: 403 })
    const asked: Array<string> = []
    const engine = await agent.engine(undefined, { fetch: async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.pathname.endsWith("/stop")) {
        asked.push(`${request.method} ${url.pathname}`)
        return answer.clone()
      }
      return agent.fetch(request)
    } })
    opened.push(engine.kill)
    const stop = () =>
      Effect.runPromise(Effect.exit(engine.flows.execute(Cancel, {
        executionId: crypto.randomUUID(),
        payload: { runId: "ci:delivery-1", seq: 3, host: "cloud" },
      })))
    /** The refusal's code a stop failed with. */
    const refusal = (exit: Exit.Exit<unknown, unknown>) =>
      Exit.isFailure(exit) ? (Cause.squash(exit.cause) as { readonly code?: string }).code : undefined
    expect(refusal(await stop())).toBe("forbidden")
    answer = new Response(JSON.stringify({ code: "not_found" }), { status: 404 })
    expect(refusal(await stop())).toBe("not_found")
    answer = new Response(JSON.stringify({ outcome: "requested" }), { status: 202 })
    expect(await stop()).toEqual(Exit.succeed({ outcome: "requested" }))
    answer = new Response("", { status: 503 })
    expect((await stop())._tag).toBe("Failure")
    expect(asked[0]).toBe(`POST /api/remote-runs/${encodeURIComponent("ci:delivery-1")}/stop`)
  }, SLOW)
})

describe("run/cancel", () => {
  test("Stop settles an unobserved chat only after terminal cleanup, retrying an unavailable answer route", async () => {
    const started = Effect.runSync(Deferred.make<void>())
    const cleanup = Effect.runSync(Deferred.make<void>())
    const agent = await openAgent(runtime, () => Stream.concat(
      Stream.drain(Stream.fromEffect(Deferred.succeed(started, undefined))), Stream.never,
    ).pipe(Stream.ensuring(Deferred.await(cleanup))))
    let writes = 0
    const engine = await agent.engine(undefined, { fetch: async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).pathname.startsWith("/api/answers/") && request.method === "POST" &&
        (await request.clone().json() as { status: string }).status === "failed" && ++writes === 1) return new Response("", { status: 503 })
      return agent.fetch(request)
    } })
    opened.push(engine.kill)
    const branch = await tracked(runtime, "github/octocat/spoon-knife", `toast-${crypto.randomUUID()}`, "open", "person-member")
    const answerId = crypto.randomUUID()
    expect((await agent.h.ask({ id: crypto.randomUUID(), answerId, conversationId: branch.conversationId,
      text: "Use the sandbox tools on this branch" })).status).toBe(202)
    agent.start(engine, answerId)
    try {
      await Effect.runPromise(Deferred.await(started))
      const live = await Effect.runPromise(engine.inspection.inspect(answerId, { limit: 1 }))
      const stopping = Effect.runPromise(engine.flows.execute(Cancel, {
        executionId: crypto.randomUUID(), payload: { runId: answerId, seq: live.run.lastSeq },
      }))
      await vi.waitFor(async () => expect((await Effect.runPromise(engine.inspection.inspect(answerId, { limit: 1 })))
        .run.cancelRequestedAtMs).not.toBeNull(), { timeout: 30_000 })
      expect(await answerRow(runtime, answerId)).toMatchObject({ status: "streaming" })
      await Effect.runPromise(Deferred.succeed(cleanup, undefined))
      await stopping
      expect(await answerRow(runtime, answerId)).toMatchObject({ status: "failed", failure: "unfinished" })
      expect(writes).toBe(2)
      expect(await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql`SELECT state FROM notifications WHERE run_id = ${answerId}`))).toEqual([{ state: "failed" }])
    } finally { await Effect.runPromise(Deferred.succeed(cleanup, undefined)) }
  }, SLOW)

  test("Stop racing a successful chat preserves its answer and notification", async () => {
    const agent = await openAgent(runtime, () => answer('ctx.done("Ready.")'))
    const engine = await agent.engine()
    opened.push(engine.kill)
    const answerId = await agent.ask("Finish before Stop")
    expect(await agent.answer(engine, answerId)).toEqual(Exit.succeed({ status: "done" }))
    const live = await Effect.runPromise(engine.inspection.inspect(answerId, { limit: 1 }))
    expect(await Effect.runPromise(engine.flows.execute(Cancel, {
      executionId: crypto.randomUUID(), payload: { runId: answerId, seq: live.run.lastSeq },
    }))).toEqual({ outcome: "settled", status: "completed" })
    expect(await answerRow(runtime, answerId)).toMatchObject({ status: "done", text: "Ready." })
    expect(await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`SELECT state FROM notifications WHERE run_id = ${answerId}`))).toEqual([{ state: "done" }])
  }, SLOW)

  test("Stop on a live run records it, and the run ends cancelled; Stop again answers its final status", async () => {
    const d = await device(1)
    const runId = await startHello(d)
    const live = await until(d, runId, () => d.model.running.length === 1)
    const stop = (seq: number) => d.run(d.engine.flows.execute(Cancel, { executionId: crypto.randomUUID(), payload: { runId, seq } }))

    expect(refusal(await stop(live.seq + 1_000))).toBe("stale")
    expect(await stop(live.seq)).toEqual(Exit.succeed({ outcome: "requested", status: live.status }))
    const ended = await until(d, runId, (run) => run.status === "cancelled")
    expect(await stop(ended.seq)).toEqual(Exit.succeed({ outcome: "settled", status: "cancelled" }))
    expect(refusal(await d.run(d.engine.flows.execute(Cancel, { executionId: crypto.randomUUID(), payload: { runId: "nothing", seq: 0 } }))))
      .toBe("not_found")
  }, SLOW)
})

describe("run/retry", () => {
  test("Retry runs a settled run again as a new run of its own, once per act", async () => {
    const d = await device()
    const runId = crypto.randomUUID()
    await d.run(d.engine.flows.execute(FlowRun, { executionId: runId, payload: { name: "hello" } }))
    const act = retryActId(runId, 1)
    const retried = await d.run(d.engine.flows.execute(Retry, { executionId: act, payload: { runId, version: "pinned" } }))
    expect(retried).toEqual(Exit.succeed({ runId: retriedRunId(act) }))
    // The same act again starts nothing new.
    expect(await d.run(d.engine.flows.execute(Retry, { executionId: act, payload: { runId, version: "pinned" } }))).toEqual(retried)
    // Pinned: the run named no revision, so the retry carries the revision and flow its load pinned.
    const [stored] = await inEngine(d, (sql) =>
      sql<{ readonly state: string }>`SELECT state_json AS state FROM flows_runs WHERE run_id = ${retriedRunId(act)}`)
    const pinned = JSON.parse(stored!.state).payload as { name: string; revision: number; flowId: string }
    expect(pinned).toMatchObject({ name: "hello", revision: 1, flowId: expect.stringMatching(/^[0-9a-f-]{36}$/) })
    expect(await d.run(d.engine.flows.execute(FlowRun, { executionId: retriedRunId(act), payload: pinned })))
      .toEqual(Exit.succeed("Hello."))
    const list = await d.run(d.engine.flows.execute(List, { executionId: crypto.randomUUID(), payload: {} }))
    expect(JSON.stringify(list)).toContain(retriedRunId(act))

    const current = await d.run(d.engine.flows.execute(Retry, { executionId: retryActId(runId, 2), payload: { runId, version: "current" } }))
    expect(current).toEqual(Exit.succeed({ runId: retriedRunId(retryActId(runId, 2)) }))
  }, SLOW)

  test("refuses a run that hasn't settled, a flow never retried, an unknown run, and a payload that won't read", async () => {
    const d = await device(1)
    const retry = (runId: string) =>
      d.run(d.engine.flows.execute(Retry, { executionId: crypto.randomUUID(), payload: { runId, version: "pinned" } }))
    const live = await startHello(d)
    await until(d, live, () => d.model.running.length === 1)
    expect(refusal(await retry(live))).toBe("not_settled")

    const act = crypto.randomUUID()
    await d.run(d.engine.flows.execute(List, { executionId: act, payload: {} }))
    // run/list isn't work: an act on runs is never retried.
    expect(refusal(await retry(act))).toBe("not_retryable")
    expect(refusal(await retry("nothing"))).toBe("not_found")

    const done = crypto.randomUUID()
    await d.run(d.engine.flows.execute(Cancel, { executionId: crypto.randomUUID(), payload: { runId: live, seq: (await inspect(d, live)).seq } }))
    await until(d, live, (run) => run.status === "cancelled")
    await inEngine(d, (sql) =>
      sql`UPDATE flows_runs SET state_json = jsonb_set(state_json::jsonb, '{payload}', '{"name": 5}')::text
        WHERE run_id = ${live}`)
    expect(refusal(await retry(live))).toBe("not_retryable")
    expect(done).toBeTruthy()
  }, SLOW)
})

describe("run/retry/from", () => {
  /** The node records `runId`'s steps settled with, by action. */
  const settledNodes = async (d: Device, runId: string) =>
    (await inEngine(d, (sql) =>
      sql<{ readonly payload: string }>`SELECT payload_json AS payload FROM flows_journal_events
        WHERE run_id = ${runId} AND event_type = 'flows.engine.node-settled' ORDER BY seq`))
      .map((row) => JSON.parse(row.payload) as { readonly action?: string; readonly outcome: string })

  test("Retry from here replays a person's flow's load and runs its code again, once per act", async () => {
    const d = await device()
    const runId = crypto.randomUUID()
    expect(await d.run(d.engine.flows.execute(FlowRun, { executionId: runId, payload: { name: "hello" } })))
      .toEqual(Exit.succeed("Hello."))
    expect(d.model.running).toHaveLength(1)
    const code = (await inspect(d, runId)).steps.find((step) => step.action === "flow/run/code")!.nodeId
    const act = retryActId(runId, 1)
    const retried = await d.run(d.engine.flows.execute(RetryFrom, { executionId: act, payload: { runId, step: code } }))
    expect(retried).toEqual(Exit.succeed({ runId: retriedRunId(act) }))
    // The same act again starts nothing new.
    expect(await d.run(d.engine.flows.execute(RetryFrom, { executionId: act, payload: { runId, step: code } })))
      .toEqual(retried)
    const done = await until(d, retriedRunId(act), (run) => run.status === "completed")
    expect(done).toMatchObject({ flow: "flow/run", result: JSON.stringify("Hello.") })
    // The code ran again, one more model call; the load replayed what it recorded.
    expect(d.model.running).toHaveLength(2)
    const nodes = await settledNodes(d, retriedRunId(act))
    expect(nodes.find((node) => node.action === "flow/run/load")?.outcome).toBe("clean")
    expect(nodes.find((node) => node.action === "flow/run/code")?.outcome).toBe("built")
    const [decision] = await inEngine(d, (sql) =>
      sql<{ readonly payload: string }>`SELECT payload_json AS payload FROM flows_journal_events
        WHERE run_id = ${retriedRunId(act)} AND event_type = 'flows.engine.run-decision'
          AND payload_json LIKE '%retry-from%'`)
    expect(JSON.parse(decision!.payload)).toMatchObject({ decision: "retry-from", source: runId, step: code, replayed: 1 })
    // The run's own input, and a run of its own among the person's runs.
    const [stored] = await inEngine(d, (sql) =>
      sql<{ readonly state: string }>`SELECT state_json AS state FROM flows_runs WHERE run_id = ${retriedRunId(act)}`)
    expect(JSON.parse(stored!.state)).toMatchObject({ payload: { name: "hello" }, retryFrom: { source: runId, step: code } })
    const list = await d.run(d.engine.flows.execute(List, { executionId: crypto.randomUUID(), payload: {} }))
    expect(JSON.stringify(list)).toContain(retriedRunId(act))
  }, SLOW)

  test("refuses a run still going, a step it never ran, an act, an unknown run, and an engine that can't", async () => {
    const d = await device(1)
    const retryFrom = (runId: string, step: string) =>
      d.run(d.engine.flows.execute(RetryFrom, { executionId: crypto.randomUUID(), payload: { runId, step } }))
    const live = await startHello(d)
    await until(d, live, () => d.model.running.length === 1)
    expect(refusal(await retryFrom(live, "root"))).toBe("not_settled")

    const done = crypto.randomUUID()
    expect(await d.run(d.engine.flows.execute(FlowRun, { executionId: done, payload: { name: "hello" } })))
      .toEqual(Exit.succeed("Hello."))
    expect(refusal(await retryFrom(done, "no/such/step"))).toBe("step_not_run")
    const act = crypto.randomUUID()
    await d.run(d.engine.flows.execute(List, { executionId: act, payload: {} }))
    expect(refusal(await retryFrom(act, "root"))).toBe("not_retryable")
    expect(refusal(await retryFrom("nothing", "root"))).toBe("not_found")

    // An engine that keeps no history to replay can't retry from a step.
    const code = (await inspect(d, done)).steps.find((step) => step.action === "flow/run/code")!.nodeId
    const { retryFrom: _, ...historyless } = d.engine.flows
    const exit = await Effect.runPromiseExit(RunSteps.retryFrom({ runId: done, step: code }).pipe(
      Effect.provideService(EngineStore.RunInspection.RunInspection, d.engine.inspection),
      Effect.provideService(FlowRuntime.FlowRuntime, FlowRuntime.FlowRuntime.of(historyless)),
    ) as Effect.Effect<unknown, unknown>)
    expect(refusal(exit)).toBe("not_here")
  }, SLOW)
})

describe("run/resume", () => {
  test("Resume drives a run no host drives again; a settled or moved run is refused", async () => {
    const d = await device(1)
    const runId = await startHello(d)
    await until(d, runId, () => d.model.running.length === 1)
    // The engine dies with the run in flight, as a closed tab's does; the next one holds it, undriven.
    await d.engine.crash()
    const next = await d.agent.engine(d.engine.schema)
    opened.push(next.kill)
    const d2 = { ...d, engine: next }
    const stuck = await inspect(d2, runId)
    expect(settled(stuck.status)).toBe(false)
    const resume = (seq: number) => d2.run(next.flows.execute(Resume, { executionId: crypto.randomUUID(), payload: { runId, seq } }))

    expect(refusal(await resume(stuck.seq - 1))).toBe("stale")
    expect(await resume(stuck.seq)).toEqual(Exit.succeed({ resumed: true }))
    const done = await until(d2, runId, (run) => run.status === "completed")
    expect(done.result).toBe(JSON.stringify("Hello."))
    expect(refusal(await resume(done.seq))).toBe("settled")
    expect(refusal(await d2.run(next.flows.execute(Resume, { executionId: crypto.randomUUID(), payload: { runId: "nothing", seq: 0 } }))))
      .toBe("not_found")
  }, SLOW)

  test("a run of a flow this engine doesn't run is not here", async () => {
    const d = await device()
    const runId = crypto.randomUUID()
    await d.run(d.engine.flows.execute(FlowRun, { executionId: runId, payload: { name: "hello" } }))
    await inEngine(d, (sql) =>
      sql`UPDATE flows_runs SET state_json = jsonb_set(state_json::jsonb, '{flowName}', '"gone/flow"')::text
        WHERE run_id = ${runId}`)
    expect(refusal(await d.run(d.engine.flows.execute(Retry, { executionId: crypto.randomUUID(), payload: { runId, version: "pinned" } }))))
      .toBe("not_retryable")
    await inEngine(d, (sql) =>
      sql`UPDATE flows_runs SET status = 'suspended', finished_at_ms = NULL WHERE run_id = ${runId}`)
    const seq = (await inspect(d, runId)).seq
    expect(refusal(await d.run(d.engine.flows.execute(Cancel, { executionId: crypto.randomUUID(), payload: { runId, seq } }))))
      .toBe("not_here")
    expect(refusal(await d.run(d.engine.flows.execute(Resume, { executionId: crypto.randomUUID(), payload: { runId, seq } }))))
      .toBe("not_here")
  }, SLOW)
})

test("a real completed personal flow journal lights its graph as completed", async () => {
  const d = await device()
  const runId = crypto.randomUUID()
  expect(await d.run(d.engine.flows.execute(FlowRun, { executionId: runId, payload: { name: "hello" } }))).toEqual(Exit.succeed("Hello."))
  const events = await inEngine(d, (sql) => sql<{ seq: number; event_type: string; emitted_at_ms: string; payload_json: string }>`SELECT seq, event_type, emitted_at_ms, payload_json FROM flows_journal_events WHERE run_id = ${runId} ORDER BY seq`)
  const journal = events.map((event) => ({ seq: Number(event.seq), eventType: event.event_type, emittedAtMs: Number(event.emitted_at_ms), payload: { text: event.payload_json, bytes: new TextEncoder().encode(event.payload_json).length, clipped: false } }))
  const monitor = InspectionJournal.monitorFromInspection({ runId, flowId: "hello", status: "completed" }, journal)
  const nodes = monitor.attempts[0]!.graph
  const settlements = journal.filter((e) => e.eventType.endsWith("node-settled")).map((e) => JSON.parse(e.payload.text))
  expect(nodes.length).toBeGreaterThan(0)
  expect(nodes.map((node) => node.state), JSON.stringify(settlements)).toEqual(nodes.map(() => "done"))
}, SLOW)


test("pinned retry refuses corrupt history when the child is missing, unreadable or has no pinned revision", async () => {
  const d = await device()
  const runId = crypto.randomUUID()
  await d.run(d.engine.flows.execute(FlowRun, { executionId: runId, payload: { name: "hello" } }))
  const service = d.engine.inspection
  for (const fault of ["missing", "unreadable", "malformed"] as const) {
    const reads = EngineStore.RunInspection.RunInspection.of({ ...service,
      inspect: (id, options) => service.inspect(id, options).pipe(Effect.map((result) => fault === "missing" ? { ...result, children: [] } : result)),
      payload: (id) => id === runId ? Effect.succeed({ flowName: "flow/run", payload: { name: 5 } }) : fault === "unreadable"
        ? Effect.fail(new EngineStore.RunInspection.RunNotFound({ runId: id }))
        : Effect.succeed({ flowName: "flow/run/prompt", payload: {} }),
    })
    const exit = await Effect.runPromiseExit(RunSteps.retry({ runId, version: "pinned" }).pipe(Effect.provideService(EngineStore.RunInspection.RunInspection, reads)) as Effect.Effect<unknown, unknown>)
    expect(refusal(exit), fault).toBe("not_retryable")
  }
}, SLOW)
