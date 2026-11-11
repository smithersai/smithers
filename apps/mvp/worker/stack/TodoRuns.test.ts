import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Context, Effect, Exit, Layer, Schema } from "effect"
import { beforeEach, expect, test } from "vitest"
import { SqlClient } from "effect/sql"
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as ExecutionHost from "../ExecutionHost.ts"
import type * as Fleet from "../runners/Fleet.ts"
import { build } from "../test/flowHost.ts"
import * as Flows from "../Flows.vibe"
import * as Todo from "../flows/Todo.ts"
import * as TodoBaseClosed from "../flows/TodoBaseClosed.ts"
import * as TodoDrop from "../flows/TodoDrop.ts"
import * as Stack from "./Stack.ts"
import * as TodoRuns from "./TodoRuns.ts"
import { todoExecutionId } from "../../src/features/pulls/contract.ts"
import { testFile } from "../test/harness.ts"

const runtime = testFile("todo_admission")
beforeEach(() => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE stack_ops, todo_attempts, todo_requests, todo_leaves, todos, stacks`)))
const change = () => ({ opId: crypto.randomUUID(), repoId: "github/test/repo", actor: { id: "person", login: "person" }, via: "person" as const,
  op: { kind: "commit" as const, title: "private", prompt: "private", acceptance: [] } })

const memory = () => {
  const values = new Map<string, unknown>()
  let alarm: number | null = null
  const storage: ExecutionHost.Storage = {
    get: <A>(key: string) => Effect.sync(() => structuredClone(values.get(key)) as A | undefined),
    put: (key, value) => Effect.sync(() => void values.set(key, structuredClone(value))),
    delete: (key) => Effect.sync(() => values.delete(key)),
    setAlarm: (at) => Effect.sync(() => { alarm = at }),
    deleteAlarm: () => Effect.sync(() => { alarm = null }),
  }
  return { storage, values, alarm: () => alarm }
}

test("the production TODO adapter sends drop to durable cancellation, even before start arrives", () => runtime.runPromise(Effect.gen(function* () {
  const c = change()
  const result = yield* Stack.apply(c, { runs: true })
  if (result.kind !== "applied") throw new Error("not applied")
  const attempt = result.receipt.starts[0]!
  const objects = new Map<string, ReturnType<typeof memory>>()
  const database = yield* TestDatabase.Scratch
  const object = (id: string) => {
    if (!objects.has(id)) objects.set(id, memory())
    return objects.get(id)!
  }
  const host = (id: string) => ExecutionHost.make(object(id).storage, {
    hostId: "todo-object", database: database.database.pipe(Layer.orDie), flows: { flows: [], registration: Layer.empty },
    router: { start: () => Effect.void, wake: () => Effect.void },
  })
  const runs = TodoRuns.make({ start: (flow, options) => ExecutionHost.intent(flow, options as never).pipe(
    Effect.flatMap(host(options.executionId).start), Effect.orDie
  ) }, (id) => host(id).cancel())
  yield* runs.stop(attempt)
  const o = object(`todo:${attempt.attemptId}`)
  expect(o.values.has("smithers/cancelled")).toBe(true)
  const cleanup = object(`todo-drop:${attempt.attemptId}`)
  expect(JSON.parse(cleanup.values.get("smithers/intent") as string)).toMatchObject({ flow: TodoDrop.Drop._tag, payload: { attemptId: attempt.attemptId, todoId: attempt.todoId } })
  yield* runs.stop(attempt)
  expect(objects.size).toBe(3)
  const invalidation = object(`todo-base-closed:${attempt.attemptId}`)
  expect(JSON.parse(invalidation.values.get("smithers/intent") as string)).toMatchObject({
    flow: TodoBaseClosed.Invalidate._tag, payload: { attemptId: attempt.attemptId, todoId: attempt.todoId, baseClosed: true },
  })
  yield* runs.start(attempt)
  expect(o.alarm()).not.toBeNull()
})))

test("a cancel the run's object refuses still starts the pull request's cleanup, and answers unavailable", () => runtime.runPromise(Effect.gen(function* () {
  // Production 2026-10-31: T112's cancel failed (`cloudflare.execution.cancel`, JournalError) and nothing started
  // `todo/Drop`, so pull request #122 stayed open.
  const attempt = { attemptId: crypto.randomUUID(), todoId: crypto.randomUUID(), repoId: "github/test/repo", number: 1, ordinal: 1, revision: 1 }
  const started: Array<string> = []
  const runs = TodoRuns.make(
    { start: (_flow, options) => Effect.sync(() => void started.push(options.executionId)) },
    () => Effect.fail(new Error("journal unavailable")),
  )
  expect(yield* Effect.flip(runs.stop(attempt))).toEqual(new Stack.RunsUnavailable({ errorCode: "unknown" }))
  expect(started).toEqual([`todo-base-closed:${attempt.attemptId}`, `todo-drop:${attempt.attemptId}`])
})))

test("admission reads the current attempt and refuses an already dropped TODO", () => runtime.runPromise(Effect.gen(function* () {
  const c = change()
  const result = yield* Stack.apply(c, { runs: true })
  if (result.kind !== "applied") throw new Error("not applied")
  const attempt = result.receipt.starts[0]!
  expect(yield* TodoRuns.mayStart(attempt)).toBe(true)
  const intent = yield* ExecutionHost.intent(Todo.Todo, { executionId: `todo:${attempt.attemptId}`, payload: attempt })
  expect(yield* TodoRuns.canStart(intent)).toBe(true)
  expect(yield* TodoRuns.canStart({ ...intent, flow: "other", payload: {} })).toBe(true)
  expect(Exit.isFailure(yield* Effect.exit(TodoRuns.canStart({ ...intent, payload: {} })))).toBe(true)
  yield* Stack.report(attempt, { kind: "published", headSha: "a".repeat(40), prNumber: 1, draft: false }, { runs: true })
  expect(yield* TodoRuns.mayStart(attempt)).toBe(true)
  expect(yield* TodoRuns.mayStart({ ...attempt, ordinal: 99 })).toBe(false)
  expect(yield* TodoRuns.mayStart({ ...attempt, attemptId: crypto.randomUUID() })).toBe(false)
  yield* Stack.apply({ ...c, opId: crypto.randomUUID(), op: { kind: "drop", number: attempt.number } }, { runs: true })
  expect(yield* TodoRuns.mayStart(attempt)).toBe(false)
  expect(yield* TodoRuns.canStart(intent)).toBe(false)
})))


test("start conflicts are idempotent, unavailable hosts propagate and cancellation defects are sanitized", () => runtime.runPromise(Effect.gen(function* () {
  const attempt = { attemptId: crypto.randomUUID(), todoId: crypto.randomUUID(), repoId: "github/test/repo", number: 1, ordinal: 1, revision: 1 }
  yield* TodoRuns.make({ start: () => Effect.fail(new Flows.StartConflict()) }, () => Effect.void).start(attempt)
  expect(yield* Effect.flip(TodoRuns.make({ start: () => Effect.fail(new Flows.StartUnavailable({ errorCode: "down" })) }, () => Effect.void).start(attempt)))
    .toEqual(new Stack.RunsUnavailable({ errorCode: "down" }))
  yield* TodoRuns.make({ start: () => Effect.fail(new Flows.StartConflict()) }, () => Effect.void).stop(attempt)
  expect(yield* Effect.flip(TodoRuns.make({ start: () => Effect.fail(new Flows.StartUnavailable({ errorCode: "down" })) }, () => Effect.void).stop(attempt)))
    .toEqual(new Stack.RunsUnavailable({ errorCode: "down" }))
  // Invalidation starts successfully, then the independent PR cleanup launch fails.
  expect(yield* Effect.flip(TodoRuns.make({ start: (flow) => flow._tag === TodoDrop.Drop._tag
    ? Effect.fail(new Flows.StartUnavailable({ errorCode: "cleanup_down" })) : Effect.void }, () => Effect.void).stop(attempt)))
    .toEqual(new Stack.RunsUnavailable({ errorCode: "cleanup_down" }))
  const adapter = TodoRuns.make({ start: () => Effect.void }, () => Effect.die(new Error("private-provider-message")))
  expect(yield* Effect.flip(adapter.stop(attempt))).toEqual(new Stack.RunsUnavailable({ errorCode: "unknown" }))
  const interrupted = TodoRuns.make({ start: () => Effect.void }, () => Effect.interrupt)
  expect(Exit.isFailure(yield* Effect.exit(interrupted.stop(attempt)))).toBe(true)
})))

test("the stopped-receipt adapter propagates an unreadable engine database instead of treating it as not stopped", () => runtime.runPromise(Effect.gen(function* () {
  // This is the real app database, which has no engine tables: the engine schema is unavailable.
  const scratch = yield* TestDatabase.Scratch
  const adapter = TodoRuns.make({ start: () => Effect.void }, () => Effect.void, TodoRuns.isStopped(scratch.database.pipe(Layer.orDie)))
  const exit = yield* Effect.exit(adapter.isStopped!(crypto.randomUUID()))
  expect(Exit.isFailure(exit)).toBe(true)
  expect(JSON.stringify(exit)).toContain("@smthrs/mvp/stack/RunsUnavailable")
})))

/** A step that dies, as `agent/Session`'s replay did when the engine's writer gave up (`DatabaseError` `busy`). */
const Crash = Action.make("todo-runs-test/Crash", { payload: { fail: Schema.Boolean }, success: Schema.String })
/** A run that dies when asked to, standing in for a TODO's `todo` run under its execution id. */
const Dies = Flow.make("todo-runs-test/Dies", {
  description: "A run that dies.",
  modelInvocable: false,
  payload: { fail: Schema.Boolean },
  success: Schema.String,
  body: Node.capture({}, ({ fail }) => Crash.call({ fail })),
})
const dying = Layer.mergeAll(
  Crash.toLayer(({ fail }) => fail ? Effect.die(new Error("busy")) : Effect.succeed("done")),
  Interpreter.layer(Dies, { callbackIdentity: "stable" }),
).pipe(Layer.provideMerge(Action.layerImplementations))

test("a run that died stops its external agent: a queued generation ends, a claimed one is told at its heartbeat", () =>
  runtime.runPromise(Effect.scoped(Effect.gen(function* () {
    const committed = yield* Stack.apply(change(), { runs: true })
    if (committed.kind !== "applied") throw new Error("not applied")
    const { attemptId } = committed.receipt.starts[0]!
    const executionId = todoExecutionId(attemptId)
    const sql = yield* SqlClient.SqlClient
    const task = JSON.stringify({ context: { attemptId } })
    yield* sql`
      INSERT INTO agent_jobs (key, origin, generation, repo_id, agent, profile, labels, task, status, claim, lease_until, deadline_at)
      VALUES
        ('agent#g1', 'agent', 1, 'r', 'a', 'p', '{}', ${task}::jsonb, 'claimed', gen_random_uuid(), now(), now() + interval '1 hour'),
        ('agent#g2', 'agent', 2, 'r', 'a', 'p', '{}', ${task}::jsonb, 'queued', NULL, NULL, now() + interval '1 hour')`
    const { context, engine } = yield* build(dying)
    const engineDatabase = ExecutionHost.readDatabase((yield* TestDatabase.serverUrl).toString(), engine.schema)
    yield* Effect.exit(Context.get(context, FlowRuntime.FlowRuntime).execute(Dies, { executionId, payload: { fail: true } }))
      .pipe(Effect.provide(context))
    const raised: Array<Fleet.Alert> = []
    yield* TodoRuns.settleCrashed(executionId, engineDatabase, (alert) => Effect.sync(() => void raised.push(alert)))
    expect(yield* sql`SELECT key, status, cancel_requested FROM agent_jobs ORDER BY key`).toEqual([
      { key: "agent#g1", status: "claimed", cancel_requested: true },
      { key: "agent#g2", status: "cancelled", cancel_requested: true },
    ])
    // The fleet's Run failed alert: `todo/Fail` never ran. The id is the incident, so a second report starts no second one.
    expect(raised.map((alert) => [alert.kind, alert.subject])).toEqual([["failed", attemptId]])
  }))), 60_000)

test("a TODO whose run died fails `crashed` and frees its lane, once; a run that ended any other way changes nothing", () =>
  runtime.runPromise(Effect.scoped(Effect.gen(function* () {
    // Production 2026-11-01: two TODO runs died seconds after their agents settled Done, and the TODOs stayed Working.
    // One independent lane: the second TODO waits for the first's lane, not on its branch.
    yield* Stack.apply({ ...change(), op: { kind: "configure", lanes: 1, maxOpen: 50, base: "independent" } }, { runs: true })
    const committed = yield* Stack.apply(change(), { runs: true })
    yield* Stack.apply(change(), { runs: true })
    if (committed.kind !== "applied") throw new Error("not applied")
    const first = committed.receipt.starts[0]!
    const { context, engine } = yield* build(dying)
    const engineDatabase = ExecutionHost.readDatabase((yield* TestDatabase.serverUrl).toString(), engine.schema)
    const run = (executionId: string, fail: boolean) =>
      Effect.exit(Context.get(context, FlowRuntime.FlowRuntime).execute(Dies, { executionId, payload: { fail } }))
    const settled = (executionId: string) => TodoRuns.settleCrashed(executionId, engineDatabase)
    const todos = Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql<{ readonly number: number; readonly state: string; readonly failure: string | null }>`
        SELECT number, state, failure FROM todos ORDER BY number`)

    yield* run(todoExecutionId(first.attemptId), true).pipe(Effect.provide(context))
    expect(yield* engine.status(todoExecutionId(first.attemptId))).toBe("failed")
    expect(yield* todos).toEqual([
      { number: 1, state: "working", failure: null },
      { number: 2, state: "queued", failure: null },
    ])
    const starts = yield* settled(todoExecutionId(first.attemptId))
    expect(yield* todos).toEqual([
      { number: 1, state: "failed", failure: "crashed" },
      { number: 2, state: "working", failure: null },
    ])
    expect(starts).toHaveLength(1)
    // The alarm that forgets the run reports again: the same starts, and nothing else changes.
    expect(yield* settled(todoExecutionId(first.attemptId))).toEqual(starts)

    // The next TODO's run completes: its TODO is the run's own to settle. Any other run is not a TODO's.
    yield* run(todoExecutionId(starts[0]!.attemptId), false).pipe(Effect.provide(context))
    expect(yield* settled(todoExecutionId(starts[0]!.attemptId))).toEqual([])
    expect(yield* settled(`repo-refresh:${crypto.randomUUID()}`)).toEqual([])
    const missing = todoExecutionId(crypto.randomUUID())
    yield* run(missing, true).pipe(Effect.provide(context))
    expect(yield* settled(missing)).toEqual([])
    expect((yield* todos)[1]).toEqual({ number: 2, state: "working", failure: null })
  }))), 60_000)
