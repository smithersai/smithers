import { TestSchemas } from "@smthrs/database"
// Terminal actions on real Postgres and the Durable Object host. Only remote admission is fault-injected;
// its adapter is the production adapter, and successful starts reach the real target host's durable storage.
import * as Pg from "@effect/sql-pg"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Metric, Redacted, Tracer } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { todoExecutionId } from "../../src/features/pulls/contract.ts"
import * as ExecutionHost from "../ExecutionHost.ts"
import { REPOSITORY, services as githubServices } from "../github/test/fixtures.ts"
import { scriptedGitHub } from "../github/test/scriptedGitHub.ts"
import * as Stack from "../stack/Stack.ts"
import { testFile } from "../test/harness.ts"
import * as Todo from "./Todo.ts"

const runtime = testFile("todo_recovery")
beforeEach(() => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql`TRUNCATE stack_ops, todo_attempts, todo_requests, todo_leaves, todos, stacks`)))

const Settlement = Flow.make("probe/TodoSettlement", {
  payload: Todo.Settle.payloadSchema, success: Todo.Ran, error: Todo.TodoUnavailable,
  body: Node.capture({ settle: Todo.Settle.name }, (payload) => Todo.Settle.call(payload)),
})
const Failure = Flow.make("probe/TodoFailure", {
  payload: Todo.Fail.payloadSchema, success: Todo.Ran, error: Todo.TodoUnavailable,
  body: Node.capture({ fail: Todo.Fail.name }, (payload) => Todo.Fail.call(payload)),
})

const memory = () => {
  const values = new Map<string, unknown>()
  let alarm = 0
  const storage: ExecutionHost.Storage = {
    get: <A>(key: string) => Effect.sync(() => structuredClone(values.get(key)) as A | undefined),
    put: (key, value) => Effect.sync(() => void values.set(key, structuredClone(value))),
    delete: (key) => Effect.sync(() => values.delete(key)),
    setAlarm: (at) => Effect.sync(() => void (alarm = at)),
    deleteAlarm: () => Effect.sync(() => void (alarm = 0)),
  }
  return { values, storage, alarm: () => alarm }
}

const started = () => runtime.runPromise(Effect.gen(function* () {
  const starts: Array<Stack.AttemptStart> = []
  for (const title of ["First", "Second", "Third"]) {
    const receipt = yield* Stack.apply({
      opId: crypto.randomUUID(), repoId: REPOSITORY.id, actor: { id: "person-maya", login: "maya" }, via: "person",
      op: { kind: "commit", title, prompt: title, acceptance: [] },
    }, { runs: true })
    if (receipt.kind === "applied") starts.push(...receipt.receipt.starts)
  }
  return starts[0]!
}))

test("admission records the execution and sanitized failure; interruption remains interruption", async () => {
  const sentinel = "secret-and-payload-sentinel"
  const lines: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const spans: Array<Tracer.NativeSpan> = []
  const registry: Metric.MetricRegistry = new Map()
  const executionId = todoExecutionId(crypto.randomUUID())
  await Effect.runPromise(Effect.gen(function* () {
    const failed = yield* Effect.exit(Todo.admission(() => Effect.fail(new Error(sentinel)))(Todo.Todo, {
      executionId, payload: { sentinel },
    }))
    expect(Exit.isFailure(failed) && Cause.squash(failed.cause)).toMatchObject({ errorCode: "unknown" })
    const interrupted = yield* Effect.exit(Todo.admission(() => Effect.interrupt)(Todo.Todo, {
      executionId, payload: { sentinel },
    }))
    expect(Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause)).toBe(true)
    expect((yield* Metric.value(Metric.withAttributes(Todo.admissions, { flow: "todo", outcome: "not_started" }))).count).toBe(1)
  }).pipe(
    Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((options) => void lines.push(Logger.formatStructured.log(options)))])),
    Effect.provideService(Metric.MetricRegistry, registry),
    Effect.provideService(Tracer.Tracer, Tracer.make({ span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    } })),
  ))
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ message: "todo.start", annotations: { executionId, outcome: "not_started", errorCode: "unknown" } })
  expect(spans.map((span) => span.name)).toEqual(["todo.start", "todo.start"])
  expect(JSON.stringify({ lines, spans: spans.map((span) => ({ attributes: [...span.attributes], events: span.events,
    failure: span.status._tag === "Ended" && Exit.isFailure(span.status.exit) ? Cause.pretty(span.status.exit.cause) : null })) })).not.toContain(sentinel)
})

