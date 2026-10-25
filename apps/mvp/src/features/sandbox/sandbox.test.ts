// The sandbox tools in the browser (docs/features/sandbox-tools.md#the-flows): each tool's flow on the Node host's engine
// (worker/test/flowHost.ts) against ChatApi's real sandbox call routes (worker/branch/SandboxCalls.ts, through
// worker/test/branch.ts) on this file's schema of the compose Postgres (`pnpm db:up`). The remote `sandbox/Call`
// doesn't run here: the test settles a call's row with that flow's own `settle`, as it would. The steps and the client
// are also driven over a test `SandboxClient` and an injected `fetch`, for the answers a valid request never gets
// (test.faults-by-injection). A person's slash command, pinned to the conversation the tab shows, is in
// src/features/commands/commands.test.ts.
import { Uuid, WebCrypto } from "@smthrs/crypto"
import { Action, FlowRuntime } from "@smthrs/flow"
import { Context, type Crypto, Effect, Exit, Layer, Logger, Metric, Schema, Scope } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { Actor } from "../../../worker/Actor.ts"
import { settle } from "../../../worker/flows/SandboxCall.ts"
import * as Messages from "../../../worker/Messages.ts"
import { branchHarness, resetBranches, tracked } from "../../../worker/test/branch.ts"
import { build } from "../../../worker/test/flowHost.ts"
import { testFile } from "../../../worker/test/harness.ts"
import { BROWSER_TELEMETRY } from "../../telemetry"
import { pinConversation } from "./actions"
import { CallRefused, SandboxClient } from "./api"
import { CALL_ID_NAMESPACE, COMMAND_LIMIT_SECONDS, SANDBOX_TELEMETRY } from "./contract"
import {
  COMMAND_MAX_SECONDS,
  Failure,
  RESULT_RETRY,
  Run,
  runTool,
  START_RETRY,
  SandboxCallFailed,
  SandboxCallRefused,
  SandboxCallRunning,
  SandboxCallUnavailable,
  SandboxDiff,
  SandboxRead,
  SandboxRun,
} from "./flows"
import { calls } from "./metrics"
import type { Standing } from "./schema"
import { refusalOf, registrationAt, result, start } from "./steps"

const runtime = testFile("sandbox_tools")
beforeEach(() => resetBranches(runtime))
const scopes: Array<Scope.Closeable> = []
afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void))
})

const member: Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }
const REPO = "github/octocat/spoon-knife"
const SENTINEL = "sentinel-77b2c0"

/** A test's budget: flows on a fresh engine, each with its first start, on a loaded machine. */
const WITHIN = 90_000

const callIdOf = (executionId: string) => Effect.runPromise(Uuid.v5(CALL_ID_NAMESPACE, executionId).pipe(Effect.provide(WebCrypto.layer)))

/** The tools' flows on the Node host's engine, calling ChatApi's real routes as a Member: a run, the harness and records. */
const openEngine = async (commandMaxSeconds = COMMAND_LIMIT_SECONDS) => {
  const h = await branchHarness(runtime, { actor: member, config: { SANDBOX_COMMAND_MAX_SECONDS: String(commandMaxSeconds) } })
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    return h.fetch(`${url.pathname}${url.search}`, input instanceof Request ? input : init)
  }
  const logs: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const registry: Metric.MetricRegistry = new Map()
  const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((o) => void logs.push(Logger.formatStructured.log(o)))])),
      Effect.provideService(Metric.MetricRegistry, registry),
    )
  const scope = Effect.runSync(Scope.make())
  scopes.push(scope)
  const { context } = await Effect.runPromise(
    observed(
      Scope.provide(scope)(
        build(
          registrationAt("http://chat.test").pipe(
            Layer.provideMerge(Action.layerImplementations),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
          ),
        ),
      ),
    ),
  )
  const flows = Context.get(context, FlowRuntime.FlowRuntime)
  return {
    h,
    execute: <F extends typeof SandboxRun | typeof SandboxRead | typeof SandboxDiff>(
      flow: F,
      executionId: string,
      payload: F["payloadSchema"]["Type"],
    ) => Effect.runPromise(observed(Effect.exit(flows.execute(flow as typeof SandboxRun, { executionId, payload: payload as never })))),
    count: (attributes: Record<string, string>) =>
      Effect.runSync(
        Metric.value(Metric.withAttributes(calls, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
      ).count,
    lines: () => logs.filter((log) => log.message === "sandbox.call"),
  }
}

/** Every call Postgres holds: its id, answer and status. */
const rows = () =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly id: string; readonly answerId: string | null; readonly tool: string; readonly status: string }>`
      SELECT id, answer_id AS "answerId", tool, status FROM sandbox_calls ORDER BY created_at`))

