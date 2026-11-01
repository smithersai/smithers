// A TODO coded by an external agent (decision 0136), end to end on this machine: the `todo` run on the Node host's
// engine over this file's schema of the compose Postgres, the runner routes served over real HTTP, a real
// `smthrs runner serve` process with its own SQLite journal and a real jj checkout, and the deterministic ACP test agent
// as its profile's command. GitHub is the scripted GitHub on the `HttpClient` seam, as in worker/flows/Todo.test.ts,
// whose `main` is the runner's mirror's commit. Smithers' own agent is never asked: its model dies if it is. The run's
// transcript is the store `RunContent` keeps, on Node's SQLite (worker/test/runContent.ts).
import { HostModel } from "@smthrs/model-host"
import { Model } from "@smthrs/model"
import { digestSync } from "@smthrs/crypto"
import { Agent } from "@smthrs/agent"
import { Journal as FlowJournal, Database as FlowsDatabase } from "@smthrs/flows"
import { Notification, NotificationEvent, NotificationQueue, SteerPayload } from "@smthrs/notifications"
import { ConfigProvider, Effect, Exit, Layer, Redacted, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { FetchHttpClient, HttpEffect } from "effect/http"
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { CONNECTION_KINDS } from "../../src/features/personal-model/contract.ts"
import { todoExecutionId } from "../../src/features/pulls/contract.ts"
import * as Todo from "../flows/Todo.ts"
import * as TodoAgent from "../flows/TodoAgent.ts"
import * as TodoSession from "../flows/TodoSession.ts"
import { REPOSITORY, reset, services as githubServices, sql } from "../github/test/fixtures.ts"
import { scriptedGitHub } from "../github/test/scriptedGitHub.ts"
import * as ModelEndpoint from "../ModelEndpoint.ts"
import { PersonalModels } from "../personal/Models.ts"
import { KEY, resetModels, seedKeys } from "../personal/test/harness.ts"
import * as Stack from "../stack/Stack.ts"
import { runFlow } from "../test/flowHost.ts"
import * as RunContentTest from "../test/runContent.ts"
import * as RunContent from "./RunContent.ts"
import { eventually, testFile } from "../test/harness.ts"
import { machines } from "../test/todoMachines.ts"
import * as ExecutionHost from "../ExecutionHost.ts"
import * as RunnersApi from "./Api.ts"
import * as Fleet from "./Fleet.ts"
import type * as Jobs from "./Jobs.ts"
import * as Store from "./Store.ts"
import * as FleetAlert from "../flows/FleetAlert.ts"
import { type AlertProviders, startAlertProviders } from "../test/alertProviders.ts"
import { Channels } from "@smthrs/notifications"

const runtime = testFile("todo_runner")
const root = fileURLToPath(new URL("../../../../", import.meta.url))
const smthrs = join(root, "packages/smithers/bin/smithers.mjs")
const testAgent = join(root, "packages/smithers/agent/test/fixtures/acp-test-agent.mjs")
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-todo-runner-")))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const maya = { id: "person-maya", login: "maya" }
const agent = { name: "coder", labels: ["linux"], profile: "acp-test", maxHours: 1, restarts: 1 }

beforeEach(async () => {
  await reset(runtime)
  await sql(runtime, "TRUNCATE stack_ops, todo_attempts, todo_requests, todos, stacks, pulls, pull_commits, reviews, runs")
  await sql(runtime, "TRUNCATE agent_jobs, runners, runner_changes, agents, agent_changes RESTART IDENTITY CASCADE")
  await resetModels(runtime)
  await sql(runtime, "TRUNCATE agent_runs, fleet_alerts, notifications, alert_channels, alert_deliveries, github_repo_roles")
})

const database = () => runtime.runPromise(Effect.map(Effect.service(TestDatabase.Scratch), (each) => each.database))

/** Commits a TODO as a person's press does; answers its first attempt's start. */
const commit = (title: string, prompt: string) =>
  runtime.runPromise(Effect.gen(function* () {
    const applied = yield* Stack.apply({
      opId: crypto.randomUUID(),
      repoId: REPOSITORY.id,
      actor: maya,
      via: "person",
      op: { kind: "commit", title, prompt, acceptance: [] },
    }, { runs: true })
    return applied.kind === "applied" ? applied.receipt.starts[0]! : expect.unreachable("not applied")
  }))

const jj = (cwd: string, ...args: Array<string>) =>
  execFileSync("jj", ["--config", "user.name=Test", "--config", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
  }).trim()

/** A jj repository holding README.md, as the runner's mirror of the repository: answers its path and commit. */
const mirror = () => {
  const path = join(scratch, `mirror-${crypto.randomUUID()}`)
  mkdirSync(path)
  jj(path, "git", "init")
  writeFileSync(join(path, "README.md"), "# Widgets\n")
  jj(path, "commit", "-m", "Initial commit")
  return { path, base: jj(path, "log", "-r", "@-", "--no-graph", "-T", "commit_id") }
}

/** A writer of the engine's `schema` on the compose Postgres, as ChatApi's (worker/ExecutionHost.ts `database`). */
const engineWriter = async (schema: string) =>
  ExecutionHost.database((await runtime.runPromise(TestDatabase.serverUrl)).toString(), schema)

/**
 * The runner routes over real HTTP on a free local port, carrying the steers of runs in the engine's `schema`, and the
 * runs' transcripts they write. As ChatApi wires them: a claim tells the TODO's attempt it no longer waits for a runner,
 * a heartbeat carries steers, and the job's events go to the TODO's run's transcript.
 */
const serve = async (schema: string) => {
  const db = await database()
  const transcripts = RunContentTest.transcripts()
  const handler = HttpEffect.toWebHandler(RunnersApi.make(db, {
    pollMillis: 100,
    onClaimed: (task) =>
      task.context?.attemptId === undefined ? Effect.void : TodoSession.claimed(task.context.attemptId).pipe(Effect.provide(db)),
    runOf: TodoSession.runOf,
    steering: TodoSession.steering(await engineWriter(schema)),
  }).fetch.pipe(Effect.provide(transcripts.layer)))
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Array<Buffer> = []
    for await (const chunk of incoming) chunks.push(chunk as Buffer)
    const response = await handler(new Request(`http://localhost${incoming.url}`, {
      method: incoming.method!,
      headers: incoming.headers as Record<string, string>,
      ...(incoming.method === "GET" ? {} : { body: Buffer.concat(chunks) }),
    }))
    outgoing.writeHead(response.status, Object.fromEntries(response.headers))
    outgoing.end(Buffer.from(await response.arrayBuffer()))
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  return { origin: `http://localhost:${(server.address() as AddressInfo).port}`, server, transcripts }
}

/** A runner process over `config`, its stderr kept for a failure's report. */
const startRunner = (config: string) => {
  const child = spawn(process.execPath, [smthrs, "runner", "serve", "--config", config], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, SMITHERS_TELEMETRY: "off" },
  })
  let log = ""
  child.stderr!.on("data", (chunk: Buffer) => void (log += chunk.toString()))
  return { child, log: () => log }
}