test.each(["merged", "dropped", "failed"] as const)("%s retries same-process admission without losing the successor", async (state) => {
  const request = await started()
  const { services } = await githubServices(runtime, scriptedGitHub(REPOSITORY.owner, REPOSITORY.name))
  const calls: Array<{ executionId: string; payload: unknown }> = []
  const steps = Todo.steps({ ...services, start: Todo.admission((_flow, options) => Effect.suspend(() => {
    calls.push(options)
    return calls.length === 1 ? Effect.fail(new Stack.RunsUnavailable({ errorCode: "admission_down" })) : Effect.void
  })) })
  const action = (): Effect.Effect<Todo.Ran, Todo.TodoUnavailable> => state === "failed"
    ? steps.fail({ request, error: new Todo.TodoFailed({ failure: "implement" }) })
    : steps.settle({ request, awaited: { state: state === "merged" ? "merged" : "closed", mergeSha: null } })
  if (state !== "merged") {
    expect(await runtime.runPromise(action())).toEqual({ state })
    expect(await runtime.runPromise(action())).toEqual({ state })
    expect(calls).toEqual([])
    expect(await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`SELECT state, attempt FROM todos ORDER BY number`))).toEqual([
      { state, attempt: 1 },
      { state: state === "failed" ? "queued" : "failed", attempt: 0 },
      // The third stacks on the second: it waits behind it, failed or not (decision 0135).
      { state: "queued", attempt: 0 },
    ])
    return
  }
  const first = await runtime.runPromise(Effect.exit(action()))
  expect(Exit.isFailure(first) && Cause.squash(first.cause)).toMatchObject({ step: "settle" })
  expect(await runtime.runPromise(action())).toEqual({ state })
  expect(await runtime.runPromise(action())).toEqual({ state })
  expect(calls).toHaveLength(3)
  expect(calls[1]).toEqual(calls[0])
  expect(calls[2]).toEqual(calls[0])
  expect(new Set(calls.map((call) => call.executionId)).size).toBe(1)
  expect(await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`SELECT state, attempt FROM todos ORDER BY number`))).toEqual([
    { state, attempt: 1 }, { state: "working", attempt: 1 }, { state: "queued", attempt: 0 },
  ])
})

