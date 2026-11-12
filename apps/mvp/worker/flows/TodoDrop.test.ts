import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { GitHub } from "@smthrs/integrations"
import { Cause, Context, Deferred, Effect, Exit, Layer, Logger, Metric, Schema, Scope, Tracer } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { todoExecutionId } from "../../src/features/pulls/contract.ts"
import * as ExecutionHost from "../ExecutionHost.ts"
import { REPOSITORY, reset, services as githubServices, sql } from "../github/test/fixtures.ts"
import { scriptedGitHub } from "../github/test/scriptedGitHub.ts"
import * as Stack from "../stack/Stack.ts"
import { build, runFlow } from "../test/flowHost.ts"
import { eventually, testFile } from "../test/harness.ts"
import * as Todo from "./Todo.ts"
import * as TodoDrop from "./TodoDrop.ts"

const runtime = testFile("todo_drop")
const actor = { id: "person-maya", login: "maya" }
beforeEach(async () => {
  await reset(runtime)
  await sql(runtime, "TRUNCATE stack_ops, todo_attempts, todo_requests, todo_leaves, todos, stacks, pulls, pull_commits, reviews, runs")
})

test.each(["unknown", "wrong-todo", "working", "stale", "no-pr"] as const)(
  "cleanup skips %s attempts without calling GitHub", async (kind) => {
    const ctx = await setup()
    if (kind !== "working") await ctx.drop()
    if (kind === "stale") await sql(runtime, `UPDATE todos SET attempt = attempt + 1 WHERE id = '${ctx.stop.todoId}'`)
    if (kind === "no-pr") await sql(runtime, `UPDATE todos SET pr_number = NULL WHERE id = '${ctx.stop.todoId}'`)
    const stop = kind === "unknown" ? { ...ctx.stop, attemptId: crypto.randomUUID() }
      : kind === "wrong-todo" ? { ...ctx.stop, todoId: crypto.randomUUID() } : ctx.stop
    const calls = ctx.github.calls.length
    expect(await runtime.runPromise(TodoDrop.cleanup(ctx.services)(stop))).toEqual({ outcome: "skipped" })
    expect(ctx.github.calls).toHaveLength(calls)
    expect(ctx.github.issues.get(ctx.pull.number)!.state).toBe("open")
  },
)

test("cleanup repeats safely and records only ids and outcomes", async () => {
  const ctx = await setup()
  ctx.github.push("unrelated", { "OTHER.md": "other\n" })
  const unrelated = ctx.github.openPull("unrelated")
  await ctx.drop()
  // The dropped close needs only the PR number; it must not attempt to reconstruct an unrecorded head.
  await sql(runtime, `UPDATE todos SET head_sha = NULL WHERE id = '${ctx.stop.todoId}'`)
  const registry: Metric.MetricRegistry = new Map()
  const lines: Array<unknown> = []
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({ span(options) {
    const span = new Tracer.NativeSpan(options)
    spans.push(span)
    return span
  } })
  const logger = Logger.make((options) => void lines.push(StructuredLogger.formatStructured.log(options)))
  const close = () => runtime.runPromise(TodoDrop.cleanup(ctx.services)(ctx.stop).pipe(
    Effect.provideService(Metric.MetricRegistry, registry),
    Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
    Effect.provideService(Tracer.Tracer, tracer),
  ))
  expect(await close()).toEqual({ outcome: "closed" })
  expect(await close()).toEqual({ outcome: "closed" })
  expect(ctx.github.issues.get(ctx.pull.number)!.state).toBe("closed")
  expect(ctx.github.issues.get(unrelated.number)!.state).toBe("open")
  expect(ctx.github.seen("PATCH", /\/pulls\/\d+$/)).toHaveLength(2)
  const count = runtime.runSync(Metric.value(Metric.withAttributes(TodoDrop.cleanups, { outcome: "closed" })).pipe(
    Effect.provideService(Metric.MetricRegistry, registry),
  ))
  expect(count.count).toBe(2)
  expect(lines).toHaveLength(2)
  expect(JSON.stringify(lines)).toContain(ctx.stop.attemptId)
  expect(JSON.stringify(lines)).not.toContain("Make a change")
  expect(spans.filter((span) => span.name === "todo.drop").map((span) => span.attributes.get("smithers.todo.attempt")))
    .toEqual([ctx.stop.attemptId, ctx.stop.attemptId])
  expect(await sql(runtime, "SELECT state, failure, pr_number FROM todos")).toEqual([
    { state: "dropped", failure: null, pr_number: ctx.pull.number },
  ])
})