const ran = {
  tool: "run",
  exitCode: 0,
  timedOut: false,
  stdout: `${SENTINEL}\n`,
  stderr: "",
  stdoutBytes: SENTINEL.length + 1,
  stderrBytes: 0,
  truncated: false,
} as const

describe("the flows", () => {
  test("a lowered limit reaches the browser's flow once, without starting a command; a shorter new call runs", async () => {
    const engine = await openEngine(900)
    const branch = await tracked(runtime, REPO, `feature/${crypto.randomUUID()}`)
    const input = { command: `echo ${SENTINEL}`, conversationId: branch.conversationId }
    const failure = await Effect.runPromise(Effect.flip(await engine.execute(SandboxRun, "too-long", { ...input, timeoutSeconds: 901 })))
    expect(failure).toMatchObject({ _tag: "@smthrs/mvp/sandbox/SandboxCommandTooLong", maxSeconds: 900 })
    expect(engine.h.starts).toEqual([])
    expect(await rows()).toEqual([])
    expect(engine.h.line("sandbox.call")).toHaveLength(1)
    expect(engine.count({ tool: "run", outcome: "too_long" })).toBe(1)
    expect(engine.lines()).toMatchObject([{ level: "WARN", annotations: { tool: "run", outcome: "too_long" } }])
    expect(JSON.stringify(engine.lines())).not.toContain(SENTINEL)

    const shorter = engine.execute(SandboxRun, "shorter", { ...input, timeoutSeconds: 900 })
    await vi.waitFor(() => expect(engine.h.starts).toHaveLength(1), { timeout: 30_000, interval: 20 })
    expect(engine.h.starts[0]).toMatchObject({ payload: { call: { timeoutSeconds: 900 } } })
    await runtime.runPromise(settle(await callIdOf("shorter"), { status: "done", result: ran }))
    expect(await shorter).toEqual(Exit.succeed(ran))
  }, WITHIN)

  test("a person's run calls ChatApi with the pinned conversation, waits while it runs, and answers its result", async () => {
    const engine = await openEngine()
    const branch = await tracked(runtime, REPO, `feature/${crypto.randomUUID()}`)
    const callId = await callIdOf("run-1")

    const running = engine.execute(SandboxRun, "run-1", {
      command: `echo ${SENTINEL}`,
      conversationId: branch.conversationId.toUpperCase(),
    })
    // The machine runs it in the remote sandbox/Call: here, settled as that flow settles it.
    await vi.waitFor(() => expect(engine.h.starts).toHaveLength(1), { timeout: 30_000, interval: 20 })
    expect(engine.h.starts[0]).toMatchObject({
      flow: "sandbox/Call",
      payload: { callId, call: { tool: "run", command: `echo ${SENTINEL}` }, branch: { branchId: branch.branchId } },
    })
    await runtime.runPromise(settle(callId, { status: "done", result: ran, generation: 1 }))

    expect(await running).toEqual(Exit.succeed(ran))
    expect(await rows()).toEqual([{ id: callId, answerId: null, tool: "run", status: "done" }])
    expect(engine.count({ tool: "run", outcome: "done" })).toBe(1)
    expect(engine.lines()).toMatchObject([{ level: "INFO", annotations: { tool: "run", outcome: "done", callId, feature: "sandbox" } }])
    expect(JSON.stringify(engine.lines())).not.toContain(SENTINEL)
  }, WITHIN)

  test("the agent's call works in its answer's conversation; the same run again reads the one call, never a second", async () => {
    const engine = await openEngine()
    const branch = await tracked(runtime, REPO, `feature/${crypto.randomUUID()}`)
    const ids = { id: crypto.randomUUID(), answerId: crypto.randomUUID() }
    await runtime.runPromise(
      Messages.ask({ ...ids, conversationId: branch.conversationId, text: "Show the diff", askedBy: member.subject.id }),
    )
    const executionId = `${ids.answerId.toUpperCase()}/chat/Respond@abc:1/call/1.0`
    const callId = await callIdOf(executionId)
    const diffed = { tool: "diff", diff: "+hi\n", bytes: 4, truncated: false } as const
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`INSERT INTO sandbox_calls (id, branch_id, person_id, answer_id, tool)
        VALUES (${callId}, ${branch.branchId}, ${member.subject.id}, ${ids.answerId}, 'diff')`))
    await runtime.runPromise(settle(callId, { status: "done", result: diffed, generation: 2 }))

    // As a run resumed after its tab closed: the call is the one already settled.
    expect(await engine.execute(SandboxDiff, executionId, {})).toEqual(Exit.succeed(diffed))
    expect(await rows()).toEqual([{ id: callId, answerId: ids.answerId, tool: "diff", status: "done" }])
    expect(engine.h.starts).toEqual([])
    // Who called is the request's to say: this engine sends no run credentials (the browser's does,
    // src/flows/credentials.ts), so ChatApi records the person, who may name their own answer.
    expect(engine.h.line("sandbox.call").map((line) => [line.annotations.door, line.annotations.outcome])).toEqual([
      ["person", "existing"],
    ])
  }, WITHIN)

  test("a call the machine settles failed fails the flow with why, counted", async () => {
    const engine = await openEngine()
    const branch = await tracked(runtime, REPO, `feature/${crypto.randomUUID()}`)
    const callId = await callIdOf("read-1")
    const reading = engine.execute(SandboxRead, "read-1", { path: "absent.txt", conversationId: branch.conversationId })
    await vi.waitFor(() => expect(engine.h.starts).toHaveLength(1), { timeout: 30_000, interval: 20 })
    await runtime.runPromise(settle(callId, { status: "failed", failure: "not_found" }))

    expect(await reading).toEqual(Exit.fail(new SandboxCallFailed({ failure: "not_found" })))
    expect(engine.count({ tool: "read", outcome: "not_found" })).toBe(1)
  }, WITHIN)

  test("a run takes a command up to an hour, says so, and its result is waited for past the job's deadline", () => {
    const run = (timeoutSeconds: number) => ({ command: "pnpm install", timeoutSeconds })
    expect(Schema.is(SandboxRun.payloadSchema)(run(1200))).toBe(true)
    expect(Schema.is(SandboxRun.payloadSchema)(run(COMMAND_LIMIT_SECONDS))).toBe(true)
    expect(Schema.is(SandboxRun.payloadSchema)(run(COMMAND_LIMIT_SECONDS + 1))).toBe(false)
    expect(SandboxRun.description).toContain(`60 unless set, ${COMMAND_LIMIT_SECONDS} at most`)
    // An hour's command and its job's 20 minutes to wake, probe and collect, then 10 to launch the job and settle.
    expect(RESULT_RETRY.expirationMs).toBe(90 * 60_000)
  })

  test("a deployment's lower SANDBOX_COMMAND_MAX_SECONDS is what its run tool takes, says and waits for", () => {
    const run = (timeoutSeconds: number) => ({ command: "pnpm install", timeoutSeconds })
    const lowered = runTool(900)
    expect(Schema.is(lowered.flow.payloadSchema)(run(900))).toBe(true)
    expect(Schema.is(lowered.flow.payloadSchema)(run(901))).toBe(false)
    expect(lowered.flow.description).toContain("60 unless set, 900 at most")
    expect(lowered.Result.retryPolicy?.expirationMs).toBe((900 + 30 * 60) * 1000)
    // Where no build wrote a limit in, the deployment's is the job's own.
    expect(COMMAND_MAX_SECONDS).toBe(COMMAND_LIMIT_SECONDS)
    expect(Run.Result.retryPolicy?.expirationMs).toBe(RESULT_RETRY.expirationMs)
  })

  test("records carry the tool and outcome, fields the browser relays", () => {
    expect(BROWSER_TELEMETRY.records).toEqual(expect.arrayContaining([...SANDBOX_TELEMETRY.records]))
    expect(BROWSER_TELEMETRY.fields).toEqual(expect.arrayContaining([...SANDBOX_TELEMETRY.fields]))
  })
})