test.each([
  ["merged", "before"], ["merged", "after"], ["merged", "report"],
  ["dropped", "before"], ["dropped", "after"], ["dropped", "report"],
  ["failed", "before"], ["failed", "after"], ["failed", "report"],
] as const)("%s survives a host restart at the %s admission boundary", async (state, boundary) => {
  const request = await started()
  const { services } = await githubServices(runtime, scriptedGitHub(REPOSITORY.owner, REPOSITORY.name))
  const lines: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const logger = Logger.make((options) => void lines.push(Logger.formatStructured.log(options)))
  const registry: Metric.MetricRegistry = new Map()
  let stage = "building schema"
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const url = (yield* TestDatabase.serverUrl).toString()
    const admin = yield* Layer.build(Pg.PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }))
    const sql = Context.get(admin, SqlClient.SqlClient)
    const name = TestSchemas.schemaName("flows")
    yield* Effect.addFinalizer(() => Effect.orDie(sql`DROP SCHEMA IF EXISTS ${sql(name)} CASCADE`))
    const object = memory()
    const targets = new Map<string, ReturnType<typeof memory>>()
    const calls: Array<string> = []
    const retrying = yield* Deferred.make<void>()
    const executionId = crypto.randomUUID()
    let healthy = false
    const start = Todo.admission((flow, options) => Effect.gen(function* () {
      calls.push(options.executionId)
      if (!healthy && calls.length > 1) {
        yield* Deferred.succeed(retrying, undefined)
        return yield* Effect.never
      }
      if (!healthy && boundary !== "after") return yield* new Stack.RunsUnavailable({ errorCode: "admission_down" })
      const target = targets.get(options.executionId) ?? memory()
      targets.set(options.executionId, target)
      const host = ExecutionHost.make(target.storage, {
        hostId: `object-${options.executionId}`, database: ExecutionHost.database(url, name),
        flows: { flows: [Todo.Todo], registration: Layer.empty },
        router: { start: () => Effect.void, wake: () => Effect.void },
      })
      yield* host.start(yield* ExecutionHost.intent(flow, options as never))
      // The target durably accepted it, but the source lost the acknowledgment.
      if (!healthy) return yield* new Stack.RunsUnavailable({ errorCode: "admission_ack_lost" })
    }))
    const make = () => {
      const steps = Todo.steps({ ...services, start })
      const registration = Layer.mergeAll(
        Interpreter.layerWithImplementations(Settlement, Todo.Settle.toLayer(steps.settle)),
        Interpreter.layerWithImplementations(Failure, Todo.Fail.toLayer(steps.fail)),
      ).pipe(Layer.provideMerge(Action.layerImplementations))
      return ExecutionHost.make(object.storage, {
        hostId: `object-${executionId}`, database: ExecutionHost.database(url, name),
        flows: { flows: [Settlement, Failure], registration },
        router: { start: () => Effect.void, wake: () => Effect.void },
      })
    }
    if (boundary === "report") {
      yield* Stack.report(request, {
        kind: "finished", state,
        ...(state === "failed" ? { failure: "implement" as const } : {}),
        ...(state === "dropped" ? { note: "closed_on_github" as const } : {}),
      }, { runs: true }).pipe(Effect.provide(services.database))
    }
    const host = make()
    const intent = state === "failed"
      ? yield* ExecutionHost.intent(Failure, { executionId, payload: { request, error: new Todo.TodoFailed({ failure: "implement" }) } })
      : yield* ExecutionHost.intent(Settlement, { executionId, payload: { request, awaited: { state: state === "merged" ? "merged" : "closed", mergeSha: null } } })
    stage = "initial start"
    yield* host.start(intent)
    if (state !== "merged") {
      expect((yield* host.alarm())._tag).toBe("Settled")
      const restarted = make()
      yield* restarted.start(intent)
      yield* restarted.alarm()
      expect(calls).toEqual([])
      expect(targets.size).toBe(0)
      expect(yield* Effect.flatMap(SqlClient.SqlClient, (client) =>
        client`SELECT state, attempt FROM todos ORDER BY number`).pipe(Effect.provide(services.database))).toEqual([
        { state, attempt: 1 },
        { state: state === "failed" ? "queued" : "failed", attempt: 0 },
        // The third stacks on the second: it waits behind it, failed or not (decision 0135).
        { state: "queued", attempt: 0 },
      ])
      return
    }
    stage = "first alarm"
    // The engine retries inline during an active drive. Kill that host after the first failure is recorded,
    // while its next admission is unresolved, as an isolate reset would. No app timer or retry drives it.
    const driving = yield* Effect.forkChild(host.alarm())
    yield* Deferred.await(retrying)
    yield* Fiber.interrupt(driving)
    expect(calls).toHaveLength(2)
    healthy = true
    // New host and implementations; only the object storage and Postgres survive.
    const restarted = make()
    stage = "restart alarm"
    let driven = yield* restarted.alarm()
    for (let drives = 1; driven._tag !== "Settled" && drives < 10; drives++) {
      yield* Effect.sleep(Math.max(0, object.alarm() - Date.now()))
      driven = yield* restarted.alarm()
    }
    expect(driven._tag).toBe("Settled")
    const [run] = yield* sql<{ status: string }>`SELECT status FROM ${sql(name)}.flows_runs WHERE run_id = ${executionId}`
    expect(run!.status).toBe("completed")
    expect(calls).toHaveLength(3)
    expect(new Set(calls).size).toBe(1)
    expect(targets.size).toBe(1)
    const [attempt] = yield* Effect.flatMap(SqlClient.SqlClient, (client) =>
      client<{ id: string }>`SELECT id FROM todo_attempts WHERE todo_id <> ${request.todoId}::uuid`)
      .pipe(Effect.provide(services.database))
    expect(calls[0]).toBe(todoExecutionId(attempt!.id))
    expect(yield* Effect.flatMap(SqlClient.SqlClient, (client) =>
      client`SELECT state, attempt FROM todos ORDER BY number`).pipe(Effect.provide(services.database))).toEqual([
      { state, attempt: 1 }, { state: "working", attempt: 1 }, { state: "queued", attempt: 0 },
    ])
    const before = calls.length
    yield* restarted.start(intent)
    yield* restarted.alarm()
    expect(calls).toHaveLength(before)
    expect(lines.some((line) => line.message === "todo.start" && line.annotations.outcome === "not_started")).toBe(true)
    expect(lines.some((line) => line.message === "todo.start" && line.annotations.outcome === "started")).toBe(true)
    expect((yield* Metric.value(Metric.withAttributes(Todo.admissions, { flow: "todo", outcome: "started" }))).count).toBe(1)
  }).pipe(
    Effect.timeout("20 seconds"),
    Effect.tapError(() => Effect.sync(() => console.error("TODO recovery failed at", stage, lines.slice(-8)))),
    Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
    Effect.provideService(Metric.MetricRegistry, registry),
  )))
})
