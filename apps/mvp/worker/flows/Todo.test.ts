// The `todo` run (worker/flows/Todo.ts, decision 0016's factory simplified) on the Node host's engine over this file's
// schema of the compose Postgres (`pnpm db:up`), against the scripted GitHub on the `HttpClient` seam. Two stand-ins,
// each a seam the run takes as an Effect service: the branch's machine is a test `Machines` over an in-memory working
// copy of the branch it checks out, and the model behind the agent's `agent` seat is scripted, while its admission and
// metering are the model endpoint's own (`ModelEndpoint.local`). The writer, the engine, the GitHub client, the tokens
// and the projection are the real ones.
import { Agent } from "@smthrs/agent"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter, WaitFor } from "@smthrs/flow"
import { Database as FlowsDatabase, Journal, RunStore } from "@smthrs/flows"
import { Node } from "@smthrs/plan"
import { Model, type ModelEvent } from "@smthrs/model"
import { HostModel } from "@smthrs/model-host"
import { Notification, NotificationQueue, SteerPayload } from "@smthrs/notifications"
import type { SandboxTools } from "@smthrs/sandbox"
import { Cause, ConfigProvider, Context, Effect, Exit, Fiber, Layer, Option, Redacted, Schedule, Schema, Scope, Stream } from "effect"
import { HttpClient } from "effect/http"
import { SqlClient } from "effect/sql"
import { ConnectionError, SqlError } from "effect/sql/SqlError"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, test } from "vitest"
import * as Database from "../../db/Database.ts"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { checkExecutionId, todoExecutionId } from "../../src/features/pulls/contract.ts"
import { Machines } from "../branch/Machines.ts"
import { noCommands } from "../test/commands.ts"
import { REPOSITORY, reset, services as githubServices, sql } from "../github/test/fixtures.ts"
import { BOT_LOGIN, scriptedGitHub } from "../github/test/scriptedGitHub.ts"
import * as Apply from "../github/Apply.ts"
import * as ExecutionHost from "../ExecutionHost.ts"
import * as ModelEndpoint from "../ModelEndpoint.ts"
import { PersonalModels } from "../personal/Models.ts"
import * as Stack from "../stack/Stack.ts"
import { build, runFlow } from "../test/flowHost.ts"
import * as Box from "../test/box.ts"
import { machines } from "../test/todoMachines.ts"
import { eventually, testFile } from "../test/harness.ts"
import { ChecksRun } from "./Checks.ts"
import * as SandboxCommand from "./SandboxCommand.ts"
import * as Todo from "./Todo.ts"
import * as TodoBaseClosed from "./TodoBaseClosed.ts"
import * as TodoAgent from "./TodoAgent.ts"
import * as TodoMachine from "./TodoMachine.ts"

const runtime = testFile("todo_run")
const boxes = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-todo-box-")))
afterAll(() => rmSync(boxes, { recursive: true, force: true }))
beforeEach(async () => {
  await reset(runtime)
  await sql(runtime, "TRUNCATE stack_ops, todo_attempts, todo_requests, todos, stacks, pulls, pull_commits, reviews, runs")
})

const maya = { id: "person-maya", login: "maya" }

/** What `todo/Begin` answers for a TODO on `branch` made from main. */
const onMain = (branch: string): Todo.Begun => ({
  branch,
  baseSha: "0".repeat(40),
  baseRef: "main",
  defaultBranch: "main",
  title: "Step",
  prompt: "Do it.",
  acceptance: [],
  issueNumber: null,
  ownerId: maya.id,
  ownerLogin: maya.login,
})

const database = () => runtime.runPromise(Effect.map(Effect.service(TestDatabase.Scratch), (scratch) => scratch.database))

/** Commits a TODO on a host that runs TODOs, as a person's press does; answers its first attempt's start. */
const commit = (title: string, prompt: string, issue?: number) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const opId = crypto.randomUUID()
      const applied = yield* Stack.apply({
        opId,
        repoId: REPOSITORY.id,
        actor: maya,
        via: "person",
        op: { kind: "commit", title, prompt, acceptance: [], ...(issue === undefined ? {} : { issue }) },
      }, { runs: true })
      return applied.kind === "applied" ? applied.receipt.starts[0] : undefined
    }),
  )

/** A TODO's row. */
const todo = async (number = 1) =>
  ((await sql(
    runtime,
    `SELECT state, step, branch, base_sha AS "baseSha", head_sha AS "headSha", pr_number AS "prNumber", failure, note,
      merge_sha AS "mergeSha", position FROM todos WHERE repo_id = '${REPOSITORY.id}' AND number = ${number}`,
  )) as unknown as Array<Record<string, unknown>>)[0]!

/** A model that answers each turn with the next cell, then the last one again. */
const cells = (...sources: ReadonlyArray<string>) => {
  let index = 0
  const requests: Array<string> = []
  const model = Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        requests.push(JSON.stringify(request.messages))
        const source = sources[Math.min(index++, sources.length - 1)]!
        return Stream.fromIterable<ModelEvent.ModelEvent>([
          { type: "text-delta", id: "t", text: "```cell\n" + source + "\n```" },
          { type: "usage", inputTokens: 10, outputTokens: 10 },
          { type: "settle", stopReason: "stop" },
        ])
      }),
  })
  return { model, requests }
}

/** The agent writes a line into README.md, runs the repository's check, and answers. */
const WRITES_README = [
  `await ctx.call("sandbox/write", { path: "README.md", content: "# Widgets\\n\\nA line\\n" })`,
  `const r = await ctx.call("sandbox/run", { command: "sh .smithers/checks/readme.sh" })`,
  `ctx.done({ summary: "Added a line; the check exited " + r.exitCode + "." })`,
].join("\n")

/** The `agent` seat over `model`, admitted and metered as the endpoint's calls are. */
const agentSeat = async (model: Model.Model) => {
  const local = await Effect.runPromise(
    ModelEndpoint.local(await database()).pipe(
      Effect.provide(PersonalModels.none),
      Effect.provideService(
        HostModel,
        HostModel.of({ modelId: "agent-model", model, route: { prepare: () => Effect.die(new Error("unused")) } }),
      ),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    ),
  )
  return local("agent")
}

/** Everything one run needs: the scripted GitHub, the machine, the agent, and the starts it asked its host for. */
const setup = async (
  options: {
    readonly agent?: ReadonlyArray<string>
    readonly cancel?: (executionId: string) => Effect.Effect<void, unknown>
    readonly model?: Model.Model
    readonly run?: (command: string) => number
    readonly schema?: string
  } = {},
) => {
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  const machine = machines(github, options.run)
  const { services } = await githubServices(runtime, github)
  const starts: Array<{ readonly flow: string; readonly executionId: string; readonly payload: unknown }> = []
  const todoServices: Todo.Services<unknown, never> = {
    database: services.database,
    tokens: services.tokens,
    http: services.http,
    apiBaseUrl: services.apiBaseUrl,
    ...(options.cancel === undefined ? {} : { cancel: options.cancel }),
    start: (flow, start) => Effect.sync(() => void starts.push({ flow: flow._tag, ...start })),
  }
  const agent = cells(...(options.agent ?? [WRITES_README]))
  const seat = await agentSeat(options.model ?? agent.model)
  // The agent's commands run as `sandbox/Command` jobs, which the deployed host registers beside the sandbox tools.
  const registration = Layer.mergeAll(
    Todo.registration(todoServices, TodoAgent.registration(seat, await database(), Agent.layerSandbox)),
    SandboxCommand.registration,
    TodoBaseClosed.registration(todoServices),
  ).pipe(Layer.provide(machine.layer))
  const run = (start: Stack.AttemptStart) =>
    runFlow(Todo.Todo, start, registration, {
      executionId: todoExecutionId(start.attemptId),
      ...(options.schema === undefined ? {} : { schema: options.schema }),
    })
  return { github, machine, starts, agent, run, services: todoServices, registration }
}