let running: Array<ChildProcess> = []
let servers: Array<Server> = []
let schemas: Array<string> = []
afterEach(async () => {
  for (const child of running) child.kill("SIGKILL")
  for (const server of servers) server.close()
  for (const schema of schemas) {
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`))
  }
  running = []
  servers = []
  schemas = []
})

/** A model Smithers' own agent would ask: this test's TODOs never reach it. */
const noModel = Model.make({ stream: () => Stream.die(new Error("Smithers' own agent was asked")) })

/**
 * Everything a run needs, with a runner registered for the repository and the coding agent set. `run` sees every
 * command the attempt's machine runs; with `secrets`, SECRETS_KEY is set, so a run could open what its committer sealed;
 * `fleet`, the fleet's alerts.
 */
const setup = async (
  options: {
    readonly run?: (command: string) => number
    readonly secrets?: boolean
    readonly fleet?: Jobs.Alerts
    readonly capacity?: number
    readonly heartbeatSeconds?: number
  } = {},
) => {
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  const { path, base } = mirror()
  // GitHub's main is the mirror's commit, with the same files.
  github.commits.set(base, { ...github.commits.get(github.refs.get("main")!)!, sha: base })
  github.refs.set("main", base)
  const { services } = await githubServices(runtime, github)
  const db = await database()
  const token = `runner-token-${crypto.randomUUID()}`
  await runtime.runPromise(Store.addRunner(
    { repoId: REPOSITORY.id, name: "test-runner", tokenSha256: digestSync(token), labels: ["linux"], capacity: options.capacity ?? 2 },
    { actorId: "person-admin", invocationKey: crypto.randomUUID() },
  ))
  await runtime.runPromise(Store.setAgent(
    { repoId: REPOSITORY.id, agent, coding: true },
    { actorId: "person-admin", invocationKey: crypto.randomUUID() },
  ))
  // The run's engine keeps its journal here, so the runner routes read and deliver its steers.
  const schema = `flows_${crypto.randomUUID().replaceAll("-", "")}`
  schemas.push(schema)
  const { origin, server, transcripts } = await serve(schema)
  servers.push(server)
  const state = join(scratch, `runner-${crypto.randomUUID()}`)
  mkdirSync(state)
  writeFileSync(join(state, "runner-token"), token, { mode: 0o600 })
  const config = join(state, "runner.json")
  writeFileSync(config, JSON.stringify({
    origin,
    name: "test-runner",
    capacity: options.capacity ?? 2,
    stateDir: state,
    heartbeatSeconds: options.heartbeatSeconds ?? 2,
    // The test machine's own load mustn't hold its claims (decision 0144).
    admission: { loadPerCpu: 8, diskFloorGb: 0 },
    repositories: { [REPOSITORY.id]: { mirror: path } },
    profiles: {
      "acp-test": { argv: [process.execPath, testAgent], env: { ACP_TEST_AGENT_STATE: join(state, "agent-state") } },
    },
  }))
  const local = await Effect.runPromise(ModelEndpoint.local(db, { hosted: true }).pipe(
    Effect.provide(PersonalModels.none),
    Effect.provideService(
      HostModel,
      HostModel.of({ modelId: "agent-model", model: noModel, route: { prepare: () => Effect.die(new Error("unused")) } }),
    ),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
  ))
  const todoServices: Todo.Services<unknown, never> = {
    database: services.database,
    tokens: services.tokens,
    http: services.http,
    apiBaseUrl: services.apiBaseUrl,
    start: () => Effect.void,
    ...(options.fleet === undefined ? {} : { fleet: options.fleet }),
  }
  const registration = Todo.registration(todoServices, TodoAgent.registration(local("agent"), db, Agent.layerSandbox))
    .pipe(
      Layer.provide(machines(github, options.run).layer),
      Layer.provide(
        options.secrets === true
          ? ConfigProvider.layer(ConfigProvider.fromUnknown({ SECRETS_KEY: Redacted.value(KEY) }))
          : Layer.empty,
      ),
    )
  github.onPullOpened = (number) => void github.merge(number, "maya")
  const run = (start: Stack.AttemptStart, signal?: AbortSignal) =>
    runFlow(Todo.Todo, start, registration, {
      executionId: todoExecutionId(start.attemptId),
      schema,
      ...(signal === undefined ? {} : { signal }),
    })
  /** Run `runId`'s transcript once its session's end arrived: its events, and whether their seqs run on unbroken. */
  const transcript = async (runId: string) => {
    let rows: ReadonlyArray<{ readonly kind: string; readonly seq: number; readonly update: Record<string, unknown> }> = []
    await eventually(async () => {
      rows = RunContent.page(transcripts.of(runId), -1)
      return rows.some((row) => row.kind === "_smithers/end")
    }, 60_000)
    return { rows, contiguous: rows.every((row, n) => row.seq === n) }
  }
  return { github, base, config, run, transcript, schema, state, db }
}

const jobs = () =>
  sql(runtime, `SELECT key, status, outcome->>'_tag' AS outcome FROM agent_jobs ORDER BY key`) as Promise<
    Array<{ readonly key: string; readonly status: string; readonly outcome: string }>
  >

describe("a TODO on an external agent", { timeout: 240_000 }, () => {
  test("waits for a runner, runs on it and publishes the agent's change as one App commit and pull request", async () => {
    const ctx = await setup()
    const start = await commit("Note alpha", "add the line `alpha` to `NOTES.md`")
    const waiting = async () =>
      ((await sql(runtime, `SELECT waiting FROM todos WHERE id = '${start.todoId}'`)) as Array<{ waiting: string | null }>)[0]!
        .waiting
    const run = ctx.run(start)
    // No runner yet: the TODO reads Waiting for a runner (decision 0135).
    await eventually(async () => (await waiting()) === "runner", 60_000)
    const runner = startRunner(ctx.config)
    running.push(runner.child)
    await eventually(async () => (await waiting()) === null, 60_000)
    const ran = await run
    expect(ran.exit, runner.log()).toEqual(Exit.succeed({ state: "merged" }))
    const pull = [...ctx.github.pulls.values()][0]!
    expect(ctx.github.tree("main").get("NOTES.md")).toBe("alpha\n")
    expect(ctx.github.tree("main").get("README.md")).toBe("# Widgets\n")
    const branchCommit = [...ctx.github.commits.values()].find((each) => each.message.startsWith("T1: "))!
    expect(branchCommit.parents).toEqual([ctx.base])
    expect(pull.merged).toBe(true)
    expect(await jobs()).toEqual([{ key: expect.stringMatching(/#g1$/), status: "done", outcome: "Done" }])
    // The run's transcript: the prompt, the agent's work and the end, once each and in order (decision 0141).
    const { rows, contiguous } = await ctx.transcript(todoExecutionId(start.attemptId))
    expect(contiguous).toBe(true)
    expect(rows[0]!.kind).toBe("user_message_chunk")
    expect(rows.map((row) => row.kind)).toContain("tool_call")
    expect(rows.at(-1)).toMatchObject({ kind: "_smithers/end", update: { outcome: "done" } })
    const [summary] = (await sql(runtime, `SELECT first_event_at IS NOT NULL AS first, transcript_events::int AS events
      FROM agent_jobs`)) as Array<{ first: boolean; events: number }>
    expect(summary!.first).toBe(true)
    expect(summary!.events).toBeGreaterThan(0)
  })

  test("takes the runner even when its committer's first connection is a subscription (decision 0136 over AUTH-10)", async () => {
    // The repository's coding agent comes first; the committer's connections code only a repository that names none
    // (worker/flows/Todo.ts). A subscription would run its vendor's agent on the attempt's machine, so none may run.
    const subscription = CONNECTION_KINDS.find((kind) => kind.endsWith("_subscription"))!
    await seedKeys(runtime, maya.id, [{ kind: subscription }])
    const commands: Array<string> = []
    const ctx = await setup({ secrets: true, run: (command) => (commands.push(command), 0) })
    const runner = startRunner(ctx.config)
    running.push(runner.child)
    const start = await commit("Note alpha", "add the line `alpha` to `NOTES.md`")
    const ran = await ctx.run(start)
    expect(ran.exit, runner.log()).toEqual(Exit.succeed({ state: "merged" }))
    expect(ctx.github.tree("main").get("NOTES.md")).toBe("alpha\n")
    expect(await jobs()).toEqual([{ key: expect.stringMatching(/#g1$/), status: "done", outcome: "Done" }])
    expect(commands).toEqual([])
  })

  test("a runner killed mid-job is restarted, reclaims its job and finishes it once, in the same generation", async () => {
    const ctx = await setup()
    const first = startRunner(ctx.config)
    running.push(first.child)
    const start = await commit("Slow alpha", "run `sleep 6`\nadd the line `alpha` to `NOTES.md`")
    const run = ctx.run(start)
    // Kill the runner once it holds the job and its agent is inside the sleep.
    await eventually(async () => (await jobs())[0]?.status === "claimed", 60_000)
    await new Promise((done) => setTimeout(done, 2_000))
    first.child.kill("SIGKILL")
    const second = startRunner(ctx.config)
    running.push(second.child)
    const ran = await run
    expect(ran.exit, `${first.log()}\n${second.log()}`).toEqual(Exit.succeed({ state: "merged" }))
    // The line went in once, and the job never needed a second generation.
    expect(ctx.github.tree("main").get("NOTES.md")).toBe("alpha\n")
    expect(await jobs()).toEqual([{ key: expect.stringMatching(/#g1$/), status: "done", outcome: "Done" }])
    // The transcript runs on unbroken across the restart, without the history the agent replayed when it resumed: each
    // prompt once (one, or two with the resumed session's Continue, as far as the first runner got).
    const { rows, contiguous } = await ctx.transcript(todoExecutionId(start.attemptId))
    expect(contiguous).toBe(true)
    const prompts = rows.filter((row) => row.kind === "user_message_chunk").map((row) => JSON.stringify(row.update))
    expect(prompts.length).toBeGreaterThan(0)
    expect(new Set(prompts).size).toBe(prompts.length)
  })
})

/** A Member's steer, admitted to the run's queue in the engine's `schema` as the steer route admits it. */
const steer = async (schema: string, runId: string, id: string, body: string) => {
  const queue = NotificationQueue.layer.pipe(
    Layer.provideMerge(FlowJournal.SqlJournal.layer({ capacity: 1024, overflow: "reject", sourceEventCache: 1 }).pipe(
      Layer.provideMerge(Layer.provideMerge(FlowsDatabase.DurableWriter.layer(), await engineWriter(schema))),
    )),
  )
  return Effect.runPromise(Effect.flatMap(NotificationQueue.NotificationQueue, (notifications) =>
    notifications.admit(runId, Notification.humanSteer({
      runId,
      id,
      actor: `person:${maya.id}`,
      attribution: { login: maya.login, via: "person" },
      payload: SteerPayload.encode({ kind: "Message", body }),
    }))).pipe(Effect.provide(queue), Effect.scoped))
}

/** The promotions of the run's queue in the engine's `schema`: each boundary and the steers it delivered. */
const promotions = async (schema: string, runId: string) =>
  ((await sql(runtime, `SELECT payload_json FROM ${schema}.flows_journal_events
    WHERE run_id = '${runId}' AND event_type = '${NotificationEvent.PromotedEventType}' ORDER BY seq`)) as Array<
    { readonly payload_json: string }
  >).map((row) => JSON.parse(row.payload_json) as { readonly boundary: string; readonly ids: ReadonlyArray<string> })

/** The pids the test agent's detached commands wrote under the runner's `state`. */
const detached = (state: string) => {
  const directory = join(state, "agent-state")
  return existsSync(directory)
    ? readdirSync(directory).filter((name) => name.startsWith("detached-")).map((name) =>
      Number(readFileSync(join(directory, name), "utf8"))
    )
    : []
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("half load and overflow (decision 0144)", { timeout: 240_000 }, () => {
  test("a job the attached runner holds back from is claimed by an overflow runner once it waited, and settles Done", async () => {
    const ctx = await setup()
    // The attached runner: held by its own admission rule, as a host over half load or under its disk floor is.
    const attached = JSON.parse(readFileSync(ctx.config, "utf8")) as Record<string, unknown>
    writeFileSync(ctx.config, JSON.stringify({ ...attached, admission: { loadPerCpu: 8, diskFloorGb: 100_000 } }))
    running.push(startRunner(ctx.config).child)
    // The overflow runner, as `smthrs runner` in a Cloudflare container would be: its own token and the `cloudflare`
    // label, taking only a job that waited 3 s.
    const token = `runner-token-${crypto.randomUUID()}`
    await runtime.runPromise(Store.addRunner(
      { repoId: REPOSITORY.id, name: "overflow", tokenSha256: digestSync(token), labels: ["linux", "cloudflare"], capacity: 2 },
      { actorId: "person-admin", invocationKey: crypto.randomUUID() },
    ))
    const state = join(scratch, `overflow-${crypto.randomUUID()}`)
    mkdirSync(state)
    writeFileSync(join(state, "runner-token"), token, { mode: 0o600 })
    const config = join(state, "runner.json")
    writeFileSync(config, JSON.stringify({ ...attached, name: "overflow", stateDir: state, minQueuedSeconds: 3,
      profiles: { "acp-test": { argv: [process.execPath, testAgent], env: { ACP_TEST_AGENT_STATE: join(state, "agent-state") } } } }))
    const overflow = startRunner(config)
    running.push(overflow.child)
    await eventually(async () =>
      ((await sql(runtime, `SELECT held FROM runners WHERE name = 'test-runner'`)) as Array<{ held: string | null }>)[0]?.held
        ?.startsWith("disk ") === true, 60_000)
    const start = await commit("Note alpha", "add the line `alpha` to `NOTES.md`")
    const ran = await ctx.run(start)
    expect(ran.exit, overflow.log()).toEqual(Exit.succeed({ state: "merged" }))
    expect(ctx.github.tree("main").get("NOTES.md")).toBe("alpha\n")
    const [job] = (await sql(runtime, `SELECT j.status, j.outcome->>'_tag' AS outcome, r.name AS runner,
      extract(epoch FROM j.claimed_at - j.created_at)::float8 AS waited
      FROM agent_jobs j JOIN runners r ON r.id = j.runner_id`)) as Array<
        { status: string; outcome: string; runner: string; waited: number }
      >
    expect(job).toMatchObject({ status: "done", outcome: "Done", runner: "overflow" })
    expect(job!.waited).toBeGreaterThanOrEqual(3)
    expect(await sql(runtime, `SELECT runner, state FROM agent_runs`)).toEqual([{ runner: "overflow", state: "done" }])
  })
})

describe("steering and stopping a TODO's external agent", { timeout: 240_000 }, () => {
  test("a Member's steer reaches the agent on its runner, reads Delivered, and its change is in the pull request", async () => {
    const ctx = await setup()
    const runner = startRunner(ctx.config)
    running.push(runner.child)
    // Long enough that the runner's next heartbeat hands the steer over while the agent's command still runs.
    const start = await commit("Steered alpha", "run `sleep 12`\nadd the line `alpha` to `NOTES.md`")
    const runId = todoExecutionId(start.attemptId)
    const run = ctx.run(start)
    await eventually(async () => (await jobs())[0]?.status === "claimed", 60_000)
    const id = crypto.randomUUID()
    await steer(ctx.schema, runId, id, "add the line `steer-x` to `NOTES.md`")
    const ran = await run
    expect(ran.exit, runner.log()).toEqual(Exit.succeed({ state: "merged" }))
    // The steer's line, after the task's, in the one App commit.
    expect(ctx.github.tree("main").get("NOTES.md")).toBe("alpha\nsteer-x\n")
    // Delivered: the runner's confirmation promoted exactly this steer, under its job's runner boundary.
    expect(await promotions(ctx.schema, runId)).toEqual([
      { boundary: expect.stringMatching(/^runner:.+#g1:[0-9a-f]{32}$/), targetLineageId: runId, ids: [id] },
    ])
    // The run's transcript marks the steer once, by id, through the runner's spool (decision 0142).
    const { rows } = await ctx.transcript(runId)
    expect(rows.filter((row) => row.kind === "_smithers/steer").map((row) => row.update)).toEqual([
      { id, mode: expect.any(String) },
    ])
  })

  test("Stop ends the agent's whole process tree, fails the TODO stopped with nothing on GitHub, and Retry starts again", async () => {
    const ctx = await setup()
    const runner = startRunner(ctx.config)
    running.push(runner.child)
    const start = await commit("Long sleep", "run `sleep 600` detached")
    const run = ctx.run(start)
    await eventually(async () => detached(ctx.state).length === 1, 60_000)
    const [sleeper] = detached(ctx.state)
    const asked = Date.now()
    expect(await runtime.runPromise(TodoSession.stop(start.attemptId))).toBe(1)
    // The runner learns it at its next heartbeat, ends the tree, and settles Cancelled with no process left.
    await eventually(async () => (await jobs())[0]?.status === "cancelled", 30_000)
    expect(Date.now() - asked).toBeLessThan(20_000)
    const [settled] = (await sql(runtime, "SELECT outcome FROM agent_jobs")) as Array<{ readonly outcome: unknown }>
    expect(settled!.outcome).toEqual({ _tag: "Cancelled", processTreeGone: true })
    expect(alive(sleeper!)).toBe(false)
    const ran = await run
    expect(ran.exit, runner.log()).toEqual(Exit.succeed({ state: "failed" }))
    const [todo] = (await sql(runtime, `SELECT state, failure FROM todos WHERE id = '${start.todoId}'`)) as Array<
      { readonly state: string; readonly failure: string }
    >
    expect(todo).toEqual({ state: "failed", failure: "stopped" })
    // The run's transcript marks the stop once, then the session's end (decision 0142).
    const { rows } = await ctx.transcript(todoExecutionId(start.attemptId))
    const marks = rows.filter((row) => row.kind === "_smithers/cancel" || row.kind === "_smithers/end")
    expect(marks.map((row) => [row.kind, row.update])).toEqual([
      ["_smithers/cancel", {}],
      ["_smithers/end", { outcome: "cancelled" }],
    ])
    // Nothing reached GitHub: no branch, no pull request.
    expect(ctx.github.pulls.size).toBe(0)
    expect([...ctx.github.refs.keys()]).toEqual(["main"])
    // A second Stop finds nothing open.
    expect(await runtime.runPromise(TodoSession.stop(start.attemptId))).toBe(0)
    // The TODO kept its place: Retry starts a new attempt.
    const retried = await runtime.runPromise(Stack.apply({
      opId: crypto.randomUUID(),
      repoId: REPOSITORY.id,
      actor: maya,
      via: "person",
      op: { kind: "retry", number: 1 },
    }, { runs: true }))
    expect(retried.kind === "applied" ? retried.receipt.starts.length : 0).toBe(1)
  })
})

describe("the fleet over a real runner", { timeout: 300_000 }, () => {
  let providers: AlertProviders
  afterEach(async () => {
    await providers?.close()
  })

  test("a silent agent reads Stalled and its committer hears it; a quiet CPU-bound build does not; a refused run's failure and a killed runner's outage reach the bell and Telegram once", async () => {
    providers = await startAlertProviders()
    const chat = "-1001234500002"
    await sql(runtime, `INSERT INTO alert_channels (channel, destinations, app_url, updated_by)
      VALUES ('telegram', '["${chat}"]'::jsonb, 'https://smithers.test/app', 'person-admin')`)
    await sql(runtime, `INSERT INTO github_repo_roles (repo_id, person_id, role) VALUES ('${REPOSITORY.id}', 'person-ada', 'admin')`)
    const db = await database()
    const alerts = FleetAlert.registration(db, "github/smithersai/smithers", Channels.layer({
      telegram: { token: Redacted.make("123456:SYNTHETIC_FLEET_BOT"), url: providers.url },
    }))
    // Each alert the probe or `todo/Fail` raises runs `ops/FleetAlert` on the Node host, as its own execution.
    const fleet: Jobs.Alerts = {
      // Fifteen seconds of quiet is a stall here (longer than an agent takes to start its first command and use 5 CPU
      // seconds); a runner unseen for 20 s is offline.
      settings: { ...Fleet.DEFAULTS, stallMinutes: 0.25, offlineSeconds: 20 },
      raise: (alert) =>
        Effect.promise(() => runFlow(FleetAlert.FleetAlert, alert, alerts, { executionId: alert.alertId })).pipe(Effect.asVoid),
    }
    const ctx = await setup({ fleet, capacity: 3, heartbeatSeconds: 2 })
    const runner = startRunner(ctx.config)
    running.push(runner.child)
    const stop = new AbortController()
    // Three TODOs run at once (decision 0135).
    await runtime.runPromise(Stack.apply({
      opId: crypto.randomUUID(),
      repoId: REPOSITORY.id,
      actor: maya,
      via: "person",
      op: { kind: "configure", lanes: 3, maxOpen: 50, base: "independent" },
    }, { runs: true }))
    const silent = await commit("Silent", "run `sleep 240`")
    const busy = await commit("Busy", "run `busy 300`")
    const refused = await commit("Refused", "refuse")
    const runs = [ctx.run(silent, stop.signal), ctx.run(busy, stop.signal), ctx.run(refused)]
    const state = async (number: number) =>
      ((await sql(runtime, `SELECT state FROM agent_runs WHERE number = ${number}`)) as Array<{ state: string }>)[0]?.state
    const bells = async () =>
      (await sql(runtime, `SELECT recipient, title FROM notifications WHERE kind = 'fleet' ORDER BY title, recipient`)) as Array<
        { recipient: string; title: string }
      >
    // Who heard what, by title: without the second runner's run, which may stall once its runner is killed.
    const heard = async () =>
      (await bells()).map((bell) => [bell.recipient, bell.title]).filter(([, title]) => title !== "T2 Busy · Stalled")
    try {
      await eventually(async () => (await state(1)) === "stalled", 90_000)
      await eventually(async () => (await bells()).some((bell) => bell.title === "T1 Silent · Stalled"), 30_000)
      await eventually(async () => (await bells()).some((bell) => bell.title === "T3 Refused · Failed · implement"), 60_000)
      expect(await runs[2]).toMatchObject({ status: "completed" })
      // The busy run's agent says nothing either, but its tree burns CPU: work through probe after probe, never a stall.
      await new Promise((done) => setTimeout(done, 45_000))
      expect(await state(2), runner.log()).toBe("working")
      const killedAt = Date.now()
      runner.child.kill("SIGKILL")
      await eventually(async () => (await bells()).some((bell) => bell.title === "Runner test-runner offline"), 120_000)
      expect(await heard()).toEqual([
        ["person-ada", "Runner test-runner offline"],
        ["person-ada", "T1 Silent · Stalled"],
        ["person-maya", "T1 Silent · Stalled"],
        ["person-ada", "T3 Refused · Failed · implement"],
        ["person-maya", "T3 Refused · Failed · implement"],
      ].sort((a, b) => a[1]!.localeCompare(b[1]!) || a[0]!.localeCompare(b[0]!)))
      // A dead runner's busy run goes quiet: if it stalled, it stalled only once its runner was gone.
      const busyStalls = (await sql(runtime, `SELECT opened_at FROM fleet_alerts WHERE kind = 'stalled' AND subject IN
        (SELECT key FROM agent_runs WHERE number = 2)`)) as Array<{ opened_at: Date }>
      for (const stall of busyStalls) expect(new Date(stall.opened_at).getTime()).toBeGreaterThanOrEqual(killedAt)
      // Each bell's message follows it on Telegram, once.
      const texts = () =>
        providers.received.filter((each) => each.provider === "telegram")
          .map((each) => (each.body as { text: string }).text.split("\n")[0])
          .filter((text) => text !== "T2 Busy · Stalled")
          .sort()
      await eventually(() => texts().length === 3, 30_000)
      expect(texts()).toEqual(["Runner test-runner offline", "T1 Silent · Stalled", "T3 Refused · Failed · implement"])
      // One incident per outage: later probes start nothing more.
      await new Promise((done) => setTimeout(done, 5_000))
      expect((await sql(runtime, `SELECT kind FROM fleet_alerts WHERE kind = 'offline'`)) as Array<{ kind: string }>)
        .toEqual([{ kind: "offline" }])
    } finally {
      stop.abort()
      await Promise.allSettled(runs)
    }
  })
})

describe("TodoSession.claimed", () => {
  test("a claim for an attempt Smithers doesn't know changes nothing", async () => {
    await runtime.runPromise(TodoSession.claimed(crypto.randomUUID()))
    expect(await sql(runtime, "SELECT count(*)::int AS n FROM todos WHERE waiting IS NOT NULL")).toEqual([{ n: 0 }])
  })
})
