// `queue/ask` (worker/flows/Ask.ts, docs/features/agent-status.md#addressed-waits) on the Durable Object's handlers
// (worker/ExecutionHost.ts) over an in-memory stand-in for its storage, the engine on a fresh schema of the compose
// Postgres, and the app's tables on this file's schema: the run parks on its human task, the person's answer reaches
// it through the object's `answer`, and the same run settles its row. Postgres fails only through an injected client.
import { Logger as StructuredLogger } from "@smthrs/observability"
import { FlowRuntime } from "@smthrs/flow"
import { Cause, Context, Effect, Exit, Layer, Logger, Metric } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as ExecutionHost from "../ExecutionHost.ts"
import { rowIdOf } from "../RepoRuns.ts"
import { engineSchema, executions, memory, status } from "../test/executions.ts"
import { build } from "../test/flowHost.ts"
import { testFile } from "../test/harness.ts"
import * as Ask from "./Ask.ts"
import * as Pause from "./Pause.ts"

const app = testFile("queue_ask")

/** The question's words, an option and the answer: sentinels no record may carry. */
const PROMPT = "prompt-sentinel-7c1d: ship the docs preview?"
const ANSWER = "answer-sentinel-41ab"

const request = (id = crypto.randomUUID().slice(0, 8)): Ask.AskRequest => ({
  repo: "acme/widgets",
  id,
  to: "person-maya",
  askedBy: "machine:builder/lane-1",
  prompt: PROMPT,
  options: ["option-sentinel-yes", "no"],
})

const appDatabase = () => app.runPromise(Effect.service(TestDatabase.Scratch)).then((scratch) => scratch.database)

const rowOf = async (executionId: string) => {
  const id = await Effect.runPromise(rowIdOf(executionId))
  const [row] = await app.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<Record<string, unknown>>`
      SELECT flow, status, waiting, wait, version, answer, answered_at AS "answeredAt", launched_by AS "launchedBy",
        addressed_to AS "addressedTo", repo_id AS "repoId", conversation_id AS "conversationId", execution
      FROM runs WHERE id = ${id}::uuid`))
  return row
}

/** Every log line and count the test's effects record. */
const recording = () => {
  const lines: Array<ReturnType<typeof StructuredLogger.formatStructured.log>> = []
  const registry: Metric.MetricRegistry = new Map()
  const logger = Logger.make((options) => void lines.push(StructuredLogger.formatStructured.log(options)))
  const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])), Effect.provideService(Metric.MetricRegistry, registry))
  const count = (attributes: Record<string, string>) =>
    Effect.runSync(Metric.value(Metric.withAttributes(Ask.writes, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry))).count
  return { lines, observed, count }
}

/** Runs `use` with the app's tables and a fresh engine schema whose objects run `queue/ask`. */
const withAsks = <A, E>(
  use: (
    remote: ReturnType<typeof executions> & { readonly engine: Effect.Success<typeof engineSchema>; readonly database: Awaited<ReturnType<typeof appDatabase>> },
  ) => Effect.Effect<A, E>,
) =>
  appDatabase().then((database) =>
    Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const engine = yield* engineSchema
      return yield* use({ ...executions(engine.database, database), engine, database })
    })))
  )

/** The run's recorded result, read by executing it again on a Node host over the same engine schema. */
const resultOf = (schema: string, executionId: string, payload: Ask.AskRequest, database: Awaited<ReturnType<typeof appDatabase>>) =>
  Effect.scoped(Effect.gen(function* () {
    const { context } = yield* build(Ask.registration(database), { schema })
    return yield* Context.get(context, FlowRuntime.FlowRuntime).execute(Ask.Ask, { executionId, payload }).pipe(
      Effect.provide(context),
    )
  }))