test("Postgres failure and GitHub refusal remain visible as typed cleanup failures", async () => {
  const ctx = await setup()
  await ctx.drop()
  const databaseFailure = await runtime.runPromise(Effect.exit(TodoDrop.cleanup({
    ...ctx.services, database: Layer.effect(SqlClient.SqlClient, Effect.fail(new Error("database unavailable"))),
  })(ctx.stop)))
  expect(Exit.isFailure(databaseFailure) && Cause.squash(databaseFailure.cause)).toEqual(new Todo.TodoUnavailable({ step: "await" }))
  ctx.github.faults.push({ match: (method, path) => method === "PATCH" && path.endsWith(`/pulls/${ctx.pull.number}`), status: 422 })
  const refused = await runtime.runPromise(Effect.exit(TodoDrop.cleanup(ctx.services)(ctx.stop)))
  expect(Exit.isFailure(refused) && Cause.squash(refused.cause)).toEqual(new Todo.TodoFailed({ failure: "pr_refused" }))
  expect(ctx.github.issues.get(ctx.pull.number)!.state).toBe("open")
})

test.each(["unavailable", "lost"] as const)("the engine retries a %s close and deduplicates cleanup admission", { timeout: 120_000 }, async (fault) => {
  const ctx = await setup()
  await ctx.drop()
  ctx.github.faults.push({
    match: (method, path) => method === "PATCH" && path.endsWith(`/pulls/${ctx.pull.number}`),
    ...(fault === "lost" ? { lost: true } : { status: 503 }),
  })
  const scope = Effect.runSync(Scope.make())
  try {
    const { context } = await Effect.runPromise(build(TodoDrop.registration(ctx.services)).pipe(Effect.provideService(Scope.Scope, scope)))
    const flows = Context.get(context, FlowRuntime.FlowRuntime)
    const executionId = `todo-drop:${ctx.stop.attemptId}`
    const close = () => Effect.runPromise(flows.execute(TodoDrop.Drop, { executionId, payload: ctx.stop }).pipe(Effect.provide(context)))
    expect(await close()).toEqual({ outcome: "closed" })
    expect(ctx.github.issues.get(ctx.pull.number)!.state).toBe("closed")
    expect(ctx.github.seen("PATCH", /\/pulls\/\d+$/)).toHaveLength(2)
    expect(await close()).toEqual({ outcome: "closed" })
    expect(ctx.github.seen("PATCH", /\/pulls\/\d+$/)).toHaveLength(2)
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

const setup = async () => {
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  const { services } = await githubServices(runtime, github)
  const todoServices: Todo.Services<unknown, never> = { ...services, start: () => Effect.void }
  const applied = await runtime.runPromise(Stack.apply({
    opId: crypto.randomUUID(), repoId: REPOSITORY.id, actor, via: "person",
    op: { kind: "commit", title: "Change", prompt: "Make a change.", acceptance: [] },
  }, { runs: true }))
  if (applied.kind !== "applied") throw new Error("commit refused")
  const request = applied.receipt.starts[0]!
  github.push("feature", { "A.md": "a\n" })
  const pull = github.openPull("feature")
  const published = { headSha: github.refs.get("feature")!, prNumber: pull.number }
  await runtime.runPromise(Stack.report(request, { kind: "published", ...published, draft: false }, { runs: true }))
  const stop = { attemptId: request.attemptId, todoId: request.todoId }
  const drop = () => runtime.runPromise(Stack.apply({
    opId: crypto.randomUUID(), repoId: REPOSITORY.id, actor, via: "person", op: { kind: "drop", number: 1 },
  }, { runs: true }))
  return { github, services: todoServices, request, published, pull, stop, drop }
}

test("cancelling a dropped attempt still closes its recorded PR through durable cleanup", { timeout: 120_000 }, async () => {
  const ctx = await setup()
  const waiting = Flow.make("test/TodoAwait", {
    payload: Todo.TodoRequest, success: Todo.Awaited,
    error: Todo.Await.errorSchema,
    body: Node.capture({ await: Todo.Await.name, published: ctx.published }, (request) =>
      Todo.Await.call({ request, published: ctx.published })),
  })
  const registration = Interpreter.layerWithImplementations(waiting,
    Todo.Await.toLayer(Todo.steps(ctx.services).await),
  ).pipe(Layer.provideMerge(Action.layerImplementations))
  const scope = Effect.runSync(Scope.make())
  try {
    const { context, engine } = await Effect.runPromise(build(registration).pipe(Effect.provideService(Scope.Scope, scope)))
    const flows = Context.get(context, FlowRuntime.FlowRuntime)
    const executionId = crypto.randomUUID()
    await Effect.runPromise(flows.execute(waiting, { executionId, payload: ctx.request, discard: true }).pipe(Effect.provide(context)))
    await eventually(() => ctx.github.seen("GET", /\/pulls\/\d+$/).length > 0, 20_000)
    await ctx.drop()
    await Effect.runPromise(flows.interrupt(waiting, executionId).pipe(Effect.provide(context)))
    await eventually(async () => (await Effect.runPromise(engine.status(executionId))) === "cancelled", 20_000)
    expect(ctx.github.issues.get(ctx.pull.number)!.state).toBe("open")
    const cleaned = await runFlow(TodoDrop.Drop, ctx.stop, TodoDrop.registration(ctx.services))
    expect(cleaned.exit).toEqual(Exit.succeed({ outcome: "closed" }))
    expect(cleaned.status).toBe("completed")
    expect(ctx.github.issues.get(ctx.pull.number)!.state).toBe("closed")
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})

/** A dropped attempt whose publish opened its PR from `feature` but never reported it, beside an unmarked PR there. */
const unreported = async () => {
  const ctx = await setup()
  await ctx.drop()
  await sql(runtime, `UPDATE todos SET pr_number = NULL, head_sha = NULL WHERE id = '${ctx.stop.todoId}'`)
  await sql(runtime, `UPDATE todo_attempts SET branch = 'feature' WHERE id = '${ctx.stop.attemptId}'`)
  ctx.github.issues.get(ctx.pull.number)!.body = GitHub.Issues.withWriteMarker("Make a change.", Todo.pullKeyOf(ctx.stop.attemptId))
  const lookalike = ctx.github.openPull("feature", "Someone else's")
  return { ...ctx, lookalike }
}

test("cleanup closes the PR a dropped attempt's publish opened but never reported, by its key, once its run ended", async () => {
  const ctx = await unreported()
  const asked: Array<string> = []
  let ended = false
  const services = { ...ctx.services, runEnded: (executionId: string) => Effect.sync(() => (asked.push(executionId), ended)) }
  const calls = ctx.github.calls.length
  // Its publish may still be opening it: the step retries, and asks GitHub nothing yet.
  const running = await runtime.runPromise(Effect.exit(TodoDrop.cleanup(services)(ctx.stop)))
  expect(Exit.isFailure(running) && Cause.squash(running.cause)).toEqual(new Todo.TodoUnavailable({ step: "await" }))
  expect(ctx.github.calls).toHaveLength(calls)
  ended = true
  expect(await runtime.runPromise(TodoDrop.cleanup(services)(ctx.stop))).toEqual({ outcome: "closed" })
  expect(asked).toEqual([todoExecutionId(ctx.stop.attemptId), todoExecutionId(ctx.stop.attemptId)])
  expect(ctx.github.issues.get(ctx.pull.number)!.state).toBe("closed")
  // A PR from the same branch without the attempt's marker is not the attempt's.
  expect(ctx.github.issues.get(ctx.lookalike.number)!.state).toBe("open")
  expect(await sql(runtime, "SELECT state, pr_number FROM todos")).toEqual([{ state: "dropped", pr_number: null }])
})

test("cleanup of an unreported PR waits without the engine's answer and skips when the attempt opened none", async () => {
  const ctx = await unreported()
  const blind = await runtime.runPromise(Effect.exit(TodoDrop.cleanup(ctx.services)(ctx.stop)))
  expect(Exit.isFailure(blind) && Cause.squash(blind.cause)).toEqual(new Todo.TodoUnavailable({ step: "await" }))
  ctx.github.issues.get(ctx.pull.number)!.body = "Make a change."
  const services = { ...ctx.services, runEnded: () => Effect.succeed(true) }
  expect(await runtime.runPromise(TodoDrop.cleanup(services)(ctx.stop))).toEqual({ outcome: "skipped" })
  expect(ctx.github.seen("PATCH", /\/pulls\/\d+$/)).toHaveLength(0)
  expect(ctx.github.issues.get(ctx.pull.number)!.state).toBe("open")
})

test("runEnded reads the engine: a settled or unknown run has ended, a parked one has not", { timeout: 120_000 }, async () => {
  const Parked = Action.make("test/TodoDropParked", { payload: { park: Schema.Boolean }, success: Schema.Void })
  const probe = Flow.make("test/TodoDropProbe", {
    payload: { park: Schema.Boolean }, success: Schema.Void,
    body: Node.capture({ parked: Parked.name }, ({ park }) => Parked.call({ park })),
  })
  const parking = Effect.runSync(Deferred.make<void>())
  const registration = Interpreter.layerWithImplementations(probe,
    Parked.toLayer(({ park }) => park ? Deferred.await(parking) : Effect.void),
  ).pipe(Layer.provideMerge(Action.layerImplementations))
  const scope = Effect.runSync(Scope.make())
  try {
    const { context, engine } = await Effect.runPromise(build(registration).pipe(Effect.provideService(Scope.Scope, scope)))
    const ended = TodoDrop.runEnded(ExecutionHost.readDatabase((await Effect.runPromise(TestDatabase.serverUrl)).toString(), engine.schema))
    const flows = Context.get(context, FlowRuntime.FlowRuntime)
    const done = crypto.randomUUID()
    await Effect.runPromise(flows.execute(probe, { executionId: done, payload: { park: false } }).pipe(Effect.provide(context)))
    const parked = crypto.randomUUID()
    await Effect.runPromise(flows.execute(probe, { executionId: parked, payload: { park: true }, discard: true }).pipe(Effect.provide(context)))
    await eventually(async () => (await Effect.runPromise(engine.status(parked))) === "running", 20_000)
    expect(await Effect.runPromise(ended(done))).toBe(true)
    expect(await Effect.runPromise(ended(parked))).toBe(false)
    expect(await Effect.runPromise(ended(crypto.randomUUID()))).toBe(true)
    await Effect.runPromise(flows.interrupt(probe, parked).pipe(Effect.provide(context)))
    await eventually(async () => await Effect.runPromise(ended(parked)), 20_000)
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
})