/** A client whose `start` and `result` answer from the test, recording what they were asked. */
const scripted = (answers: {
  readonly start?: Effect.Effect<Standing, CallRefused>
  readonly result?: ReadonlyArray<Effect.Effect<Standing, CallRefused>>
}) => {
  const started: Array<unknown> = []
  let read = 0
  const layer = Layer.succeed(
    SandboxClient,
    SandboxClient.of({
      start: (request) =>
        Effect.suspend(() => {
          started.push(request)
          return answers.start ?? Effect.die("no start scripted")
        }),
      result: () => Effect.suspend(() => answers.result![Math.min(read++, answers.result!.length - 1)]!),
    }),
  )
  return { started, layer }
}

/** Runs a step in the run `executionId`, counting into a registry of its own: how it ended, and what it counted. */
const step = async <A, E>(
  effect: Effect.Effect<A, E, FlowRuntime.FlowInstance | SandboxClient | Crypto.Crypto>,
  client: Layer.Layer<SandboxClient>,
  executionId = "run-7",
) => {
  const registry: Metric.MetricRegistry = new Map()
  const exit = await Effect.runPromise(
    effect.pipe(
      // How it ended: its success, or its declared failure, without the span the step ran in.
      Effect.match({ onSuccess: (value) => Exit.succeed(value) as Exit.Exit<A, E>, onFailure: (error) => Exit.fail(error) }),
      Effect.provideService(FlowRuntime.FlowInstance, { executionId } as FlowRuntime.FlowInstance["Service"]),
      Effect.provide(client),
      Effect.provide(WebCrypto.layer),
      Effect.provideService(Metric.MetricRegistry, registry),
    ),
  )
  const count = (tool: string, outcome: string) =>
    Effect.runSync(
      Metric.value(Metric.withAttributes(calls, { tool, outcome })).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
    ).count
  return { exit, count }
}