test("a question parks with its row needing the person; their answer resumes the same run, which settles it done", () =>
  withAsks((remote) => Effect.gen(function* () {
    const recorded = recording()
    const payload = request()
    const executionId = Ask.askExecutionId(payload.repo, payload.id)
    yield* remote.starter.start(Ask.Ask, { executionId, payload })
    expect((yield* recorded.observed(remote.alarm(executionId)))._tag).toBe("Parked")
    expect(yield* status(remote.engine.sql, remote.engine.name, executionId)).toBe("suspended")
    expect(yield* Effect.promise(() => rowOf(executionId))).toEqual({
      flow: "queue/ask",
      status: "needs_you",
      waiting: "input",
      wait: { execution: executionId, kind: "question", prompt: PROMPT, options: ["option-sentinel-yes", "no"] },
      version: 1,
      answer: null,
      answeredAt: null,
      launchedBy: "machine:builder/lane-1",
      addressedTo: "person-maya",
      repoId: "github/acme/widgets",
      conversationId: null,
      execution: null,
    })
    // Another task's answer, or none of this run's, takes nothing.
    expect(yield* remote.answers.answer(executionId, "another-task", ANSWER)).toBe(false)
    expect(yield* remote.answers.answer(executionId, Ask.ASK_TASK, ANSWER)).toBe(true)
    expect(remote.object(executionId)!.alarm()).toBeLessThanOrEqual(Date.now())
    expect((yield* recorded.observed(remote.alarm(executionId)))._tag).toBe("Settled")
    expect(yield* status(remote.engine.sql, remote.engine.name, executionId)).toBe("completed")
    expect(yield* Effect.promise(() => rowOf(executionId))).toMatchObject({
      status: "done",
      waiting: null,
      wait: { execution: executionId, kind: "question", prompt: PROMPT },
      answer: { value: ANSWER },
      answeredAt: expect.any(Date),
    })
    // A settled run is parked on nothing.
    expect(yield* remote.answers.answer(executionId, Ask.ASK_TASK, "later")).toBe(false)
    expect(yield* resultOf(remote.engine.name, executionId, payload, remote.database)).toEqual({ answered: true, answer: ANSWER })
    expect(recorded.count({ op: "open", outcome: "opened" })).toBe(1)
    expect(recorded.count({ op: "settle", outcome: "done" })).toBe(1)
    const text = JSON.stringify(recorded.lines)
    expect(recorded.lines.filter((line) => line.message === "queue.ask.open").map((line) => line.annotations))
      .toEqual([expect.objectContaining({ runId: executionId, outcome: "opened", tier: "sealed" })])
    for (const sentinel of ["prompt-sentinel", "option-sentinel", "answer-sentinel"]) expect(text).not.toContain(sentinel)
  })))

test.each(["before", "after"] as const)("an answer given %s the object's handlers are replaced is not lost", (when) =>
  withAsks((remote) => Effect.gen(function* () {
    const payload = request()
    const executionId = Ask.askExecutionId(payload.repo, payload.id)
    yield* remote.starter.start(Ask.Ask, { executionId, payload })
    expect((yield* remote.alarm(executionId))._tag).toBe("Parked")
    if (when === "before") expect(yield* remote.answers.answer(executionId, Ask.ASK_TASK, ANSWER)).toBe(true)
    remote.restart()
    if (when === "after") expect(yield* remote.answers.answer(executionId, Ask.ASK_TASK, ANSWER)).toBe(true)
    expect((yield* remote.alarm(executionId))._tag).toBe("Settled")
    expect(yield* Effect.promise(() => rowOf(executionId))).toMatchObject({ status: "done", answer: { value: ANSWER } })
  })))

test("an answer the task refuses ends the question: the row settles failed and the run answers unanswered", () =>
  withAsks((remote) => Effect.gen(function* () {
    const payload = request()
    const executionId = Ask.askExecutionId(payload.repo, payload.id)
    yield* remote.starter.start(Ask.Ask, { executionId, payload })
    yield* remote.alarm(executionId)
    // Not words: the answer route never sends one, and the budget of one attempt is spent on it.
    expect(yield* remote.answers.answer(executionId, Ask.ASK_TASK, 42)).toBe(true)
    expect((yield* remote.alarm(executionId))._tag).toBe("Settled")
    expect(yield* status(remote.engine.sql, remote.engine.name, executionId)).toBe("completed")
    expect(yield* Effect.promise(() => rowOf(executionId))).toMatchObject({
      status: "failed",
      waiting: null,
      answer: null,
      answeredAt: null,
      wait: { execution: executionId, prompt: PROMPT },
    })
    expect(yield* resultOf(remote.engine.name, executionId, payload, remote.database)).toEqual({ answered: false })
  })))