// A run on the Node host takes 15 to 30 seconds: the engine, the agent's QuickJS realm and Postgres at each step.
describe("the todo run", { timeout: 120_000 }, () => {
  test("takes a TODO from an issue to a merged pull request: branch, change, commit, PR with Fixes #n, merge", async () => {
    const ctx = await setup()
    const issue = ctx.github.open("README needs a line", "Please add one.")
    ctx.github.files.set(".smithers/checks/readme.sh", "test -s README.md\n")
    const start = (await commit("Add a line to README", "Add a line to the README.", issue.number))!
    const second = await commit("Second", "Then this.")
    expect(second).toBeUndefined()
    // A person merges the pull request on github.com as soon as it opens.
    ctx.github.onPullOpened = (number) => void ctx.github.merge(number, "maya")

    const ran = await ctx.run(start)

    expect(ran.exit).toEqual(Exit.succeed({ state: "merged" }))
    expect(ran.status).toBe("completed")
    // The branch: the TODO's number and title, then the first 12 hex of the begin step's key.
    const pull = [...ctx.github.pulls.values()][0]!
    const branch = pull.head
    expect(branch).toMatch(/^smithers\/t1-add-a-line-to-readme-[0-9a-f]{12}$/)
    expect([pull.base, pull.merged]).toEqual(["main", true])
    const body = ctx.github.issues.get(pull.number)!.body!
    expect(body).toContain("Add a line to the README.")
    expect(body).toContain(`Fixes #${issue.number}`)
    expect(body).toContain("Smithers for @maya")
    // The pull request carries the publish step's key, never the attempt's id.
    expect(body).toMatch(/\n\n<!-- smithers:write=[0-9a-f]{64} -->$/)
    expect(body).not.toContain(start.attemptId)
    // The commit: one, on the base, written as the App with whom it acted for; main has the squash.
    const head = ctx.github.commits.get(pull.mergeSha!)!
    expect(ctx.github.tree("main").get("README.md")).toBe("# Widgets\n\nA line\n")
    expect(head.parents).toHaveLength(1)
    const branchCommit = [...ctx.github.commits.values()].find((found) => found.message.startsWith("T1: "))!
    expect(branchCommit.login).toBe(BOT_LOGIN)
    expect(branchCommit.message).toMatch(/^T1: Add a line to README\n\nSmithers for @maya\n\nSmithers-Write: [0-9a-f]{64}$/)
    // The TODO settled merged, and the next one started.
    expect(await todo(1)).toMatchObject({
      state: "merged",
      branch,
      prNumber: pull.number,
      mergeSha: pull.mergeSha,
      position: null,
      failure: null,
    })
    expect(await todo(2)).toMatchObject({ state: "working", position: 1 })
    // T1's pull request opening freed the lane: T2 started then, to stack on T1's branch, and T1's checks started.
    expect(ctx.starts.map(({ flow }) => flow)).toEqual([Todo.Todo._tag, ChecksRun._tag])
    expect(ctx.starts[1]!.executionId).toBe(checkExecutionId(REPOSITORY.id, branchCommit.sha, "all"))
    // The agent's tools ran on the attempt's own machine, on its branch, as the person who committed the TODO.
    const tools = ctx.machine.calls.filter((call) => call.callId.length === 36)
    expect(new Set(tools.map((call) => `${call.branchId} ${call.branch} ${call.ownerId}`))).toEqual(
      new Set([`${TodoMachine.machineId(start.attemptId)} ${branch} ${maya.id}`]),
    )
    expect(ctx.machine.calls.map((call) => call.tool)).toEqual(["write", "run", "status", "read"])
    // The pull request is in the projection, merged.
    expect(await sql(runtime, `SELECT number, merged, head_ref AS "headRef" FROM pulls`)).toEqual([
      { number: pull.number, merged: true, headRef: branch },
    ])
  })

  test.each(["merged", "closed", "closed-reopened"] as const)("a published TODO parks without failed attempts and a %s webhook settles it within seconds", async (terminal) => {
    const ctx = await setup()
    const start = (await commit("Wait for merge", "Add a line."))!
    const executionId = todoExecutionId(start.attemptId)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { context, engine } = yield* build(ctx.registration)
      const flows = Context.get(context, FlowRuntime.FlowRuntime)
      const running = yield* flows.execute(Todo.Todo, { executionId, payload: start }).pipe(
        Effect.provide(context), Effect.forkChild,
      )
      const parked = () => Effect.promise(() => sql(runtime,
        `SELECT waiting_reason AS waiting FROM ${engine.schema}.flows_runs WHERE run_id = '${executionId}'`).then((rows) => rows as Array<{ waiting: string | null }>))
      const rows = yield* parked().pipe(
        Effect.repeat({ schedule: Schedule.spaced("20 millis"), until: (rows) => rows[0]?.waiting === "event" }),
        Effect.timeout("30 seconds"),
      )
      expect(rows[0]?.waiting).toBe("event")
      const attempts = () => sql(runtime, `SELECT * FROM ${engine.schema}.flows_attempts WHERE run_id = '${executionId}'`)
      const before = yield* Effect.promise(attempts)
      expect(before.every((row) => (row as { error_json: string | null }).error_json === null)).toBe(true)
      yield* Effect.sleep("250 millis")
      expect(yield* Effect.promise(attempts)).toEqual(before)
      const pr = [...ctx.github.pulls.keys()][0]!
      if (terminal === "merged") ctx.github.merge(pr, "maya")
      else ctx.github.close(pr)
      const began = Date.now()
      // This is the durable github/Apply step the signed webhook route starts, over the real stores and engine.
      yield* Apply.read({ ...ctx.services, signalTodo: (runId: string, number: number) => {
        if (terminal === "closed-reopened") {
          const issue = ctx.github.issues.get(number)!
          issue.state = "open"
          issue.closedAt = null
          issue.updatedAt = ++ctx.github.now
        }
        const deferred = WaitFor.deferred(`todo/pull/${number}`)
        return DurableDeferred.succeed(deferred, {
          token: DurableDeferred.tokenFromExecutionId(deferred, { flow: Todo.Todo, executionId: runId }), value: null,
        }).pipe(Effect.provide(context), Effect.orDie)
      } })({ deliveryId: crypto.randomUUID(), repo: `${REPOSITORY.owner}/${REPOSITORY.name}`, number: pr, event: "pull_request" })
      expect(yield* Fiber.join(running).pipe(Effect.timeout("5 seconds"))).toEqual({ state: terminal === "merged" ? "merged" : "dropped" })
      expect(Date.now() - began).toBeLessThan(5_000)
    })))
    expect(await todo(1)).toMatchObject({ state: terminal === "merged" ? "merged" : "dropped" })
  })

  test("a person's steer, admitted while the agent works, reaches its next turn and is in the change", async () => {
    // The engine's schema, named here so the steer can be admitted to it as ChatApi admits one: through a journal and a
    // queue of its own over the same tables (worker/RemoteRuns.ts), beside the run's engine.
    const schema = `flows_${crypto.randomUUID().replaceAll("-", "")}`
    const server = await runtime.runPromise(TestDatabase.serverUrl)
    const engineSchema = ExecutionHost.database(server.toString(), schema)
    const queue = NotificationQueue.layer.pipe(
      Layer.provide(Journal.SqlJournal.layer({ capacity: 1024, overflow: "reject", sourceEventCache: 1 })),
      Layer.provide(Layer.provideMerge(FlowsDatabase.DurableWriter.layer(), engineSchema)),
    )
    const steer = "Also add the line `steered widget` to README.md."
    let runId = ""
    const requests: Array<string> = []
    const model = Model.make({
      stream: (request) =>
        Stream.unwrap(Effect.gen(function* () {
          const text = JSON.stringify(request.messages)
          requests.push(text)
          if (requests.length === 1) {
            // A person presses Send while the agent's first turn is in flight.
            yield* Effect.flatMap(NotificationQueue.NotificationQueue, (notifications) =>
              notifications.admit(runId, Notification.humanSteer({
                runId,
                id: crypto.randomUUID(),
                actor: "person:person-ben",
                attribution: { login: "ben", via: "person" },
                payload: SteerPayload.encode({ kind: "Message", body: steer }),
              }))).pipe(Effect.provide(queue), Effect.scoped, Effect.orDie)
          }
          const source = requests.length === 1
            ? `await ctx.call("sandbox/write", { path: "README.md", content: "# Widgets\\n\\nA line\\n" })`
            : text.includes("steered widget")
            ? [
              `await ctx.call("sandbox/write", { path: "README.md", content: "# Widgets\\n\\nA line\\nsteered widget\\n" })`,
              `ctx.done({ summary: "Added a line and the steered one." })`,
            ].join("\n")
            : `ctx.done({ summary: "Added a line." })`
          return Stream.fromIterable<ModelEvent.ModelEvent>([
            { type: "text-delta", id: "t", text: "```cell\n" + source + "\n```" },
            { type: "usage", inputTokens: 10, outputTokens: 10 },
            { type: "settle", stopReason: "stop" },
          ])
        })),
    })
    const ctx = await setup({ model, schema })
    try {
      const start = (await commit("Add a line to README", "Add a line to the README."))!
      runId = todoExecutionId(start.attemptId)
      ctx.github.onPullOpened = (number) => void ctx.github.merge(number, "maya")

      const ran = await ctx.run(start)

      expect(ran.exit).toEqual(Exit.succeed({ state: "merged" }))
      // Not in the turn it arrived during; in the next one, once, as the person's message.
      expect(requests[0]).not.toContain("steered widget")
      expect(requests[1]).toContain(`[notification `)
      expect(requests[1]).toContain(`from person:person-ben at ${runId} turn 0`)
      expect(requests[1]!.split("steered widget")).toHaveLength(2)
      expect(ctx.github.tree("main").get("README.md")).toBe("# Widgets\n\nA line\nsteered widget\n")
      // Delivered: nothing left for a later boundary.
      const pending = await Effect.runPromise(
        Effect.flatMap(NotificationQueue.NotificationQueue, (notifications) => notifications.pending(runId)).pipe(
          Effect.provide(queue),
          Effect.scoped,
        ),
      )
      expect(pending).toEqual([])
    } finally {
      await sql(runtime, `DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    }
  })

  test("a pull request closed on GitHub drops the TODO", async () => {
    const ctx = await setup()
    const start = (await commit("Close me", "Anything."))!
    ctx.github.onPullOpened = (number) => ctx.github.close(number)
    const ran = await ctx.run(start)
    expect(ran.exit).toEqual(Exit.succeed({ state: "dropped" }))
    expect(await todo()).toMatchObject({ state: "dropped", note: "closed_on_github", position: null })
  })

  test("an agent that changes nothing fails the TODO empty_change and holds the next one", async () => {
    const ctx = await setup({ agent: [`ctx.done({ summary: "Nothing to do." })`] })
    const start = (await commit("Nothing", "Change nothing."))!
    await commit("Next", "Then this.")
    const ran = await ctx.run(start)
    expect(ran.exit).toEqual(Exit.succeed({ state: "failed" }))
    expect(await todo(1)).toMatchObject({ state: "failed", failure: "empty_change", position: 1 })
    expect(await todo(2)).toMatchObject({ state: "queued" })
    expect(ctx.github.pulls.size).toBe(0)
    expect(ctx.starts).toEqual([])
  })

  test("an agent that never answers in the schema fails the TODO implement", async () => {
    const ctx = await setup({ agent: [`ctx.done({ nonsense: true })`] })
    const start = (await commit("Bad answer", "Anything."))!
    const ran = await ctx.run(start)
    expect(ran.exit).toEqual(Exit.succeed({ state: "failed" }))
    expect(await todo()).toMatchObject({ state: "failed", failure: "implement" })
  })

  test("retry a failed implement runs attempt two to publication without replacing the TODO", async () => {
    let recovering = false
    const broken = cells(`ctx.done({ nonsense: true })`).model
    const healthy = cells(WRITES_README).model
    const ctx = await setup({ model: Model.make({
      stream: (request) => (recovering ? healthy : broken).stream(request),
    }) })
    const start = (await commit("Retry README", "Add a line.", 4430))!
    expect((await ctx.run(start)).exit).toEqual(Exit.succeed({ state: "failed" }))
    const press: Stack.Change = {
      opId: crypto.randomUUID(), repoId: REPOSITORY.id, actor: maya, via: "person",
      op: { kind: "retry", number: 1 },
    }
    const retried = await runtime.runPromise(Stack.apply(press, { runs: true }))
    if (retried.kind !== "applied") throw new Error("retry refused")
    const next = retried.receipt.starts[0]!
    expect(next).toMatchObject({ todoId: start.todoId, number: 1, ordinal: 2, revision: 1 })
    expect(await todo()).toMatchObject({ position: 1, state: "working", failure: null })
    expect(await runtime.runPromise(Stack.apply(press, { runs: true }))).toEqual({
      kind: "repeated", receipt: retried.receipt,
    })
    // Recover the injected faulty model service; only a person merges the resulting pull request.
    recovering = true
    ctx.github.onPullOpened = (number) => void ctx.github.merge(number, "maya")
    expect((await ctx.run(next)).exit).toEqual(Exit.succeed({ state: "merged" }))
    expect(await todo()).toMatchObject({ state: "merged", failure: null })
    expect(ctx.github.issues.get([...ctx.github.pulls.keys()][0]!)!.body).toContain("Fixes #4430")
    expect(await sql(runtime, "SELECT ordinal, status FROM todo_attempts ORDER BY ordinal")).toEqual([
      { ordinal: 1, status: "failed" }, { ordinal: 2, status: "settled" },
    ])
  })

  test("without the App installed the TODO fails app_not_installed before any branch", async () => {
    const ctx = await setup()
    ctx.github.installed = false
    const start = (await commit("No App", "Anything."))!
    const ran = await ctx.run(start)
    expect(ran.exit).toEqual(Exit.succeed({ state: "failed" }))
    expect(await todo()).toMatchObject({ state: "failed", failure: "app_not_installed", branch: null })
  })

  test("a TODO dropped before its run starts ends the run with nothing made", async () => {
    const ctx = await setup()
    const start = (await commit("Dropped", "Anything."))!
    await runtime.runPromise(Stack.apply({
      opId: crypto.randomUUID(),
      repoId: REPOSITORY.id,
      actor: maya,
      via: "person",
      op: { kind: "drop", number: 1 },
    }, { runs: true }))
    const ran = await ctx.run(start)
    expect(ran.exit).toEqual(Exit.succeed({ state: "ended" }))
    expect(ctx.github.refs.size).toBe(1)
    expect(await todo()).toMatchObject({ state: "dropped" })
  })

  test("a branch someone else holds under the TODO's name is left alone; a lost branch, commit and PR are adopted by key, not repeated", async () => {
    const ctx = await setup()
    ctx.github.push("smithers/t1-adopt", { "OTHER.md": "theirs\n" })
    ctx.github.refs.set("smithers/t1-adopt-0123456789ab", ctx.github.refs.get("main")!)
    const start = (await commit("Adopt", "Anything."))!
    ctx.github.faults.push(
      { match: (method, path) => method === "POST" && path.endsWith("/git/refs"), lost: true },
      { match: (method, path) => method === "POST" && path === "/graphql", lost: true },
      { match: (method, path) => method === "POST" && path.endsWith("/pulls"), lost: true },
    )
    ctx.github.onPullOpened = (number) => void ctx.github.merge(number)
    const ran = await ctx.run(start)
    expect(ran.exit).toEqual(Exit.succeed({ state: "merged" }))
    const row = await todo()
    expect(row).toMatchObject({ state: "merged" })
    expect(row["branch"]).toMatch(/^smithers\/t1-adopt-[0-9a-f]{12}$/)
    expect(row["branch"]).not.toBe("smithers/t1-adopt-0123456789ab")
    expect(ctx.github.seen("POST", /\/git\/refs$/)).toHaveLength(1)
    expect(ctx.github.seen("POST", /^\/graphql$/)).toHaveLength(1)
    expect(ctx.github.seen("POST", /\/pulls$/)).toHaveLength(1)
    expect(ctx.github.pulls.size).toBe(1)
    // The commit carries the step's key, and the pull request the same kind of marker: nothing else identifies them.
    const head = ctx.github.commits.get(row["headSha"] as string)!
    expect(head.message).toMatch(/^T1: Adopt\n\nSmithers for @maya\n\nSmithers-Write: [0-9a-f]{64}$/)
    expect(ctx.github.issues.get([...ctx.github.pulls.keys()][0]!)!.body).toMatch(/<!-- smithers:write=[0-9a-f]{64} -->$/)
  })
})

// Cloudflare stops an alarm after 15 minutes of wall time, and `todo/Implement` may run 40 (docs/infrastructure.md#limits).
// The next alarm, often on a new incarnation, resumes it: this is that resume on the Node host's engine.
describe("the todo run on a host that dies mid-implement", { timeout: 180_000 }, () => {
  /** Frame 1 writes, frame 2 runs the check, frame 3 answers. */
  const FRAMES = [
    `await ctx.call("sandbox/write", { path: "README.md", content: "# Widgets\\n\\nA line\\n" })`,
    `await ctx.call("sandbox/run", { command: "sh .smithers/checks/readme.sh" })`,
    `ctx.done({ summary: "Added a line; the check passed." })`,
  ]

  /**
   * A model that answers frame `n` (the number of its answers the request already holds) with `FRAMES[n]`, and the
   * frames it was asked; while `hold` is set it never answers frame 3.
   */
  const frames = () => {
    const asked: Array<number> = []
    const state = { hold: true }
    const model = Model.make({
      stream: (request) =>
        Stream.suspend(() => {
          const frame = request.messages.filter((message) => message.role === "assistant").length
          asked.push(frame)
          if (state.hold && frame === 2) return Stream.never
          return Stream.fromIterable<ModelEvent.ModelEvent>([
            { type: "text-delta", id: "t", text: "```cell\n" + FRAMES[Math.min(frame, FRAMES.length - 1)]! + "\n```" },
            { type: "usage", inputTokens: 10, outputTokens: 10 },
            { type: "settle", stopReason: "stop" },
          ])
        }),
    })
    return { model, asked, state }
  }

  test("a new engine resumes the agent where it stopped: no answered frame is asked again, and each tool call keeps its id", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    github.files.set(".smithers/checks/readme.sh", "test -s README.md\n")
    github.onPullOpened = (number) => void github.merge(number, "maya")
    const machine = machines(github)
    const { services } = await githubServices(runtime, github)
    const todoServices: Todo.Services<unknown, never> = {
      database: services.database,
      tokens: services.tokens,
      http: services.http,
      apiBaseUrl: services.apiBaseUrl,
      start: () => Effect.void,
    }
    const agent = frames()
    const registration = Layer.mergeAll(
      Todo.registration(
        todoServices,
        TodoAgent.registration(await agentSeat(agent.model), await database(), Agent.layerSandbox),
      ),
      SandboxCommand.registration,
    ).pipe(Layer.provide(machine.layer))
    const start = (await commit("Add a line to README", "Add a line to the README."))!
    const executionId = todoExecutionId(start.attemptId)
    /** A Durable Object's engine: one incarnation of the object, over the engine schema `schema` when it resumes one. */
    const engine = async (schema?: string) => {
      const scope = Effect.runSync(Scope.make())
      let disconnected = false
      const connectionName = `todo-crash-${crypto.randomUUID()}`
      const databaseGate = Effect.suspend(() => disconnected
        ? Effect.fail(new SqlError({ reason: new ConnectionError({
          cause: "test engine crashed", message: "The test engine's database connection ended", operation: "execute",
        }) }))
        : Effect.void)
      const built = await Effect.runPromise(
        Scope.provide(scope)(
          build(registration, {
            hostId: "durable-object",
            isAlive: RunStore.Ownership.singleIncarnationLiveness,
            maxConnections: 3, databaseGate, connectionName,
            ...(schema === undefined ? {} : { schema }),
          }),
        ),
      )
      const execute = Context.get(built.context, FlowRuntime.FlowRuntime).execute(Todo.Todo, { executionId, payload: start })
        .pipe(Effect.provide(built.context)) as Effect.Effect<unknown, unknown>
      return {
        built, execute, close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
        crash: () => {
          // A dead incarnation cannot reconnect and steal from its replacement.
          disconnected = true
          return runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) =>
            client`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
              WHERE pid <> pg_backend_pid() AND application_name = ${connectionName}`))
        },
      }
    }

    const first = await engine()
    const running = Effect.runFork(Effect.exit(first.execute))
    // Frames 1 and 2 are answered and their calls ran; frame 3 is being asked when the alarm is cut off.
    await expect.poll(() => agent.asked.length, { interval: 20, timeout: 60_000 }).toBe(3)
    await first.crash()
    const before = machine.calls.map((call) => `${call.tool} ${call.callId}`)
    agent.state.hold = false
    const second = await engine(first.built.engine.schema)
    const resumed = await Effect.runPromise(Effect.exit(second.execute))
    await Effect.runPromise(Fiber.interrupt(running))
    await second.close()
    await first.close()

    expect(resumed).toEqual(Exit.succeed({ state: "merged" }))
    // Frames 1 and 2 replay from their sealed steps; only frame 3, never answered, is asked again.
    expect(agent.asked).toEqual([0, 1, 2, 2])
    // A tool call the resumed agent made again carries the call id it had, which the machine runs once.
    const writes = machine.calls.filter((call) => call.tool === "write" || call.tool === "run")
    expect(new Set(writes.map((call) => `${call.tool} ${call.callId}`))).toEqual(
      new Set(before.filter((call) => call.startsWith("write ") || call.startsWith("run "))),
    )
    expect(github.tree("main").get("README.md")).toBe("# Widgets\n\nA line\n")
    expect(await todo(1)).toMatchObject({ state: "merged" })
  })

  test("a command the agent runs outlives the engine that started it: it runs once, and the agent reads its result", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    github.onPullOpened = (number) => void github.merge(number, "maya")
    // The attempt's commands run on a real box (a scratch checkout, real processes); its files stay in memory.
    const workdir = join(boxes, `todo-${crypto.randomUUID()}`)
    mkdirSync(workdir)
    const box = Box.boxAt({ workdir, homes: `${workdir}-homes` })
    const machine = machines(github, undefined, { commands: Box.machinesOn(box.box) })
    const { services } = await githubServices(runtime, github)
    const todoServices: Todo.Services<unknown, never> = {
      database: services.database,
      tokens: services.tokens,
      http: services.http,
      apiBaseUrl: services.apiBaseUrl,
      start: () => Effect.void,
    }
    // Frame 1 runs a command that takes a while and writes what it printed; frame 2 answers.
    const command = "echo ran >> runs.log; touch started; sleep 2; touch finished; echo done-$((2+3))"
    const FRAMES = [
      `const r = await ctx.call("sandbox/run", { command: ${JSON.stringify(command)} })\n` +
      `await ctx.call("sandbox/write", { path: "README.md", content: "# Widgets\\n\\n" + r.stdout })`,
      `ctx.done({ summary: "Ran it." })`,
    ]
    const model = Model.make({
      stream: (request) =>
        Stream.suspend(() => {
          const frame = request.messages.filter((message) => message.role === "assistant").length
          return Stream.fromIterable<ModelEvent.ModelEvent>([
            { type: "text-delta", id: "t", text: "```cell\n" + FRAMES[Math.min(frame, FRAMES.length - 1)]! + "\n```" },
            { type: "usage", inputTokens: 10, outputTokens: 10 },
            { type: "settle", stopReason: "stop" },
          ])
        }),
    })
    const registration = Layer.mergeAll(
      Todo.registration(todoServices, TodoAgent.registration(await agentSeat(model), await database(), Agent.layerSandbox)),
      SandboxCommand.registration,
    ).pipe(Layer.provide(machine.layer))
    const start = (await commit("Run it", "Run the command."))!
    const executionId = todoExecutionId(start.attemptId)
    const engine = async (schema?: string) => {
      const scope = Effect.runSync(Scope.make())
      const built = await Effect.runPromise(
        Scope.provide(scope)(
          build(registration, {
            hostId: "durable-object",
            isAlive: RunStore.Ownership.singleIncarnationLiveness,
            maxConnections: 3,
            ...(schema === undefined ? {} : { schema }),
          }),
        ),
      )
      const execute = Context.get(built.context, FlowRuntime.FlowRuntime).execute(Todo.Todo, { executionId, payload: start })
        .pipe(Effect.provide(built.context)) as Effect.Effect<unknown, unknown>
      return { built, execute, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) }
    }

    const first = await engine()
    const running = Effect.runFork(Effect.exit(first.execute))
    // The host dies while the command runs: its connections cut, its fibers stopped, its exec sessions closed.
    await expect.poll(() => existsSync(join(workdir, "started")), { interval: 10, timeout: 60_000 }).toBe(true)
    expect(existsSync(join(workdir, "finished"))).toBe(false)
    await runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (client) =>
        client`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE pid <> pg_backend_pid() AND query LIKE ${`%${first.built.engine.schema}%`}`),
    )
    await Effect.runPromise(Fiber.interrupt(running))
    await first.close()
    const second = await engine(first.built.engine.schema)
    const resumed = await Effect.runPromise(Effect.exit(second.execute))
    await second.close()

    expect(resumed).toEqual(Exit.succeed({ state: "merged" }))
    // The command ran once, and the agent read what it printed after the engine that started it was gone.
    expect(readFileSync(join(workdir, "runs.log"), "utf8")).toBe("ran\n")
    expect(github.tree("main").get("README.md")).toBe("# Widgets\n\ndone-5\n")
  })
})

describe("the run's steps", () => {
  test("await closes the pull request a dropped TODO's run opened, as the App, and ends", async () => {
    const ctx = await setup()
    const start = (await commit("Open", "Anything."))!
    ctx.github.push("feature", { "A.md": "a\n" })
    // A pull request the run opened, then the TODO dropped in Smithers.
    const issue = ctx.github.openPull("feature")
    await runtime.runPromise(Stack.apply({
      opId: crypto.randomUUID(),
      repoId: REPOSITORY.id,
      actor: maya,
      via: "person",
      op: { kind: "drop", number: 1 },
    }, { runs: true }))
    const awaited = await runtime.runPromise(
      Todo.steps(ctx.services).await({ request: start, begun: onMain("feature"), published: { headSha: "a".repeat(40), prNumber: issue.number } }).pipe(
        Effect.provide(ctx.machine.layer),
      ),
    )
    expect(awaited).toEqual({ state: "ended", mergeSha: null })
    expect(ctx.github.issues.get(issue.number)!.state).toBe("closed")
  })

  test("await answers StillOpen while a person hasn't merged, so the engine asks again", async () => {
    const ctx = await setup()
    const start = (await commit("Wait", "Anything."))!
    ctx.github.push("feature", { "A.md": "a\n" })
    const issue = ctx.github.openPull("feature")
    const exit = await runtime.runPromise(
      Effect.exit(
        Todo.steps(ctx.services).await({ request: start, begun: onMain("feature"), published: { headSha: "a".repeat(40), prNumber: issue.number } }),
      ),
    )
    expect(exit._tag === "Failure" && String(exit.cause)).toContain("StillOpen")
  })

  test("TODO_RUNS: a deployment runs TODOs unless it is set to false", async () => {
    const read = (env: Record<string, string>) =>
      Effect.runPromise(Effect.gen(function* () {
        return yield* Todo.enabled
      }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))))
    expect(await read({})).toBe(true)
    expect(await read({ TODO_RUNS: "false" })).toBe(false)
    expect(await read({ TODO_RUNS: "true" })).toBe(true)
  })

  test("failureOf names each step's code", () => {
    expect(Todo.failureOf(new Todo.TodoFailed({ failure: "budget" }))).toBe("budget")
    expect(Todo.failureOf(new Todo.TodoUnavailable({ step: "begin" }))).toBe("publish_refused")
    expect(Todo.failureOf(new Todo.TodoUnavailable({ step: "publish" }))).toBe("publish_refused")
    expect(Todo.failureOf(new Todo.TodoUnavailable({ step: "collect" }))).toBe("implement")
    expect(Todo.failureOf(new Todo.TodoUnavailable({ step: "await" }))).toBe("pr_refused")
    expect(Todo.failureOf(new Todo.StillOpen())).toBe("implement")
  })

  test("the branch, the commit's message, the PR's body and base64", () => {
    expect(Todo.branchPrefixOf(4)).toBe("smithers/t4-")
    expect(Todo.slugOf("Retry webhook delivery!")).toBe("retry-webhook-delivery")
    expect(Todo.slugOf("!!!")).toBe("")
    expect(Todo.slugOf("x".repeat(80))).toBe("x".repeat(40))
    expect(Todo.slugOf("Ünïcode tïtle")).toBe("unicode-title")
    expect(Todo.commitMessageOf(2, "Fix it", "maya")).toEqual({ headline: "T2: Fix it", body: "Smithers for @maya" })
    const begun = {
      branch: "b",
      baseSha: "a".repeat(40),
      baseRef: "main",
      defaultBranch: "main",
      title: "t",
      prompt: "Do it.",
      acceptance: [],
      issueNumber: null,
      ownerId: "p",
      ownerLogin: "maya",
    }
    expect(Todo.pullBodyOf(begun)).toBe("Do it.\n\nSmithers for @maya")
    expect(Todo.pullBodyOf({ ...begun, issueNumber: 7 })).toBe("Do it.\n\nFixes #7\n\nSmithers for @maya")
    expect(Todo.base64Of("é\n")).toBe(btoa(String.fromCharCode(0xc3, 0xa9, 0x0a)))
    expect(atob(Todo.base64Of("x".repeat(70_000))).length).toBe(70_000)
  })

  test("the machine of a run's execution: its attempt's branch and committer, none for any other run", async () => {
    const start = (await commit("Machine", "Anything."))!
    const of = (executionId: string) =>
      runtime.runPromise(TodoMachine.ofExecution(executionId).pipe(Effect.map(Option.getOrUndefined)))
    expect(await of(todoExecutionId(start.attemptId))).toBeUndefined()
    await sql(runtime, `UPDATE todos SET branch = 'smithers/t1-machine'`)
    expect(await of(todoExecutionId(start.attemptId))).toEqual({
      branch: {
        branchId: TodoMachine.machineId(start.attemptId),
        owner: REPOSITORY.owner,
        name: REPOSITORY.name,
        branch: "smithers/t1-machine",
        // The branch is GitHub's: `todo/Begin` makes it there, so the machine reads it there (worker/branch/Forge.ts).
        forge: "github",
      },
      ownerId: maya.id,
    })
    expect(await of("chat:123")).toBeUndefined()
    expect(await of("todo:not-a-uuid")).toBeUndefined()
    expect(await of(todoExecutionId(crypto.randomUUID()))).toBeUndefined()
  })

  test("the owner of a run's execution: its TODO's committer, before its branch is made too; none for any other run", async () => {
    const start = (await commit("Owner", "Anything."))!
    const owner = (executionId: string) =>
      runtime.runPromise(TodoMachine.ownerOf(executionId).pipe(Effect.map(Option.getOrUndefined)))
    expect(await owner(todoExecutionId(start.attemptId))).toBe(maya.id)
    expect(await owner("chat:123")).toBeUndefined()
    expect(await owner("todo:not-a-uuid")).toBeUndefined()
    expect(await owner(todoExecutionId(crypto.randomUUID()))).toBeUndefined()
  })
})

/** One step, run once inside a real dispatch with no retry policy: `dispatched` below. */
const StepRun = Action.make("probe/todo/StepRun", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Union([Todo.TodoFailed, Todo.TodoUnavailable]),
  tier: "irreversible",
})
const StepProbe = Flow.make("probe/todo/Step", {
  payload: Schema.Struct({}),
  success: Schema.Unknown,
  error: Schema.Union([Todo.TodoFailed, Todo.TodoUnavailable]),
  body: Node.capture({ step: StepRun.name }, () => StepRun.call({})),
})

describe("the run's steps, case by case", { timeout: 60_000 }, () => {
  const unreachable = Database.layer(Effect.succeed(Redacted.make("postgresql://smithers:smithers@127.0.0.1:1/smithers")))
  const BASE = () => "0".repeat(40)
  /** Runs one step of `ctx`'s services, answering its exit. */
  const step = <A, E, R>(ctx: Awaited<ReturnType<typeof setup>>, effect: (steps: ReturnType<typeof Todo.steps>) => Effect.Effect<A, E, R>) =>
    runtime.runPromise(
      Effect.exit((effect(Todo.steps(ctx.services)) as Effect.Effect<A, E, Machines>).pipe(Effect.provide(ctx.machine.layer))),
    )
  /**
   * Runs one step of `ctx`'s services inside a real dispatch of the Node host's engine: `Action.once` keys a write by
   * the execution and the dispatch, so a step that writes to GitHub runs where the engine names both. The probe action
   * declares no retry policy, so a failure answers at once instead of waiting out the step's own.
   */
  const dispatched = async <A, E, R>(
    ctx: Awaited<ReturnType<typeof setup>>,
    effect: (steps: ReturnType<typeof Todo.steps>) => Effect.Effect<A, E, R>,
  ): Promise<Exit.Exit<unknown, unknown>> => {
    const registration = Interpreter.layerWithImplementations(
      StepProbe,
      StepRun.toLayer(() =>
        effect(Todo.steps(ctx.services)) as unknown as Effect.Effect<unknown, Todo.TodoFailed | Todo.TodoUnavailable, Machines>
      ),
    ).pipe(Layer.provideMerge(Action.layerImplementations), Layer.provide(ctx.machine.layer))
    return (await runFlow(StepProbe, {}, registration)).exit
  }
  const failure = (exit: Exit.Exit<unknown, unknown>) =>
    exit._tag === "Failure" ? JSON.parse(JSON.stringify(Cause.squash(exit.cause))) : undefined
  const begun = (ctx: Awaited<ReturnType<typeof setup>>, branch: string): Todo.Begun => ({
    branch,
    baseSha: ctx.github.refs.get("main")!,
    baseRef: "main",
    defaultBranch: "main",
    title: "Step",
    prompt: "Do it.",
    acceptance: [],
    issueNumber: null,
    ownerId: maya.id,
    ownerLogin: maya.login,
  })

  test.each(["committed", "mixed", "empty", "forbidden"] as const)(
    "collect and publish a real agent checkout: %s", async (kind) => {
      const ctx = await setup()
      const start = (await commit("Step", "Do it."))!
      const workdir = mkdtempSync(join(boxes, "publish-"))
      const git = (...args: Array<string>) => execFileSync("git", [
        "-c", "user.name=Agent", "-c", "user.email=agent@example.com", "-c", "commit.gpgsign=false", ...args,
      ], { cwd: workdir, encoding: "utf8" }).trim()
      git("init", "-q", "-b", "main")
      git("commit", "--allow-empty", "-m", "base")
      const base = git("rev-parse", "HEAD")
      const prior = ctx.github.refs.get("main")!
      ctx.github.commits.set(base, { ...ctx.github.commits.get(prior)!, sha: base, files: new Map() })
      ctx.github.refs.set("main", base)
      const made = await dispatched(ctx, (steps) => steps.begin({ request: start }))
      expect(made._tag).toBe("Success")
      if (made._tag !== "Success") return
      const begun = made.value as Todo.Begun
      if (kind !== "empty") {
        writeFileSync(join(workdir, kind === "forbidden" ? "bad\\path" : "slept.txt"), "agent work\n")
        git("add", ".")
        git("commit", "-m", "agent's own message")
      }
      if (kind === "mixed") writeFileSync(join(workdir, "pending.txt"), "pending\n")
      const box = Box.boxAt({ workdir, homes: join(workdir, "..", `homes-${kind}`) })
      const real = { ...ctx, machine: { ...ctx.machine, layer: Layer.succeed(Machines, Box.machinesOn(box.box)) } }
      const collected = await step(real, (steps) => steps.collect({ request: start, begun }))
      if (kind === "empty") {
        expect(failure(collected)).toMatchObject({ failure: "empty_change" })
        expect(ctx.github.pulls.size).toBe(0)
        return
      }
      expect(collected._tag).toBe("Success")
      if (collected._tag !== "Success") return
      const published = await dispatched(real, (steps) => steps.publish({ request: start, begun, collected: collected.value }))
      if (kind === "forbidden") {
        expect(failure(published)).toMatchObject({ _tag: "@smthrs/mvp/todo/TodoUnavailable", step: "publish" })
        expect(ctx.github.refs.get(begun.branch)).toBe(base)
        expect(ctx.github.pulls.size).toBe(0)
        return
      }
      expect(published._tag).toBe("Success")
      const head = ctx.github.refs.get(begun.branch)!
      expect(ctx.github.commits.get(head)).toMatchObject({ parents: [base] })
      expect(ctx.github.commits.get(head)!.message).toContain("T1: Step")
      expect(ctx.github.tree(begun.branch).get("slept.txt")).toBe("agent work\n")
      if (kind === "mixed") expect(ctx.github.tree(begun.branch).get("pending.txt")).toBe("pending\n")
      expect(ctx.github.refs.get("main")).toBe(base)
      expect(ctx.github.pulls.size).toBe(1)
    },
  )

  test("begin: run again in its dispatch, it finds its own branch by key, even after the default branch moved; an attempt it doesn't know ends", async () => {
    const ctx = await setup()
    const start = (await commit("Step", "Do it."))!
    const base = ctx.github.refs.get("main")!
    const again = await dispatched(ctx, (steps) =>
      Effect.gen(function* () {
        const first = yield* steps.begin({ request: start })
        ctx.github.push("main", { "MOVED.md": "moved\n" })
        const second = yield* steps.begin({ request: start })
        return [first, second]
      }))
    const [first, second] = (again as Exit.Success<ReadonlyArray<Todo.Begun>>).value
    expect(first!.branch).toMatch(/^smithers\/t1-step-[0-9a-f]{12}$/)
    expect(second).toEqual(first)
    expect(first!.baseSha).toBe(base)
    expect(ctx.github.seen("POST", /\/git\/refs$/)).toHaveLength(1)
    const unknown = await step(ctx, (steps) => steps.begin({ request: { ...start, attemptId: crypto.randomUUID() } }))
    expect(failure(unknown)).toMatchObject({ failure: "ended" })
  })

  test("begin: a branch under the TODO's name that isn't its own is never taken; no default branch is publish_refused", async () => {
    const ctx = await setup()
    const start = (await commit("Taken", "Do it."))!
    // Someone else's branches: the same name, the same name at the base, and the same label with another key.
    ctx.github.push("smithers/t1-taken", { "X.md": "x\n" })
    ctx.github.refs.set("smithers/t1-taken-2", ctx.github.refs.get("main")!)
    ctx.github.refs.set("smithers/t1-taken-ffffffffffff", ctx.github.refs.get("main")!)
    const made = await dispatched(ctx, (steps) => steps.begin({ request: start }))
    const branch = (made as Exit.Success<Todo.Begun>).value.branch
    expect(branch).toMatch(/^smithers\/t1-taken-[0-9a-f]{12}$/)
    expect(["smithers/t1-taken", "smithers/t1-taken-2", "smithers/t1-taken-ffffffffffff"]).not.toContain(branch)
    const gone = await setup()
    await sql(runtime, "TRUNCATE stack_ops, todo_attempts, todo_requests, todos, stacks")
    const second = (await commit("Gone", "Do it."))!
    gone.github.refs.delete("main")
    expect(failure(await dispatched(gone, (steps) => steps.begin({ request: second })))).toMatchObject({
      failure: "publish_refused",
    })
  })

  test("begin: a branch GitHub fails to create, or a token it fails to mint, is tried again", async () => {
    const ctx = await setup()
    const start = (await commit("Down", "Do it."))!
    ctx.github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/git/refs"), status: 500 })
    expect(failure(await dispatched(ctx, (steps) => steps.begin({ request: start })))).toMatchObject({ step: "begin" })
    ctx.github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/access_tokens"), status: 500 })
    expect(failure(await step(ctx, (steps) => steps.begin({ request: start })))).toMatchObject({ step: "begin" })
  })

  test("collect: deletions, too many files, a cut read or a refused tool fail implement; a machine down is retried", async () => {
    const ctx = await setup()
    const start = (await commit("Collect", "Do it."))!
    await sql(runtime, `UPDATE todos SET branch = 'main'`)
    const machine = TodoMachine.machineOf({ ...start, branch: "main", ownerId: maya.id })
    const tools = Context.get(await Effect.runPromise(Layer.build(ctx.machine.layer).pipe(Effect.scoped)), Machines)
    await Effect.runPromise(tools.tool(machine.branch, maya.id, "w", { tool: "write", path: "NEW.md", content: "n\n" }))
    ctx.machine.copies.get(machine.branch.branchId)!.files.delete("README.md")
    const collected = await step(ctx, (steps) => steps.collect({ request: start, begun: begun(ctx, "main") }))
    expect(collected._tag === "Success" && collected.value).toEqual({
      additions: [{ path: "NEW.md", contents: btoa("n\n") }],
      deletions: ["README.md"],
    })
    const files = ctx.machine.copies.get(machine.branch.branchId)!.files
    for (let index = 0; index < Todo.MAX_FILES; index++) files.set(`f${index}.md`, "x")
    expect(failure(await step(ctx, (steps) => steps.collect({ request: start, begun: begun(ctx, "main") }))))
      .toMatchObject({ failure: "implement" })
    for (let index = 0; index < Todo.MAX_FILES; index++) files.delete(`f${index}.md`)
    files.set("BIG.md", "x".repeat(Todo.MAX_CHANGE_BYTES + 1))
    expect(failure(await step(ctx, (steps) => steps.collect({ request: start, begun: begun(ctx, "main") }))))
      .toMatchObject({ failure: "implement" })
  })

  test("collect: a tool the machine refuses, a checkout that failed or a read it cut fails implement; a machine down is retried", async () => {
    const ctx = await setup()
    const start = (await commit("Tools", "Do it."))!
    /** `ctx` over a machine whose every call answers `answer`. */
    const on = (answer: (call: SandboxTools.Call) => ReturnType<Machines["Service"]["tool"]>) => ({
      ...ctx,
      machine: {
        ...ctx.machine,
        layer: Layer.succeed(
          Machines,
          Machines.of({ commands: () => noCommands, tool: (_branch, _owner, _id, call) => answer(call), sleepIfIdle: () => Effect.die("unused") }),
        ),
      },
    })
    const collect = (target: Awaited<ReturnType<typeof setup>>) =>
      step(target, (steps) => steps.collect({ request: start, begun: begun(ctx, "main") }))
    const failing = (tag: string) => on(() => Effect.fail({ _tag: tag, reason: "not_found" } as never))
    expect(failure(await collect(failing("@smthrs/sandbox/SandboxTools/ToolRefused")))).toMatchObject({ failure: "implement" })
    expect(failure(await collect(failing("@smthrs/mvp/branch/CheckoutFailed")))).toMatchObject({ failure: "implement" })
    expect(failure(await collect(failing("@smthrs/mvp/branch/SandboxUnavailable")))).toMatchObject({ step: "collect" })
    const cut = on((call) => {
      const result: SandboxTools.Result = call.tool === "status"
        ? { tool: "status", branch: "main", entries: [{ path: "BIG.md", index: "?", worktree: "?" }] }
        : { tool: "read", path: "BIG.md", content: "x", bytes: 1, truncated: true }
      return Effect.succeed({ result, generation: 1 })
    })
    expect(failure(await collect(cut))).toMatchObject({ failure: "implement" })
  })

  test("begin: GitHub's or the token's wait is kept for the retry", async () => {
    const ctx = await setup()
    const start = (await commit("Wait", "Do it."))!
    const repository = `/repos/${REPOSITORY.owner}/${REPOSITORY.name}`
    ctx.github.faults.push({
      match: (method, path) => method === "GET" && path.endsWith(repository),
      status: 429,
      headers: { "retry-after": "7" },
    })
    expect(failure(await step(ctx, (steps) => steps.begin({ request: start })))).toMatchObject({ step: "begin", retryAfterMillis: 7_000 })
    ctx.github.faults.push({ match: (_method, path) => path.endsWith("/access_tokens"), status: 429, headers: { "retry-after": "5" } })
    expect(failure(await step(ctx, (steps) => steps.begin({ request: start })))).toMatchObject({ step: "begin", retryAfterMillis: 5_000 })
  })

  test("publish: a report the writer finds stale ends the run before anything is written", async () => {
    const ctx = await setup()
    const start = (await commit("Stale", "Do it."))!
    const collected = { additions: [{ path: "A.md", contents: btoa("a\n") }], deletions: [] }
    const stale = await step(ctx, (steps) => steps.publish({ request: { ...start, ordinal: 9 }, begun: begun(ctx, "main"), collected }))
    expect(failure(stale)).toMatchObject({ failure: "ended" })
    expect(ctx.github.seen("POST", /^\/graphql$/)).toHaveLength(0)
  })

  test("await: an attempt the writer no longer has closes the pull request its run opened, and ends", async () => {
    const ctx = await setup()
    const start = (await commit("Gone", "Do it."))!
    ctx.github.push("feature", { "G.md": "g\n" })
    const pull = ctx.github.openPull("feature")
    const gone = await step(ctx, (steps) =>
      steps.await({
        request: { ...start, attemptId: crypto.randomUUID() },
        begun: begun(ctx, "feature"),
        published: { headSha: BASE(), prNumber: pull.number },
      })
    )
    expect(gone._tag === "Success" && gone.value).toEqual({ state: "ended", mergeSha: null })
    expect(ctx.github.issues.get(pull.number)!.state).toBe("closed")
  })

  test("publish: a missing branch, or a head someone else moved, is publish_refused; GitHub refusing the PR, pr_refused", async () => {
    const ctx = await setup()
    const start = (await commit("Publish", "Do it."))!
    const collected = { additions: [{ path: "A.md", contents: btoa("a\n") }], deletions: [] }
    expect(failure(await dispatched(ctx, (steps) => steps.publish({ request: start, begun: begun(ctx, "smithers/gone"), collected }))))
      .toMatchObject({ failure: "publish_refused" })
    ctx.github.push("smithers/theirs", { "T.md": "t\n" })
    expect(failure(await dispatched(ctx, (steps) => steps.publish({ request: start, begun: begun(ctx, "smithers/theirs"), collected }))))
      .toMatchObject({ failure: "publish_refused" })
    ctx.github.push("smithers/refused", {})
    ctx.github.refs.set("smithers/refused", ctx.github.refs.get("main")!)
    ctx.github.faults.push({ match: (method, path) => method === "POST" && path.endsWith("/pulls"), status: 422 })
    expect(failure(await dispatched(ctx, (steps) => steps.publish({ request: start, begun: begun(ctx, "smithers/refused"), collected }))))
      .toMatchObject({ failure: "pr_refused" })
  })

  // The bug Codex Astra and Claude Fable found (2026-10-21): a commit on the TODO's branch whose parent is the base and
  // whose message is the run's own `T<n>: <title>` and `Smithers for @<login>` was adopted as the run's commit, and its
  // change published as the TODO's. Only the step's own key identifies its commit.
  test("publish: a foreign commit with the same number, title and login on the TODO's branch is never adopted", async () => {
    const ctx = await setup()
    const start = (await commit("Same", "Do it."))!
    const begin = await dispatched(ctx, (steps) => steps.begin({ request: start }))
    const made = (begin as Exit.Success<Todo.Begun>).value
    const base = made.baseSha
    const foreign = "f".repeat(40)
    ctx.github.commits.set(foreign, {
      sha: foreign,
      message: "T1: Same\n\nSmithers for @maya",
      parents: [base],
      login: "maya",
      at: Date.now(),
      files: new Map([...ctx.github.commits.get(base)!.files, ["THEIRS.md", "not the TODO's change\n"]]),
    })
    ctx.github.refs.set(made.branch, foreign)
    const collected = { additions: [{ path: "A.md", contents: btoa("a\n") }], deletions: [] }
    const published = await dispatched(ctx, (steps) => steps.publish({ request: start, begun: made, collected }))
    expect(failure(published)).toMatchObject({ failure: "publish_refused" })
    expect(ctx.github.pulls.size).toBe(0)
    expect(ctx.github.refs.get(made.branch)).toBe(foreign)
  })

  test("await: a pull request GitHub no longer has, or closed, ends closed", async () => {
    const ctx = await setup()
    const start = (await commit("Await", "Do it."))!
    ctx.github.push("feature", { "F.md": "f\n" })
    const pull = ctx.github.openPull("feature")
    ctx.github.close(pull.number)
    const closed = await step(ctx, (steps) => steps.await({ request: start, begun: begun(ctx, "feature"), published: { headSha: BASE(), prNumber: pull.number } }))
    expect(closed._tag === "Success" ? closed.value : failure(closed)).toEqual({ state: "closed", mergeSha: null })
    ctx.github.remove(pull.number)
    const gone = await step(ctx, (steps) => steps.await({ request: start, begun: begun(ctx, "feature"), published: { headSha: BASE(), prNumber: pull.number } }))
    expect(gone._tag === "Success" ? gone.value : failure(gone)).toEqual({ state: "closed", mergeSha: null })
  })

  /**
   * Two TODOs stacked: T1 committed and started, its branch with one commit and its pull request into main reported
   * published, which starts T2; then T2's `todo/Begin` and `todo/Publish` with `t2Files` as its change.
   */
  const stacked = async (
    ctx: Awaited<ReturnType<typeof setup>>,
    t2Files: Record<string, string> = { "TWO.md": "2\n" },
    issue?: number,
  ) => {
    const start1 = (await commit("One", "First.", issue))!
    await commit("Two", "Then this.", issue)
    const attempt1 = { attemptId: start1.attemptId, todoId: start1.todoId, repoId: REPOSITORY.id, ordinal: start1.ordinal }
    const t1 = "smithers/t1-one"
    const t1Head = ctx.github.push(t1, { "ONE.md": "1\n" })
    const pull1 = ctx.github.openPull(t1, "T1: One", BOT_LOGIN)
    await runtime.runPromise(Stack.report(attempt1, { kind: "branch", branch: t1, baseSha: ctx.github.refs.get("main")!, baseRef: "main" }, {
      runs: true,
    }))
    const published1 = await runtime.runPromise(
      Stack.report(attempt1, { kind: "published", headSha: t1Head, prNumber: pull1.number, draft: false }, { runs: true }),
    )
    const start2 = published1.starts[0]!
    const begun2 = await dispatched(ctx, (steps) => steps.begin({ request: start2 })) as Exit.Exit<Todo.Begun>
    if (begun2._tag !== "Success") throw new Error("begin failed")
    const collected = {
      additions: Object.entries(t2Files).map(([path, text]) => ({ path, contents: btoa(text) })),
      deletions: [],
    }
    const published2 = await dispatched(ctx, (steps) => steps.publish({ request: start2, begun: begun2.value, collected })) as Exit.Exit<
      Todo.Published
    >
    if (published2._tag !== "Success") throw new Error("publish failed")
    return { start1, attempt1, t1, t1Head, pull1, start2, begun: begun2.value, published: published2.value }
  }

  test.each(["merged", "closed-reopened"] as const)("a base %s webhook wakes its dependent host before the base run settles", async (terminal) => {
    const ctx = await setup()
    const { pull1, start2, begun, published } = await stacked(ctx)
    const Probe = Flow.make("todo", {
      payload: Todo.TodoRequest, success: Todo.Awaited,
      error: Schema.Union([Todo.TodoFailed, Todo.TodoUnavailable, Todo.StillOpen]),
      body: Node.capture({ begun, published, await: Todo.Await.name }, (request: Todo.TodoRequest) =>
        Todo.Await.call({ request, begun, published })),
    })
    const registration = Interpreter.layerWithImplementations(Probe,
      Todo.Await.toLayer(Todo.steps(ctx.services).awaitMerge),
    ).pipe(Layer.provideMerge(Action.layerImplementations))
    const executionId = todoExecutionId(start2.attemptId)
    const schema = `flows_${crypto.randomUUID().replaceAll("-", "")}`
    const url = (await runtime.runPromise(TestDatabase.serverUrl)).toString()
    const values = new Map<string, unknown>()
    const storage: ExecutionHost.Storage = {
      get: <A>(key: string) => Effect.sync(() => structuredClone(values.get(key)) as A | undefined),
      put: (key, value) => Effect.sync(() => void values.set(key, structuredClone(value))),
      delete: (key) => Effect.sync(() => values.delete(key)),
      setAlarm: () => Effect.void, deleteAlarm: () => Effect.void,
    }
    const host = ExecutionHost.make(storage, {
      hostId: `object-${executionId}`, database: ExecutionHost.database(url, schema),
      flows: { flows: [Probe], registration }, router: { start: () => Effect.void, wake: () => Effect.void },
    })
    try {
      await Effect.runPromise(Effect.gen(function* () {
        yield* host.start(yield* ExecutionHost.intent(Probe, { executionId, payload: start2 }))
        expect((yield* host.alarm())._tag).toBe("Parked")
        if (terminal === "merged") ctx.github.merge(pull1.number)
        else ctx.github.close(pull1.number)
        const apply = (number: number, signalTodo?: Apply.Services["signalTodo"]) => Apply.read({ ...ctx.services,
          ...(signalTodo === undefined ? {} : { signalTodo }),
        })({ deliveryId: crypto.randomUUID(), repo: `${REPOSITORY.owner}/${REPOSITORY.name}`, number, event: "pull_request" })
        const signal: NonNullable<Apply.Services["signalTodo"]> = (runId, number) => Effect.gen(function* () {
          if (runId !== executionId) return // The base fixture has no host yet.
          if (terminal === "closed-reopened" && number === pull1.number) {
            const issue = ctx.github.issues.get(number)!
            issue.state = "open"; issue.closedAt = null; issue.updatedAt = ++ctx.github.now
            yield* apply(number)
          }
          yield* host.signal(WaitFor.deferred(`todo/pull/${number}`).name)
        })
        yield* apply(pull1.number, signal)
        const resumed = yield* host.alarm()
        if (terminal === "merged") {
          // A consumed base signal leaves a clean park on this PR, rather than repeated Undriven alarms.
          expect(resumed._tag).toBe("Parked")
          expect(ctx.github.pulls.get(published.prNumber)!.base).toBe("main")
          ctx.github.merge(published.prNumber)
          yield* apply(published.prNumber, signal)
          expect((yield* host.alarm())._tag).toBe("Settled")
        } else {
          expect(resumed._tag).toBe("Settled")
          expect(ctx.github.issues.get(published.prNumber)!.state).toBe("closed")
        }
      }))
      expect(await sql(runtime, `SELECT status FROM ${schema}.flows_runs WHERE run_id = '${executionId}'`))
        .toEqual([{ status: terminal === "merged" ? "completed" : "failed" }])
    } finally {
      await sql(runtime, `DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    }
  })

  test("a restored stacked wait whose base has no PR parks on its own PR and settles on its close", async () => {
    const ctx = await setup()
    const first = (await commit("One", "First"))!
    await sql(runtime, "UPDATE stacks SET lanes = 2")
    const base = "smithers/unpublished"
    const sha = ctx.github.push(base, { "ONE.md": "one" })
    await runtime.runPromise(Stack.report(first, { kind: "branch", branch: base, baseRef: "main", baseSha: sha }, { runs: true }))
    const second = (await commit("Two", "Second"))!
    const branch = "smithers/restored"
    ctx.github.refs.set(branch, sha)
    const pull = ctx.github.openPull(branch)
    pull.base = base
    await runtime.runPromise(Stack.report(second, { kind: "branch", branch, baseRef: base, baseSha: sha }, { runs: true }))
    await runtime.runPromise(Stack.report(second, { kind: "published", headSha: sha, prNumber: pull.number, draft: true }, { runs: true }))
    const begun = { ...onMain(branch), baseRef: base, baseSha: sha }
    const published = { headSha: sha, prNumber: pull.number }
    const Probe = Flow.make("todo", { payload: Todo.TodoRequest, success: Todo.Awaited, error: Todo.Await.errorSchema,
      body: Node.capture({ begun, published, await: Todo.Await.name }, (request) => Todo.Await.call({ request, begun, published })),
    })
    const registration = Interpreter.layerWithImplementations(Probe, Todo.Await.toLayer(Todo.steps(ctx.services).awaitMerge))
      .pipe(Layer.provideMerge(Action.layerImplementations))
    const schema = `flows_${crypto.randomUUID().replaceAll("-", "")}`
    const url = (await runtime.runPromise(TestDatabase.serverUrl)).toString()
    const values = new Map<string, unknown>()
    const storage: ExecutionHost.Storage = {
      get: <A>(key: string) => Effect.sync(() => structuredClone(values.get(key)) as A | undefined),
      put: (key, value) => Effect.sync(() => void values.set(key, structuredClone(value))),
      delete: (key) => Effect.sync(() => values.delete(key)),
      setAlarm: () => Effect.void, deleteAlarm: () => Effect.void,
    }
    const executionId = todoExecutionId(second.attemptId)
    const host = ExecutionHost.make(storage, { hostId: executionId, database: ExecutionHost.database(url, schema),
      flows: { flows: [Probe], registration }, router: { start: () => Effect.void, wake: () => Effect.void },
    })
    try {
      await Effect.runPromise(Effect.gen(function* () {
        yield* host.start(yield* ExecutionHost.intent(Probe, { executionId, payload: second }))
        expect((yield* host.alarm())._tag).toBe("Parked")
        ctx.github.close(pull.number)
        yield* host.signal(WaitFor.deferred(`todo/pull/${pull.number}`).name)
        expect((yield* host.alarm())._tag).toBe("Settled")
      }))
      expect(await sql(runtime, `SELECT status FROM ${schema}.flows_runs WHERE run_id = '${executionId}'`)).toEqual([{ status: "completed" }])
      expect(await todo(1)).toMatchObject({ state: "working", prNumber: null })
    } finally {
      await sql(runtime, `DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    }
  })

  test.each(["drop", "webhook"] as const)("%s cancels a successor during implementation without publishing; Retry uses main", async (trigger) => {
    let implementing = false
    let cancellations = 0
    let cancel: (id: string) => Effect.Effect<void, unknown> = () => Effect.die("host not built")
    const ctx = await setup({
      cancel: (id) => cancel(id),
      model: Model.make({ stream: () => Stream.suspend(() => { implementing = true; return Stream.never }) }),
    })
    const start1 = (await commit("One", "First"))!
    await commit("Two", "Second")
    const branch = "smithers/base"
    const sha = ctx.github.push(branch, { "ONE.md": "one" })
    const pull = ctx.github.openPull(branch)
    await runtime.runPromise(Stack.report(start1, { kind: "branch", branch, baseRef: "main", baseSha: sha }, { runs: true }))
    const publication = await runtime.runPromise(Stack.report(start1, { kind: "published", headSha: sha, prNumber: pull.number, draft: false }, { runs: true }))
    const start2 = publication.starts[0]!
    await commit("Three", "Queued")
    const scope = Effect.runSync(Scope.make())
    try {
      const { context, engine } = await Effect.runPromise(build(ctx.registration).pipe(Effect.provideService(Scope.Scope, scope)))
      const flows = Context.get(context, FlowRuntime.FlowRuntime)
      cancel = (id) => Effect.suspend((): Effect.Effect<void, unknown> => {
        cancellations++
        // A failed handoff is owned by the cleanup action's durable retry, never a polling loop.
        if (trigger === "drop" && cancellations === 1) return Effect.fail(new Stack.RunsUnavailable({ errorCode: "injected" }))
        return flows.interrupt(Todo.Todo, id).pipe(Effect.provide(context))
      })
      await Effect.runPromise(flows.execute(Todo.Todo, { executionId: todoExecutionId(start2.attemptId), payload: start2, discard: true }).pipe(Effect.provide(context)))
      await eventually(() => implementing, 30_000)
      if (trigger === "drop") {
        await runtime.runPromise(Stack.apply({ opId: crypto.randomUUID(), repoId: REPOSITORY.id, actor: maya,
          via: "person", op: { kind: "drop", number: 1 } }, { runs: true }))
      } else {
        ctx.github.close(pull.number)
        await runtime.runPromise(Apply.read({ ...ctx.services,
          invalidateTodo: (stop) => flows.execute(TodoBaseClosed.Invalidate, { executionId: `todo-closed:${stop.attemptId}`, payload: stop, discard: true }).pipe(Effect.provide(context)),
        })({ deliveryId: crypto.randomUUID(), repo: `${REPOSITORY.owner}/${REPOSITORY.name}`, number: pull.number, event: "pull_request" }))
      }
      await Effect.runPromise(flows.execute(TodoBaseClosed.Invalidate, { executionId: `${trigger === "drop" ? "todo-drop" : "todo-closed"}:${start1.attemptId}`, payload: { attemptId: start1.attemptId, todoId: start1.todoId, baseClosed: true } }).pipe(Effect.provide(context)))
      await eventually(async () => (await Effect.runPromise(engine.status(todoExecutionId(start2.attemptId)))) === "cancelled", 20_000)
      expect(await todo(2)).toMatchObject({ state: "failed", failure: "base_closed", prNumber: null })
      const cancellationCount = cancellations
      expect(cancellationCount).toBe(trigger === "drop" ? 2 : 1)
      await Effect.runPromise(flows.execute(TodoBaseClosed.Invalidate, {
        executionId: `${trigger === "drop" ? "todo-drop" : "todo-closed"}:${start1.attemptId}`,
        payload: { attemptId: start1.attemptId, todoId: start1.todoId, baseClosed: true },
      }).pipe(Effect.provide(context)))
      expect(cancellations).toBe(cancellationCount)
      expect(await todo(3)).toMatchObject({ state: "failed", failure: "base_closed", branch: null })
      expect(ctx.github.pulls.size).toBe(1)
      expect(ctx.starts.filter((entry) => entry.flow === "checks/Run")).toHaveLength(0)
      const retry = await runtime.runPromise(Stack.apply({ opId: crypto.randomUUID(), repoId: REPOSITORY.id, actor: maya,
        via: "person", op: { kind: "retry", number: 2 } }, { runs: true }))
      if (retry.kind !== "applied") throw new Error("retry refused")
      const begun = await dispatched(ctx, (steps) => steps.begin({ request: retry.receipt.starts[0]! })) as Exit.Exit<Todo.Begun>
      expect(begun).toMatchObject({ _tag: "Success", value: { baseRef: "main" } })
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  })

  test.each(["closed", "refused", "retry"] as const)("invalidation settles a parked published descendant before PR cleanup: %s", async (outcome) => {
    const ctx = await setup()
    const { start1, start2, begun, published } = await stacked(ctx)
    const Waiting = Flow.make("todo", { payload: Todo.TodoRequest, success: Todo.Awaited,
      capabilities: ["db:write:todos", "db:write:todo_attempts", "db:write:items", "db:write:pulls"],
      error: Todo.Await.errorSchema,
      body: Node.capture({ begun, published, await: Todo.Await.name }, (request) => Todo.Await.call({ request, begun, published })),
    })
    let cancel: (id: string) => Effect.Effect<void, unknown> = () => Effect.die("host not built")
    let discoveryConnections = 0
    const recoverableDatabase = Layer.unwrap(Effect.sync(() =>
      ++discoveryConnections === 1 ? unreachable : ctx.services.database))
    const registration = Layer.mergeAll(
      Interpreter.layerWithImplementations(Waiting, Todo.Await.toLayer(Todo.steps(ctx.services).awaitMerge)).pipe(Layer.provideMerge(Action.layerImplementations)),
      TodoBaseClosed.registration({ ...ctx.services, database: recoverableDatabase, cancel: (id) => cancel(id) }),
    )
    const scope = Effect.runSync(Scope.make())
    try {
      const { context, engine } = await Effect.runPromise(build(registration).pipe(Effect.provideService(Scope.Scope, scope)))
      const flows = Context.get(context, FlowRuntime.FlowRuntime)
      cancel = (id) => flows.interrupt(Waiting, id).pipe(Effect.provide(context))
      const executionId = todoExecutionId(start2.attemptId)
      await Effect.runPromise(flows.execute(Waiting, { executionId, payload: start2, discard: true }).pipe(Effect.provide(context)))
      await eventually(async () => (await Effect.runPromise(engine.status(executionId))) === "suspended", 20_000)
      await runtime.runPromise(Stack.apply({ opId: crypto.randomUUID(), repoId: REPOSITORY.id, actor: maya,
        via: "person", op: { kind: "drop", number: 1 } }, { runs: true }))
      if (outcome !== "closed") ctx.github.faults.push({
        match: (method, path) => method === "PATCH" && path.endsWith(`/pulls/${published.prNumber}`),
        status: outcome === "refused" ? 403 : 503,
      })
      await Effect.runPromise(flows.execute(TodoBaseClosed.Invalidate, { executionId: crypto.randomUUID(),
        payload: { attemptId: start1.attemptId, todoId: start1.todoId, baseClosed: true } }).pipe(Effect.provide(context)))
      await eventually(async () => (await Effect.runPromise(engine.status(executionId))) === "cancelled", 20_000)
      expect(ctx.github.issues.get(published.prNumber)!.state).toBe(outcome === "refused" ? "open" : "closed")
      expect(await todo(2)).toMatchObject({ state: "failed", failure: "base_closed" })
      expect(discoveryConnections).toBeGreaterThan(1)
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  })

  test("a failed predecessor's close delivery preserves queued successors for its Retry", async () => {
    const ctx = await setup()
    const start = (await commit("One", "First"))!
    const branch = "smithers/base"
    const sha = ctx.github.push(branch, { "ONE.md": "one" })
    const pull = ctx.github.openPull(branch)
    await runtime.runPromise(Stack.report(start, { kind: "branch", branch, baseRef: "main", baseSha: sha }, { runs: true }))
    await runtime.runPromise(Stack.report(start, { kind: "published", headSha: sha, prNumber: pull.number, draft: false }, { runs: true }))
    await runtime.runPromise(Stack.apply({ opId: crypto.randomUUID(), repoId: REPOSITORY.id, actor: maya, via: "person",
      op: { kind: "commit", title: "Two", prompt: "Queued", acceptance: [] } }, { runs: false }))
    await runtime.runPromise(Stack.report(start, { kind: "finished", state: "failed", failure: "pr_refused" }, { runs: true }))
    ctx.github.close(pull.number)
    await runtime.runPromise(Apply.read(ctx.services)({ deliveryId: crypto.randomUUID(),
      repo: `${REPOSITORY.owner}/${REPOSITORY.name}`, number: pull.number, event: "pull_request" }))
    await runtime.runPromise(Stack.descendants({ ...start, baseClosed: true }))
    expect(await todo(2)).toMatchObject({ state: "queued", failure: null })
    const retried = await runtime.runPromise(Stack.apply({ opId: crypto.randomUUID(), repoId: REPOSITORY.id, actor: maya,
      via: "person", op: { kind: "retry", number: 1 } }, { runs: true }))
    if (retried.kind !== "applied") throw new Error("retry refused")
    const next = retried.receipt.starts[0]!
    const published = await runtime.runPromise(Stack.report(next, { kind: "published", headSha: sha, prNumber: pull.number + 1, draft: false }, { runs: true }))
    expect(published.starts).toMatchObject([{ number: 2, ordinal: 1 }])
  })

  test("a projected close blocks another lane before invalidation is launched", async () => {
    const ctx = await setup()
    const { start1, pull1 } = await stacked(ctx)
    ctx.github.close(pull1.number)
    // The real projection commits, while its invalidation launch has not happened yet.
    await runtime.runPromise(Apply.read(ctx.services)({ deliveryId: crypto.randomUUID(),
      repo: `${REPOSITORY.owner}/${REPOSITORY.name}`, number: pull1.number, event: "pull_request" }))
    await sql(runtime, "UPDATE stacks SET lanes = 2")
    expect(await commit("Three", "Queued behind the closed base")).toBeUndefined()
    expect(await todo(3)).toMatchObject({ state: "queued", branch: null })
    await runtime.runPromise(Stack.descendants({ ...start1, baseClosed: true }))
    expect(await todo(3)).toMatchObject({ state: "failed", failure: "base_closed", branch: null })
  })

  test("a close delivery still addresses the original attempt after Retry replaces its PR projection", async () => {
    const ctx = await setup()
    const { start1, pull1 } = await stacked(ctx)
    await runtime.runPromise(Stack.report(start1, { kind: "finished", state: "failed", failure: "implement" }, { runs: true }))
    await runtime.runPromise(Stack.apply({ opId: crypto.randomUUID(), repoId: REPOSITORY.id, actor: maya,
      via: "person", op: { kind: "retry", number: 1 } }, { runs: false }))
    ctx.github.close(pull1.number)
    const requests: Array<unknown> = []
    await runtime.runPromise(Apply.read({ ...ctx.services,
      invalidateTodo: (stop) => Effect.sync(() => void requests.push(stop)),
    })({ deliveryId: crypto.randomUUID(), repo: `${REPOSITORY.owner}/${REPOSITORY.name}`, number: pull1.number, event: "pull_request" }))
    expect(requests).toEqual([{ attemptId: start1.attemptId, todoId: start1.todoId, baseClosed: true }])
  })

  test("a base lookup outage after inspecting an open PR returns an unavailable wait, then recovers", async () => {
    const ctx = await setup()
    const { start2, begun, published } = await stacked(ctx)
    let opened = 0
    const flaky = { ...ctx, services: { ...ctx.services,
      database: Layer.unwrap(Effect.sync(() => ++opened === 2 ? unreachable : ctx.services.database)),
    } }
    const payload = { request: start2, begun, published }
    expect(failure(await step(flaky, (steps) => steps.awaitMerge(payload)))).toMatchObject({ step: "await" })
    expect(opened).toBe(2)
    expect(await todo(2)).toMatchObject({ state: "in_review", prNumber: published.prNumber })
    expect(failure(await step(ctx, (steps) => steps.await(payload)))).toMatchObject({ _tag: "@smthrs/mvp/todo/StillOpen" })
  })

  test("a closed base fences collection and publishing before another PR is created", async () => {
    const ctx = await setup()
    const { start2, begun } = await stacked(ctx)
    await runtime.runPromise(Stack.apply({ opId: crypto.randomUUID(), repoId: REPOSITORY.id, actor: maya,
      via: "person", op: { kind: "drop", number: 1 } }, { runs: true }))
    for (const event of [
      { kind: "step", step: "implement" },
      { kind: "branch", branch: begun.branch, baseSha: begun.baseSha, baseRef: begun.baseRef! },
      { kind: "published", headSha: begun.baseSha, prNumber: 999, draft: true },
    ] as const) {
      expect(await runtime.runPromise(Stack.report(start2, event, { runs: true })))
        .toEqual({ outcome: "base_closed", starts: [] })
    }
    const count = ctx.github.pulls.size
    expect(failure(await step(ctx, (steps) => steps.collect({ request: start2, begun })))).toMatchObject({ failure: "base_closed" })
    expect(failure(await step(ctx, (steps) => steps.publish({ request: start2, begun, collected: { additions: [], deletions: [] } })))).toMatchObject({ failure: "base_closed" })
    expect(ctx.github.pulls.size).toBe(count)
  })

  test("stacked: T2 starts on T1's branch, its pull request a draft into T1's branch, its review reading only its change", async () => {
    const ctx = await setup()
    const { t1, t1Head, begun, published } = await stacked(ctx)
    expect(begun).toMatchObject({ baseRef: t1, baseSha: t1Head, defaultBranch: "main" })
    expect(begun.branch).toMatch(/^smithers\/t2-two-[0-9a-f]{12}$/)
    const pull2 = ctx.github.pulls.get(published.prNumber)!
    expect([pull2.head, pull2.base, pull2.draft]).toEqual([begun.branch, t1, true])
    expect(ctx.github.commits.get(published.headSha)!.parents).toEqual([t1Head])
    expect(await todo(2)).toMatchObject({ state: "in_review", branch: begun.branch, baseSha: t1Head, headSha: published.headSha })
    expect(await sql(runtime, `SELECT base_ref AS "baseRef", pr_draft AS "draft" FROM todos WHERE number = 2`))
      .toEqual([{ baseRef: t1, draft: true }])
    const checks = ctx.starts.find((start) => start.flow === ChecksRun._tag)!
    expect(checks.payload).toMatchObject({ sha: published.headSha, baseSha: t1Head, prNumber: published.prNumber })
  })

  test.each([
    { stopped: false, replacement: false, merged: false, admit: true },
    { stopped: true, replacement: false, merged: false, admit: true },
    { stopped: true, replacement: true, merged: false, admit: true },
    { stopped: true, replacement: true, merged: true, admit: true },
    { stopped: true, replacement: false, merged: false, admit: false },
  ])("stacked: a retried predecessor retains its old base identity %j", async ({ stopped, replacement, merged, admit }) => {
    const ctx = await setup()
    const { attempt1, t1, pull1, start2, begun, published } = await stacked(ctx)
    if (!stopped) await runtime.runPromise(Stack.report(attempt1,
      { kind: "finished", state: "failed", failure: "implement" }, { runs: true }))
    const retried = await runtime.runPromise(Stack.apply({
      opId: crypto.randomUUID(), repoId: REPOSITORY.id, actor: maya, via: "person",
      op: { kind: "retry", number: 1 },
    }, { runs: admit, ...(stopped ? { stoppedAttemptId: attempt1.attemptId } : {}) }))
    if (retried.kind !== "applied") throw new Error("retry refused")
    expect(await runtime.runPromise(Stack.baseTodoOf(REPOSITORY.id, t1))).toMatchObject({
      value: { number: 1, prNumber: pull1.number, state: "failed" },
    })
    if (replacement) {
      const next = retried.receipt.starts[0]!
      await runtime.runPromise(Stack.report(next, {
        kind: "branch", branch: "smithers/replacement", baseSha: BASE(), baseRef: "main",
      }, { runs: true }))
      await runtime.runPromise(Stack.report(next, {
        kind: "published", headSha: BASE(), prNumber: 99, draft: false,
      }, { runs: true }))
    }
    if (merged) {
      ctx.github.merge(pull1.number, "maya")
      await runtime.runPromise(Apply.read(ctx.services)({
        deliveryId: crypto.randomUUID(), repo: `${REPOSITORY.owner}/${REPOSITORY.name}`,
        number: pull1.number, event: "pull_request",
      }))
    }
    const result = await step(ctx, (steps) => steps.await({ request: start2, begun, published }))
    if (merged) {
      expect(failure(result)).toMatchObject({ _tag: "@smthrs/mvp/todo/StillOpen" })
      expect(ctx.github.pulls.get(published.prNumber)).toMatchObject({ base: "main", draft: false })
    } else {
      expect(failure(result)).toMatchObject({ failure: "base_closed" })
      expect(ctx.github.issues.get(published.prNumber)!.state).toBe("closed")
    }
  })

  test("stacked: T1 merged, T2 takes the merge in, its new head's checks start, and it moves onto main, ready", async () => {
    const ctx = await setup()
    const { attempt1, pull1, start2, begun, published } = await stacked(ctx)
    // Waiting while T1 is in review: nothing moves.
    const waiting = await step(ctx, (steps) => steps.await({ request: start2, begun, published }))
    expect(failure(waiting)).toMatchObject({ _tag: "@smthrs/mvp/todo/StillOpen" })
    expect(ctx.github.seen("POST", /\/merges$/)).toHaveLength(0)
    // A person squash-merges T1; its run settles it.
    const squash = ctx.github.merge(pull1.number, "maya")
    await runtime.runPromise(Stack.report(attempt1, { kind: "finished", state: "merged", mergeSha: squash }, { runs: true }))
    const restacked = await step(ctx, (steps) => steps.await({ request: start2, begun, published }))
    expect(failure(restacked)).toMatchObject({ _tag: "@smthrs/mvp/todo/StillOpen" })
    const pull2 = ctx.github.pulls.get(published.prNumber)!
    const head = ctx.github.refs.get(begun.branch)!
    expect([pull2.base, pull2.draft]).toEqual(["main", false])
    // Merged forward, never rebased: T2's own commit, then the merge of T1's squash.
    expect(ctx.github.commits.get(head)!.parents).toEqual([published.headSha, squash])
    expect(ctx.github.commits.get(head)!.message).toBe("Merge T1 from main into T2")
    expect([...ctx.github.tree(begun.branch).keys()].sort()).toEqual(["ONE.md", "README.md", "TWO.md"])
    expect(await todo(2)).toMatchObject({ state: "in_review", headSha: head })
    expect(await sql(runtime, `SELECT pr_draft AS "draft" FROM todos WHERE number = 2`)).toEqual([{ draft: false }])
    // The new head's checks start, the review reading from T1's merge: T2's change alone.
    const checks = ctx.starts.filter((start) => start.flow === ChecksRun._tag).at(-1)!
    expect(checks.payload).toMatchObject({ sha: head, baseSha: squash })
    // Asked again: on main, nothing to take in.
    await step(ctx, (steps) => steps.await({ request: start2, begun, published }))
    expect(ctx.github.seen("POST", /\/merges$/)).toHaveLength(1)
    // A person merges T2 into main.
    ctx.github.merge(published.prNumber, "maya")
    const merged = await step(ctx, (steps) => steps.await({ request: start2, begun, published }))
    expect(merged._tag === "Success" && merged.value).toMatchObject({ state: "merged" })
    expect([...ctx.github.tree("main").keys()].sort()).toEqual(["ONE.md", "README.md", "TWO.md"])
  })

  test("stacked: a restack cut short does the rest again, each part once", async () => {
    const ctx = await setup()
    const { attempt1, pull1, start2, begun, published } = await stacked(ctx)
    const squash = ctx.github.merge(pull1.number, "maya")
    await runtime.runPromise(Stack.report(attempt1, { kind: "finished", state: "merged", mergeSha: squash }, { runs: true }))
    // The merge lands but its answer is lost; then moving the base fails once.
    ctx.github.faults.push(
      { match: (method, path) => method === "POST" && path.endsWith("/merges"), lost: true },
      { match: (method, path) => method === "PATCH" && /\/pulls\/\d+$/.test(path), status: 502 },
    )
    expect(failure(await step(ctx, (steps) => steps.await({ request: start2, begun, published })))).toMatchObject({ step: "await" })
    expect(failure(await step(ctx, (steps) => steps.await({ request: start2, begun, published })))).toMatchObject({ step: "await" })
    expect(failure(await step(ctx, (steps) => steps.await({ request: start2, begun, published }))))
      .toMatchObject({ _tag: "@smthrs/mvp/todo/StillOpen" })
    const pull2 = ctx.github.pulls.get(published.prNumber)!
    expect([pull2.base, pull2.draft]).toEqual(["main", false])
    const merges = [...ctx.github.commits.values()].filter((found) => found.message === "Merge T1 from main into T2")
    expect(merges).toHaveLength(1)
    expect(await todo(2)).toMatchObject({ headSha: merges[0]!.sha })
  })

  test("stacked: T1 closed unmerged closes T2's pull request and fails it base_closed", async () => {
    const ctx = await setup()
    const { attempt1, pull1, start2, begun, published } = await stacked(ctx)
    ctx.github.close(pull1.number)
    await runtime.runPromise(Stack.report(attempt1, { kind: "finished", state: "dropped", note: "closed_on_github" }, { runs: true }))
    const closed = await step(ctx, (steps) => steps.await({ request: start2, begun, published }))
    expect(failure(closed)).toMatchObject({ failure: "base_closed" })
    expect(ctx.github.issues.get(published.prNumber)!.state).toBe("closed")
    const failed = await step(ctx, (steps) => steps.fail({ request: start2, error: new Todo.TodoFailed({ failure: "base_closed" }) }))
    expect(failed._tag === "Success" && failed.value).toEqual({ state: "failed" })
    expect(await todo(2)).toMatchObject({ state: "failed", failure: "base_closed" })
  })

  test("stacked: T2 changing what T1 merged conflicts, and the run gives up pr_refused", async () => {
    const ctx = await setup()
    const { attempt1, pull1, start2, begun, published } = await stacked(ctx, { "ONE.md": "2\n" })
    // T1's squash adds ONE.md to main, which T2's branch changed since: an add on each side, so GitHub can't merge them.
    const squash = ctx.github.merge(pull1.number, "maya")
    await runtime.runPromise(Stack.report(attempt1, { kind: "finished", state: "merged", mergeSha: squash }, { runs: true }))
    const conflicted = await step(ctx, (steps) => steps.await({ request: start2, begun, published }))
    expect(failure(conflicted)).toMatchObject({ failure: "pr_refused" })
    // Its pull request is closed as the App, never left a draft into a branch that merged.
    expect(ctx.github.pulls.get(published.prNumber)!.base).toBe("smithers/t1-one")
    expect(ctx.github.issues.get(published.prNumber)!.state).toBe("closed")
  })

  test("stacked: a close whose answer was lost still ends base_closed, never as closed on GitHub", async () => {
    const ctx = await setup()
    const { attempt1, pull1, start2, begun, published } = await stacked(ctx)
    ctx.github.close(pull1.number)
    await runtime.runPromise(Stack.report(attempt1, { kind: "finished", state: "dropped", note: "closed_on_github" }, { runs: true }))
    // The run closed T2's pull request, and the answer never came back.
    ctx.github.close(published.prNumber)
    const again = await step(ctx, (steps) => steps.await({ request: start2, begun, published }))
    expect(failure(again)).toMatchObject({ failure: "base_closed" })
    expect(ctx.github.seen("PATCH", new RegExp(`/pulls/${published.prNumber}$`))).toHaveLength(0)
  })

  test("stacked three high: T2 failed base_closed, T3 on T2's branch closes its own and fails base_closed too", async () => {
    const ctx = await setup()
    const { start2, begun, published } = await stacked(ctx)
    // T3 was already admitted while T2 was published; a later failure must close it too.
    const start3 = (await commit("Three", "Last."))!
    // T2 failed, its pull request closed: nothing will merge or restack it.
    await runtime.runPromise(Stack.report(
      { attemptId: start2.attemptId, todoId: start2.todoId, repoId: REPOSITORY.id, ordinal: start2.ordinal },
      { kind: "finished", state: "failed", failure: "base_closed" },
      { runs: true },
    ))
    ctx.github.close(published.prNumber)
    // T3, stacked on T2's branch.
    const t3 = ctx.github.push("smithers/t3-three", { "THREE.md": "3\n" })
    ctx.github.refs.set("smithers/t3-three", t3)
    const pull3 = ctx.github.openPull("smithers/t3-three", "T3: Three", BOT_LOGIN)
    pull3.base = begun.branch
    pull3.draft = true
    expect(start3).toBeDefined()
    const begun3 = { ...begun, branch: "smithers/t3-three", baseRef: begun.branch }
    const closed = await step(ctx, (steps) =>
      steps.await({ request: start3, begun: begun3, published: { headSha: t3, prNumber: pull3.number } })
    )
    expect(failure(closed)).toMatchObject({ failure: "base_closed" })
    expect(ctx.github.issues.get(pull3.number)!.state).toBe("closed")
  })

  test("stacked: moved onto main but stopped before it was marked ready, the next await marks it ready", async () => {
    const ctx = await setup()
    const { attempt1, pull1, start2, begun, published } = await stacked(ctx)
    const squash = ctx.github.merge(pull1.number, "maya")
    await runtime.runPromise(Stack.report(attempt1, { kind: "finished", state: "merged", mergeSha: squash }, { runs: true }))
    // GraphQL refuses the mark once: the base already moved, the pull request still a draft.
    ctx.github.faults.push({ match: (method, path) => method === "POST" && path === "/graphql", status: 502 })
    expect(failure(await step(ctx, (steps) => steps.await({ request: start2, begun, published })))).toMatchObject({ step: "await" })
    expect([ctx.github.pulls.get(published.prNumber)!.base, ctx.github.pulls.get(published.prNumber)!.draft]).toEqual(["main", true])
    expect(failure(await step(ctx, (steps) => steps.await({ request: start2, begun, published }))))
      .toMatchObject({ _tag: "@smthrs/mvp/todo/StillOpen" })
    expect(ctx.github.pulls.get(published.prNumber)!.draft).toBe(false)
    expect(await sql(runtime, `SELECT pr_draft AS "draft" FROM todos WHERE number = 2`)).toEqual([{ draft: false }])
    expect(ctx.github.seen("POST", /\/merges$/)).toHaveLength(1)
  })

  test("stacked: a pull request a person took out of draft is moved onto main and not marked again", async () => {
    const ctx = await setup()
    const { attempt1, pull1, start2, begun, published } = await stacked(ctx)
    ctx.github.pulls.get(published.prNumber)!.draft = false
    const squash = ctx.github.merge(pull1.number, "maya")
    await runtime.runPromise(Stack.report(attempt1, { kind: "finished", state: "merged", mergeSha: squash }, { runs: true }))
    expect(failure(await step(ctx, (steps) => steps.await({ request: start2, begun, published }))))
      .toMatchObject({ _tag: "@smthrs/mvp/todo/StillOpen" })
    expect(ctx.github.pulls.get(published.prNumber)!.base).toBe("main")
    expect(ctx.github.seen("POST", /^\/graphql$/).length).toBe(1)
  })

  test("stacked: a person closing the stacked pull request on GitHub drops the TODO, its base still in review", async () => {
    const ctx = await setup()
    const { start2, begun, published } = await stacked(ctx)
    ctx.github.close(published.prNumber)
    const closed = await step(ctx, (steps) => steps.await({ request: start2, begun, published }))
    expect(closed._tag === "Success" && closed.value).toEqual({ state: "closed", mergeSha: null })
  })

  test("stacked from one issue: the bottom pull request says Part of #n, the top one Fixes #n", async () => {
    const ctx = await setup()
    const issue = ctx.github.open("Two things", "Both.")
    const { start1, begun, published } = await stacked(ctx, { "TWO.md": "2\n" }, issue.number)
    expect(ctx.github.issues.get(published.prNumber)!.body).toContain(`Fixes #${issue.number}`)
    // T1, published below T2 from the same issue, says Part of.
    const t1Begun = { ...begun, branch: "smithers/t1-own", baseRef: "main", baseSha: ctx.github.refs.get("main")!, issueNumber: issue.number }
    ctx.github.refs.set("smithers/t1-own", ctx.github.refs.get("main")!)
    const collected = { additions: [{ path: "OWN.md", contents: btoa("own\n") }], deletions: [] }
    const own = await dispatched(ctx, (steps) => steps.publish({ request: start1, begun: t1Begun, collected })) as Exit.Exit<
      Todo.Published
    >
    expect(own._tag === "Success" && ctx.github.issues.get(own.value.prNumber)!.body).toContain(`Part of #${issue.number}`)
    expect(Todo.pullBodyOf({ ...begun, issueNumber: 3 }, false)).toContain("Part of #3")
  })

  test("a run stopped after its publish committed and before the next TODO's start, then dropped, still starts it", async () => {
    const ctx = await setup()
    const start1 = (await commit("One", "First."))!
    await commit("Two", "Then this.")
    const attempt1 = { attemptId: start1.attemptId, todoId: start1.todoId, repoId: REPOSITORY.id, ordinal: start1.ordinal }
    const { starts } = await runtime.runPromise(
      Stack.report(attempt1, { kind: "published", headSha: BASE(), prNumber: 1, draft: false }, { runs: true }),
    )
    expect(starts).toHaveLength(1)
    await runtime.runPromise(Stack.apply({ opId: crypto.randomUUID(), repoId: REPOSITORY.id, actor: maya, via: "person", op: { kind: "drop", number: 1 } }, {
      runs: true,
    }))
    const collected = { additions: [{ path: "A.md", contents: btoa("a\n") }], deletions: [] }
    const replayed = await step(ctx, (steps) => steps.publish({ request: start1, begun: begun(ctx, "main"), collected }))
    expect(failure(replayed)).toMatchObject({ failure: "ended" })
    expect(ctx.starts.filter((start) => start.flow === Todo.Todo._tag).map((start) => start.executionId))
      .toEqual([todoExecutionId(starts[0]!.attemptId)])
    expect(await runtime.runPromise(Stack.publishedStarts({ ...attempt1, attemptId: crypto.randomUUID() }))).toEqual([])
  })

  test("a run that reached its await before stacking carries no begun: never stacked, it just waits", async () => {
    const ctx = await setup()
    const start = (await commit("Old", "Do it."))!
    ctx.github.push("feature", { "O.md": "o\n" })
    const pull = ctx.github.openPull("feature")
    const waiting = await step(ctx, (steps) => steps.await({ request: start, published: { headSha: BASE(), prNumber: pull.number } }))
    expect(failure(waiting)).toMatchObject({ _tag: "@smthrs/mvp/todo/StillOpen" })
    expect(Todo.baseOf({ ...begun(ctx, "feature"), baseRef: undefined })).toBe("main")
  })

  test("begin: a missing base branch is refused instead of starting from main", async () => {
    const ctx = await setup()
    const start1 = (await commit("One", "First."))!
    await commit("Two", "Then this.")
    const attempt1 = { attemptId: start1.attemptId, todoId: start1.todoId, repoId: REPOSITORY.id, ordinal: start1.ordinal }
    await runtime.runPromise(Stack.report(attempt1, { kind: "branch", branch: "smithers/t1-gone", baseSha: BASE(), baseRef: "main" }, {
      runs: true,
    }))
    const { starts } = await runtime.runPromise(
      Stack.report(attempt1, { kind: "published", headSha: BASE(), prNumber: 1, draft: false }, { runs: true }),
    )
    const begun2 = await dispatched(ctx, (steps) => steps.begin({ request: starts[0]! }))
    expect(failure(begun2)).toMatchObject({ failure: "base_closed" })
  })

  test.each([true, false])("a restored attempt without a pinned base checks its predecessor's branch (exists=%s)", async (exists) => {
    const ctx = await setup()
    const first = (await commit("One", "First"))!
    await commit("Two", "Second")
    const branch = "smithers/legacy-base"
    const sha = exists ? ctx.github.push(branch, { "ONE.md": "one" }) : BASE()
    await runtime.runPromise(Stack.report(first, { kind: "branch", branch, baseRef: "main", baseSha: sha }, { runs: true }))
    const second = (await runtime.runPromise(Stack.report(first, { kind: "published", headSha: sha, prNumber: 1, draft: false }, { runs: true }))).starts[0]!
    // The persisted shape before admission pinned the base: Begin must still restore it.
    await sql(runtime, `UPDATE todos SET base_ref = NULL WHERE id = '${second.todoId}'`)
    const result = await dispatched(ctx, (steps) => steps.begin({ request: second }))
    if (exists) expect(result).toMatchObject({ _tag: "Success", value: { baseRef: branch, baseSha: sha } })
    else expect(failure(result)).toMatchObject({ failure: "base_closed" })
  })

  test("a base dropped after branch creation fences the branch report before implementation", async () => {
    const ctx = await setup()
    const first = (await commit("One", "First"))!
    await commit("Two", "Second")
    const branch = "smithers/base"
    const sha = ctx.github.push(branch, { "ONE.md": "one" })
    await runtime.runPromise(Stack.report(first, { kind: "branch", branch, baseRef: "main", baseSha: sha }, { runs: true }))
    const start2 = (await runtime.runPromise(Stack.report(first, { kind: "published", headSha: sha, prNumber: 1, draft: false }, { runs: true }))).starts[0]!
    const http = HttpClient.transform(ctx.services.http, (execute, request) => execute.pipe(
      Effect.tap(() => request.method === "POST" && request.url.endsWith("/git/refs")
        ? Stack.apply({ opId: crypto.randomUUID(), repoId: REPOSITORY.id, actor: maya, via: "person",
          op: { kind: "drop", number: 1 } }, { runs: true }).pipe(Effect.provide(ctx.services.database), Effect.orDie)
        : Effect.void),
    ))
    const raced = { ...ctx, services: { ...ctx.services, http } }
    const result = await dispatched(raced, (steps) => steps.begin({ request: start2 }))
    expect(failure(result)).toMatchObject({ failure: "base_closed" })
    expect(await todo(2)).toMatchObject({ branch: null })
    expect(await todo(1)).toMatchObject({ state: "dropped" })
  })

  test.each(["gone", "merged", "open"] as const)("a wait reads an unprojected %s predecessor from GitHub", async (state) => {
    const ctx = await setup()
    const { pull1, start2, begun, published } = await stacked(ctx)
    if (state === "gone") ctx.github.remove(pull1.number)
    if (state === "merged") ctx.github.merge(pull1.number)
    const result = await step(ctx, (steps) => steps.await({ request: start2, begun, published }))
    if (state === "gone") {
      expect(failure(result)).toMatchObject({ failure: "base_closed" })
      expect(ctx.github.issues.get(published.prNumber)!.state).toBe("closed")
    } else {
      expect(failure(result)).toMatchObject({ _tag: "@smthrs/mvp/todo/StillOpen" })
      expect(ctx.github.pulls.get(published.prNumber)!.base).toBe(state === "merged" ? "main" : begun.baseRef)
    }
  })

  test.each(["absent", "replaced", "merged", "dropped"] as const)("a saved invalidation leaves a now %s descendant alone", async (state) => {
    let cancellations = 0
    const ctx = await setup({ cancel: () => Effect.sync(() => { cancellations++ }) })
    const start = (await commit("One", "First"))!
    if (state === "merged" || state === "dropped") await runtime.runPromise(Stack.report(start, { kind: "finished", state }, { runs: true }))
    const request = { ...start, prNumber: null,
      ...(state === "absent" ? { attemptId: crypto.randomUUID() } : {}),
      ...(state === "replaced" ? { ordinal: start.ordinal + 1 } : {}),
    }
    await runtime.runPromise(TodoBaseClosed.stop(ctx.services)({ descendants: [request] }))
    expect(cancellations).toBe(0)
    expect(await todo(1)).toMatchObject({ state: state === "merged" || state === "dropped" ? state : "working" })
  })

  test.each(["missing", "interrupted"] as const)("invalidation with a %s cancellation service leaves the attempt unsettled", async (fault) => {
    const ctx = await setup(fault === "interrupted" ? { cancel: () => Effect.interrupt } : {})
    const start = (await commit("One", "First"))!
    const result = await runtime.runPromise(Effect.exit(TodoBaseClosed.stop(ctx.services)({ descendants: [{ ...start, prNumber: null }] })))
    if (fault === "missing") expect(failure(result)).toMatchObject({ step: "settle" })
    else expect(result._tag === "Failure" && Cause.hasInterrupts(result.cause)).toBe(true)
    expect(await todo(1)).toMatchObject({ state: "working", failure: null })
  })

  test("invalidation starts a queued Retry when cancelling a descendant frees its lane", async () => {
    const cancelled: Array<string> = []
    const ctx = await setup({ cancel: (id) => Effect.sync(() => { cancelled.push(id) }) })
    const first = (await commit("One", "First"))!
    await commit("Two", "Second")
    await runtime.runPromise(Stack.report(first, { kind: "branch", branch: "base", baseRef: "main", baseSha: BASE() }, { runs: true }))
    const second = (await runtime.runPromise(Stack.report(first, { kind: "published", headSha: BASE(), prNumber: 1, draft: false }, { runs: true }))).starts[0]!
    await commit("Three", "Third")
    await runtime.runPromise(Stack.apply({ opId: crypto.randomUUID(), repoId: REPOSITORY.id, actor: maya, via: "person", op: { kind: "drop", number: 1 } }, { runs: true }))
    await runtime.runPromise(Stack.apply({ opId: crypto.randomUUID(), repoId: REPOSITORY.id, actor: maya, via: "person", op: { kind: "retry", number: 3 } }, { runs: true }))
    await runtime.runPromise(TodoBaseClosed.stop(ctx.services)({ descendants: [{ ...second, prNumber: null }] }))
    expect(cancelled).toEqual([todoExecutionId(second.attemptId)])
    expect(ctx.starts).toMatchObject([{ flow: Todo.Todo._tag, payload: { number: 3 } }])
    expect(await todo(2)).toMatchObject({ state: "failed", failure: "base_closed" })
    expect(await todo(3)).toMatchObject({ state: "working" })
  })

  test("settle and fail: an ended run changes nothing, a stale report ends it, and Postgres down is retried", async () => {
    const ctx = await setup()
    const start = (await commit("Settle", "Do it."))!
    const ended = await step(ctx, (steps) => steps.settle({ request: start, awaited: { state: "ended", mergeSha: null } }))
    expect(ended._tag === "Success" && ended.value).toEqual({ state: "ended" })
    const stale = { ...start, ordinal: 9 }
    const settled = await step(ctx, (steps) => steps.settle({ request: stale, awaited: { state: "merged", mergeSha: BASE() } }))
    expect(settled._tag === "Success" && settled.value).toEqual({ state: "ended" })
    const failed = await step(ctx, (steps) => steps.fail({ request: stale, error: new Todo.TodoFailed({ failure: "implement" }) }))
    expect(failed._tag === "Success" && failed.value).toEqual({ state: "ended" })
    const endedFail = await step(ctx, (steps) => steps.fail({ request: start, error: new Todo.TodoFailed({ failure: "ended" }) }))
    expect(endedFail._tag === "Success" && endedFail.value).toEqual({ state: "ended" })
    const down = { ...ctx, services: { ...ctx.services, database: unreachable } }
    expect(failure(await step(down, (steps) => steps.settle({ request: start, awaited: { state: "merged", mergeSha: null } }))))
      .toMatchObject({ step: "settle" })
    expect(failure(await step(down, (steps) => steps.fail({ request: start, error: new Todo.StillOpen() }))))
      .toMatchObject({ step: "settle" })
    expect(failure(await step(down, (steps) => steps.await({ request: start, begun: begun(ctx, "feature"), published: { headSha: BASE(), prNumber: 1 } }))))
      .toMatchObject({ step: "await" })
  })
})