describe("the steps", () => {
  test.each([60, 900, 1800, COMMAND_LIMIT_SECONDS])("a too_long refusal carries the %s second limit without retrying", (maxSeconds) => {
    const failure = refusalOf(new CallRefused({ status: 400, code: "too_long", maxSeconds }))
    expect(failure).toMatchObject({ _tag: "@smthrs/mvp/sandbox/SandboxCommandTooLong", maxSeconds })
    expect(Schema.is(Failure)(failure)).toBe(true)
    expect(START_RETRY.nonRetryable).toContain(failure._tag)
    expect(RESULT_RETRY.nonRetryable).toContain(failure._tag)
  })

  test("too_long needs a 400 and the limit; other refusals keep their meaning", () => {
    expect(refusalOf(new CallRefused({ status: 400, code: "too_long" })))
      .toEqual(new SandboxCallRefused({ reason: "invalid" }))
    expect(refusalOf(new CallRefused({ status: 400, code: "invalid", maxSeconds: 900 })))
      .toEqual(new SandboxCallRefused({ reason: "invalid" }))
    expect(refusalOf(new CallRefused({ status: 413, code: "too_long", maxSeconds: 900 })))
      .toEqual(new SandboxCallRefused({ reason: "invalid" }))
    expect(refusalOf(new CallRefused({ status: 503, code: "too_long", maxSeconds: 900 })))
      .toEqual(new SandboxCallUnavailable())
  })

  test("start and result count a too_long refusal by its own outcome", async () => {
    const refused = new CallRefused({ status: 400, code: "too_long", maxSeconds: 900 })
    const starting = await step(
      start("run")({ command: "pnpm install", timeoutSeconds: 901, conversationId: "c" }),
      scripted({ start: Effect.fail(refused) }).layer,
    )
    expect(starting.exit).toEqual(Exit.fail(refusalOf(refused)))
    expect(starting.count("run", "too_long")).toBe(1)
    const reading = await step(result("run")({ callId: "c" }), scripted({ result: [Effect.fail(refused)] }).layer)
    expect(reading.exit).toEqual(Exit.fail(refusalOf(refused)))
    expect(reading.count("run", "too_long")).toBe(1)
  })

  test.each<[number | undefined, string | undefined, SandboxCallRefused | SandboxCallUnavailable]>([
    [401, undefined, new SandboxCallRefused({ reason: "sign_in" })],
    [403, "forbidden", new SandboxCallRefused({ reason: "forbidden" })],
    [409, "locked", new SandboxCallRefused({ reason: "locked" })],
    [404, "not_found", new SandboxCallRefused({ reason: "not_found" })],
    [400, "invalid", new SandboxCallRefused({ reason: "invalid" })],
    [413, "invalid", new SandboxCallRefused({ reason: "invalid" })],
    [409, "id_taken", new SandboxCallRefused({ reason: "invalid" })],
    [503, "unavailable", new SandboxCallUnavailable()],
    [undefined, undefined, new SandboxCallUnavailable()],
  ])("ChatApi's %s (%s) means %o", (status, code, failure) => {
    expect(refusalOf(new CallRefused({ ...(status === undefined ? {} : { status }), ...(code === undefined ? {} : { code }) })))
      .toEqual(failure)
  })

  test("start names the run's call, the pinned conversation for a person, the answer for the agent", async () => {
    const person = scripted({ start: Effect.succeed({ callId: "x", status: "running" }) })
    const started = await step(start("run")({ command: "ls", cwd: undefined, conversationId: "ABC" }), person.layer)
    expect(started.exit).toEqual(Exit.succeed({ callId: await callIdOf("run-7") }))
    expect(person.started).toEqual([{
      callId: await callIdOf("run-7"),
      call: { command: "ls", cwd: undefined, tool: "run" },
      conversationId: "abc",
    }])

    const agent = scripted({ start: Effect.succeed({ callId: "x", status: "running" }) })
    const answerId = crypto.randomUUID()
    const executionId = `${answerId.toUpperCase()}/chat/Respond@abc:1/call/2.0`
    await step(start("status")({ conversationId: crypto.randomUUID() }), agent.layer, executionId)
    expect(agent.started).toEqual([{ callId: await callIdOf(executionId), call: { tool: "status" }, answerId }])

    // A child of a run that isn't an answer's is a person's call.
    const child = scripted({ start: Effect.succeed({ callId: "x", status: "running" }) })
    await step(start("status")({ conversationId: "c-1" }), child.layer, "flow-run-1/call/1.0")
    expect(child.started).toEqual([expect.objectContaining({ conversationId: "c-1" })])
  })

  test("start without a conversation is invalid before anything is asked; a refusal or a failed call fails, counted", async () => {
    const none = scripted({})
    const invalid = await step(start("list")({}), none.layer)
    expect(invalid.exit).toEqual(Exit.fail(new SandboxCallRefused({ reason: "invalid" })))
    expect(invalid.count("list", "invalid")).toBe(1)
    expect(none.started).toEqual([])

    const locked = await step(
      start("write")({ path: "a", content: "b", conversationId: "c" }),
      scripted({ start: Effect.fail(new CallRefused({ status: 409, code: "locked" })) }).layer,
    )
    expect(locked.exit).toEqual(Exit.fail(new SandboxCallRefused({ reason: "locked" })))
    expect(locked.count("write", "locked")).toBe(1)

    const offline = await step(start("write")({ path: "a", content: "b", conversationId: "c" }), scripted({ start: Effect.fail(new CallRefused({})) }).layer)
    expect(offline.exit).toEqual(Exit.fail(new SandboxCallUnavailable()))
    expect(offline.count("write", "unavailable")).toBe(1)

    const failed = await step(
      start("run")({ command: "x", conversationId: "c" }),
      scripted({ start: Effect.succeed({ callId: "x", status: "failed", failure: "lost" }) }).layer,
    )
    expect(failed.exit).toEqual(Exit.fail(new SandboxCallFailed({ failure: "lost" })))
    expect(failed.count("run", "lost")).toBe(1)
  })

  test("result fails SandboxCallRunning while the machine runs, uncounted, and answers the result once done", async () => {
    const running = await step(result("run")({ callId: "c" }), scripted({ result: [Effect.succeed({ callId: "c", status: "running" })] }).layer)
    expect(running.exit).toEqual(Exit.fail(new SandboxCallRunning()))
    expect(running.count("run", "unavailable")).toBe(0)

    const done = await step(
      result("run")({ callId: "c" }),
      scripted({ result: [Effect.succeed({ callId: "c", status: "done", result: ran })] }).layer,
    )
    expect(done.exit).toEqual(Exit.succeed(ran))
    expect(done.count("run", "done")).toBe(1)
  })

  test("result: a failed call and a refusal are settled and counted; ChatApi out of reach is asked again, uncounted", async () => {
    const failed = await step(
      result("read")({ callId: "c" }),
      scripted({ result: [Effect.succeed({ callId: "c", status: "failed", failure: "path" })] }).layer,
    )
    expect(failed.exit).toEqual(Exit.fail(new SandboxCallFailed({ failure: "path" })))
    expect(failed.count("read", "path")).toBe(1)

    const gone = await step(result("read")({ callId: "c" }), scripted({ result: [Effect.fail(new CallRefused({ status: 404 }))] }).layer)
    expect(gone.exit).toEqual(Exit.fail(new SandboxCallRefused({ reason: "not_found" })))
    expect(gone.count("read", "not_found")).toBe(1)

    const offline = await step(result("read")({ callId: "c" }), scripted({ result: [Effect.fail(new CallRefused({}))] }).layer)
    expect(offline.exit).toEqual(Exit.fail(new SandboxCallUnavailable()))
    expect(offline.count("read", "unavailable")).toBe(0)
  })
})