test("no execution, a flow this host doesn't run, a run parked on no human task and an answer past the boundary take nothing", () =>
  withAsks((remote) => Effect.gen(function* () {
    // An object that never started holds nothing afterwards.
    expect(yield* remote.answers.answer("queue/ask:acme/widgets:never", Ask.ASK_TASK, ANSWER)).toBe(false)
    expect(remote.object("queue/ask:acme/widgets:never")!.values.size).toBe(0)

    const payload = request()
    const executionId = Ask.askExecutionId(payload.repo, payload.id)
    yield* remote.starter.start(Ask.Ask, { executionId, payload })
    yield* remote.alarm(executionId)
    // Over 256 KiB: refused before it reaches durable storage.
    expect(yield* remote.answers.answer(executionId, Ask.ASK_TASK, "x".repeat(300 * 1024))).toBe(false)
    // A host that doesn't run `queue/ask`, over the same object.
    const elsewhere = ExecutionHost.make(remote.object(executionId)!.storage, {
      hostId: `object-${executionId}`,
      database: remote.engine.database,
      flows: { flows: [Pause.Pause], registration: Pause.registration(Pause.logged) },
      router: { start: () => Effect.void, wake: () => Effect.void },
    })
    expect(yield* elsewhere.answer(Ask.ASK_TASK, ANSWER)).toBe(false)
    expect(yield* Effect.promise(() => rowOf(executionId))).toMatchObject({ status: "needs_you", answer: null })

    // A run parked on its timer, not on a person.
    const object = memory()
    const sleeping = crypto.randomUUID()
    const timer = ExecutionHost.make(object.storage, {
      hostId: `object-${sleeping}`,
      database: remote.engine.database,
      flows: { flows: [Pause.Pause], registration: Pause.registration(Pause.logged) },
      router: { start: () => Effect.void, wake: () => Effect.void },
    })
    yield* timer.start(yield* ExecutionHost.intent(Pause.Pause, { executionId: sleeping, payload: { label: "t", pauseMs: 60_000 } }))
    expect((yield* timer.alarm())._tag).toBe("Parked")
    expect(yield* timer.answer(Ask.ASK_TASK, ANSWER)).toBe(false)
  })))

test("each step writes once: a replayed open finds its row, a settled row stays settled, Postgres down is retried", async () => {
  const database = await appDatabase()
  const recorded = recording()
  const payload = request()
  const executionId = Ask.askExecutionId(payload.repo, payload.id)
  const step = <A, E>(effect: Effect.Effect<A, E, FlowRuntime.FlowInstance>) =>
    Effect.runPromise(Effect.exit(recorded.observed(effect.pipe(
      Effect.provideService(FlowRuntime.FlowInstance, { executionId } as unknown as FlowRuntime.FlowInstance["Service"]),
    ))))
  expect(await step(Ask.open(database)(payload))).toEqual(Exit.succeed({ opened: true }))
  expect(await step(Ask.open(database)({ ...payload, prompt: "other" }))).toEqual(Exit.succeed({ opened: false }))
  expect((await rowOf(executionId))!.wait).toMatchObject({ prompt: PROMPT })
  expect(await step(Ask.settle(database)({ answer: ANSWER }))).toEqual(Exit.succeed({ answered: true, answer: ANSWER }))
  expect(await step(Ask.settle(database)({ answer: null }))).toEqual(Exit.succeed({ answered: false }))
  expect(await rowOf(executionId)).toMatchObject({ status: "done", answer: { value: ANSWER } })
  const down = Layer.effect(SqlClient.SqlClient, Effect.fail(new Error("unreachable")))
  const unavailable = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) && Cause.squash(exit.cause)
  expect(unavailable(await step(Ask.open(down)(payload)))).toEqual(new Ask.AskUnavailable())
  expect(unavailable(await step(Ask.settle(down)({ answer: ANSWER })))).toEqual(new Ask.AskUnavailable())
  expect(recorded.count({ op: "open", outcome: "existing" })).toBe(1)
  expect(recorded.count({ op: "open", outcome: "unavailable" })).toBe(1)
  expect(recorded.count({ op: "settle", outcome: "unavailable" })).toBe(1)
  expect(recorded.lines.filter((line) => line.message === "queue.ask.settle").at(-1)).toMatchObject({
    level: "WARN",
    annotations: { runId: executionId, outcome: "unavailable", errorCode: expect.any(String) },
  })
  expect(JSON.stringify(recorded.lines)).not.toContain("sentinel")
})
