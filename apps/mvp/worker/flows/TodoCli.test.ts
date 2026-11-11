// Subscription-agent failures through the shipped registration on the real durable engine and app database.
// Only failing external services are injected; no machine ever returns a fabricated successful command.
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { EngineStore } from "@smthrs/flows"
import { Node } from "@smthrs/plan"
import { SandboxTools } from "@smthrs/sandbox"
import { Cause, Context, Effect, Exit, Layer, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { ConnectionError, SqlError } from "effect/sql/SqlError"
import { beforeEach, expect, test } from "vitest"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as ExecutionHost from "../ExecutionHost.ts"
import { Machines } from "../branch/Machines.vibe"
import { SandboxUnavailable } from "../branch/Sandboxes.vibe"
import * as Codex from "../personal/Codex.ts"
import { KEY, seedKeys } from "../personal/test/harness.ts"
import { SecretKeys } from "../secrets/Keys.ts"
import * as Stack from "../stack/Stack.ts"
import { build, runFlow } from "../test/flowHost.ts"
import { eventually, testFile } from "../test/harness.ts"
import * as Box from "../test/box.ts"
import * as SandboxCommand from "./SandboxCommand.ts"
import * as TodoCli from "./TodoCli.ts"

const runtime = testFile("todo_cli_edges")
beforeEach(() => runtime.runPromise(Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`TRUNCATE stack_ops, todo_attempts, todo_requests, todo_leaves, todos, stacks, personal_models CASCADE`
})))
const repoId = "github/acme/widgets"
const ownerId = "person-coder"
const Route = Flow.make("test/CliRoute", {
  payload: { ownerId: Schema.String }, success: TodoCli.Routed, error: TodoCli.RouteUnavailable,
  body: Node.capture({}, (payload) => TodoCli.Route.call(payload)),
})
const Implement = Flow.make("test/CliImplement", {
  payload: TodoCli.ImplementCli.payloadSchema.fields,
  success: TodoCli.ImplementCli.successSchema,
  error: TodoCli.ImplementCli.errorSchema,
  body: Node.capture({}, (payload) => TodoCli.ImplementCli.call(payload)),
})

const failure = new SqlError({ reason: new ConnectionError({ cause: "injected outage", message: "unavailable", operation: "execute" }) })
const down = Layer.effect(SqlClient.SqlClient, Effect.fail(failure))
const unreachable = () => Effect.fail(new SandboxUnavailable({ reason: "exec" }))
const machines = Layer.succeed(Machines, Machines.of({
  commands: () => ({ start: () => Effect.fail(new SandboxTools.ToolLost()), observe: unreachable, collect: unreachable, cancel: unreachable }),
  tool: unreachable,
  sleepIfIdle: unreachable,
}))
const database = () => runtime.runPromise(Effect.map(TestDatabase.Scratch, (scratch) => scratch.database))
const registration = (db: Layer.Layer<SqlClient.SqlClient, unknown>, keys = false, fetch = globalThis.fetch, host = machines) => {
  const declared = keys
    ? TodoCli.registration(db, 1, 1, Layer.merge(SecretKeys.layer(KEY), Layer.succeed(Codex.CodexAuth, { origin: "http://127.0.0.1:1", clientId: "test-client" })))
    : TodoCli.registration(db, 1, 1)
  return Layer.mergeAll(declared, SandboxCommand.registration, Interpreter.layer(Route), Interpreter.layer(Implement)).pipe(
    Layer.provideMerge(Action.layerImplementations), Layer.provide(host), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  )
}

const attempt = async () => {
  const result = await runtime.runPromise(Stack.apply({
    opId: crypto.randomUUID(), repoId, actor: { id: ownerId, login: "coder" }, via: "person",
    op: { kind: "commit", title: "Inspect", prompt: "Inspect the repository", acceptance: [] },
  }, { runs: true }))
  if (result.kind !== "applied") throw new Error("not applied")
  const request = result.receipt.starts[0]!
  await runtime.runPromise(Stack.report(request, { kind: "branch", branch: "work", baseRef: "main", baseSha: "a".repeat(40) }, { runs: true }))
  return { request, executionId: `todo:${request.attemptId}`, payload: {
    attemptId: request.attemptId, todoId: request.todoId, repoId, number: request.number, title: "Inspect", prompt: "Inspect the repository", acceptance: [], branch: "work", agent: "claude-code" as const,
  } }
}

const reason = (exit: Exit.Exit<unknown, unknown>) => Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined

test("a CLI run without its attempt's machine fails no_machine through the default credentials layer", async () => {
  const payload = { attemptId: crypto.randomUUID(), todoId: crypto.randomUUID(), repoId, number: 1, title: "Inspect", prompt: "Inspect", acceptance: [], branch: "work", agent: "claude-code" as const }
  const ran = await runFlow(Implement, payload, registration(await database()))
  expect(reason(ran.exit)).toEqual(new TodoCli.AgentCliFailed({ reason: "no_machine" }))
})

test("a machine whose host has no secret keys refuses the CLI before any command runs", async () => {
  const a = await attempt()
  const ran = await runFlow(Implement, a.payload, registration(await database()), { executionId: a.executionId })
  expect(reason(ran.exit)).toEqual(new TodoCli.AgentCliFailed({ reason: "no_credential" }))
})