describe("the client", () => {
  /** The client over a fetch that answers `answer`, recording each request. */
  const client = async (
    call: (client: SandboxClient["Service"]) => Effect.Effect<Standing, CallRefused>,
    answer: typeof globalThis.fetch,
    within: `${number} millis` = "1000 millis",
  ) => {
    const requests: Array<{ readonly method: string; readonly url: string; readonly body: unknown }> = []
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      requests.push({ method: request.method, url: request.url, body: request.method === "POST" ? await request.json() : null })
      return answer(input, init)
    }
    const ended = await Effect.runPromise(
      Effect.flatMap(SandboxClient, call).pipe(
        Effect.match({ onSuccess: (standing) => standing as unknown, onFailure: (failure) => failure as unknown }),
        Effect.provide(
          SandboxClient.layer({ origin: "http://chat.test", within }).pipe(
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
          ),
        ),
      ),
    )
    return { ended, requests }
  }
  const startRun = (c: SandboxClient["Service"]) =>
    c.start({ callId: "c-1", call: { tool: "status" }, conversationId: "v-1" })

  test.each([1, 900, 1800, COMMAND_LIMIT_SECONDS])("a refused call keeps the deployment's %s second limit", async (maxSeconds) => {
    expect((await client(startRun, async () => Response.json({ code: "too_long", maxSeconds }, { status: 400 }))).ended)
      .toMatchObject({ status: 400, code: "too_long", maxSeconds })
  })

  test.each([0, -1, 1.5, "900", null])("a refusal with an invalid maxSeconds (%s) isn't decoded", async (maxSeconds) => {
    expect((await client(startRun, async () => Response.json({ code: "too_long", maxSeconds }, { status: 400 }))).ended)
      .toEqual(new CallRefused({ status: 400 }))
  })

  test("posts a call and gets one, answering how it stands on 200 or 202", async () => {
    const posted = await client(startRun, async () => Response.json({ callId: "c-1", status: "running" }, { status: 202 }))
    expect(posted).toEqual({
      ended: { callId: "c-1", status: "running" },
      requests: [{
        method: "POST",
        url: "http://chat.test/api/sandbox/calls",
        body: { callId: "c-1", call: { tool: "status" }, conversationId: "v-1" },
      }],
    })
    const read = await client(
      (c) => c.result("c-1"),
      async () => Response.json({ callId: "c-1", status: "done", result: { tool: "status", branch: "main", entries: [] } }),
    )
    expect(read).toEqual({
      ended: { callId: "c-1", status: "done", result: { tool: "status", branch: "main", entries: [] } },
      requests: [{ method: "GET", url: "http://chat.test/api/sandbox/calls/c-1", body: null }],
    })
  })

  test("anything else is a CallRefused: by status and code, with no answer at all, in time or readable", async () => {
    expect((await client(startRun, async () => Response.json({ code: "locked" }, { status: 409 }))).ended).toEqual(
      new CallRefused({ status: 409, code: "locked" }),
    )
    expect((await client(startRun, async () => new Response("busy", { status: 503 }))).ended).toEqual(
      new CallRefused({ status: 503 }),
    )
    const cut = new ReadableStream({ start: (controller) => controller.error(new TypeError("cut")) })
    expect((await client(startRun, async () => new Response(cut, { status: 502 }))).ended).toEqual(new CallRefused({ status: 502 }))
    expect((await client(startRun, () => Promise.reject(new TypeError("offline")))).ended).toEqual(new CallRefused({}))
    expect((await client(startRun, () => new Promise(() => {}), "50 millis")).ended).toEqual(new CallRefused({}))
    expect((await client(startRun, async () => Response.json({ status: "maybe" }, { status: 200 }))).ended).toEqual(
      new CallRefused({ status: 200 }),
    )
  })
})

describe("pinConversation", () => {
  test("keeps a payload that names its conversation, and one with no tab to read", async () => {
    expect(await Effect.runPromise(pinConversation({ path: "a", conversationId: "c-1" }))).toEqual({
      path: "a",
      conversationId: "c-1",
    })
    expect(await Effect.runPromise(pinConversation({ path: "a" }))).toEqual({ path: "a" })
  })
})