test("a corrupt Codex credential is a non-retryable no_credential, without contacting its auth server", async () => {
  const a = await attempt()
  await seedKeys(runtime, ownerId, [{ kind: "codex_subscription", key: "not a credential" }])
  let calls = 0
  const fetch: typeof globalThis.fetch = () => { calls++; return Promise.reject(new Error("network unavailable")) }
  const ran = await runFlow(Implement, { ...a.payload, agent: "codex" }, registration(await database(), true, fetch), { executionId: a.executionId })
  expect(reason(ran.exit)).toEqual(new TodoCli.AgentCliFailed({ reason: "no_credential" }))
  expect(calls).toBe(0)
})

// The actual retry policy remains in force: inspect its durable failure receipt, then cancel the real run.
const unavailable = (flow: typeof Route | typeof Implement, payload: unknown, registered: ReturnType<typeof registration>, executionId: string) =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { context, engine } = yield* build(registered)
    const flows = Context.get(context, FlowRuntime.FlowRuntime)
    const server = yield* TestDatabase.serverUrl
    const reader = ExecutionHost.readDatabase(server.toString(), engine.schema)
    const read = Effect.flatMap(EngineStore.RunInspection.RunInspection, (reads) => reads.inspect(executionId)).pipe(
      Effect.provide(EngineStore.RunInspection.layerWith({ flows: [Route, Implement] })),
      Effect.provide(reader),
    )
    // Node settlements are published only after retries end; an active retry's receipt is in flows_attempts.
    const failedAttempt = Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ failed: boolean }>`
      SELECT EXISTS (SELECT 1 FROM flows_attempts WHERE run_id = ${executionId}
        AND error_json LIKE '%@smthrs/mvp/todo/RouteUnavailable%') AS failed`).pipe(
      Effect.map((rows) => rows[0]!.failed), Effect.provide(reader),
    )
    yield* (flows.execute(flow as never, { executionId, payload: payload as never, discard: true }) as Effect.Effect<unknown, unknown>).pipe(Effect.provide(context))
    yield* Effect.promise(() => eventually(async () => {
      return Effect.runPromise(failedAttempt)
    }, 10_000))
    yield* flows.interrupt(flow as never, executionId).pipe(Effect.provide(context))
    yield* Effect.promise(() => eventually(async () => (await Effect.runPromise(engine.status(executionId))) === "cancelled", 10_000))
    const inspected = yield* read
    expect(inspected.run.status).toBe("cancelled")
    expect(yield* failedAttempt).toBe(true)
  })))

test("an unreadable route records RouteUnavailable and remains cancellable under its real retry policy", () =>
  unavailable(Route, { ownerId }, registration(down), crypto.randomUUID()))

test("an unreadable attempt records RouteUnavailable and remains cancellable", () => {
  const payload = { attemptId: crypto.randomUUID(), todoId: crypto.randomUUID(), repoId, number: 1, title: "Inspect", prompt: "Inspect", acceptance: [], branch: "work", agent: "claude-code" }
  return unavailable(Implement, payload, registration(down, true), `todo:${payload.attemptId}`)
})

test("a Codex refresh transport failure records unavailable instead of deleting its credential", async () => {
  const a = await attempt()
  await seedKeys(runtime, ownerId, [{ kind: "codex_subscription", key: JSON.stringify({
    accessToken: "access-sentinel", refreshToken: "refresh-sentinel", idToken: "id-sentinel", accountId: "account", planType: "plus", expiresAt: 0,
  }) }])
  let calls = 0
  const fetch: typeof globalThis.fetch = () => { calls++; return Promise.reject(new Error("network unavailable")) }
  await unavailable(Implement, { ...a.payload, agent: "codex" }, registration(await database(), true, fetch), a.executionId)
  expect(calls).toBeGreaterThan(0)
})

test("a machine that cannot start its CLI command ends the step as lost", async () => {
  const a = await attempt()
  const ran = await runFlow(Implement, a.payload, registration(await database(), true), { executionId: a.executionId })
  expect(reason(ran.exit)).toEqual(new TodoCli.AgentCliFailed({ reason: "lost" }))
})

test("a machine whose CLI process exceeds its command budget records timeout from its actual process result", async () => {
  const a = await attempt()
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "todo-cli-timeout-")))
  const real = Box.machinesOn(Box.boxAt({ workdir: directory, homes: directory }).box)
  // Faulty machine: launch a real stuck process instead of the CLI; the shipped command driver times it out.
  const slow = Layer.succeed(Machines, { ...real, commands: (...args) => {
    const commands = real.commands(...args)
    return { ...commands, start: (call, key) => commands.start({ ...call, command: "sleep 600" }, key) }
  } } satisfies Machines["Service"])
  try {
    const ran = await runFlow(Implement, a.payload, registration(await database(), true, globalThis.fetch, slow), { executionId: a.executionId })
    expect(reason(ran.exit)).toEqual(new TodoCli.AgentCliFailed({ reason: "timeout" }))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
