// A TODO coded by an external agent (decision 0136), end to end on this machine: the `todo` run on the Node host's
// engine over this file's schema of the compose Postgres, the runner routes served over real HTTP, a real
// `smthrs runner serve` process with its own SQLite journal and a real jj checkout, and the deterministic ACP test agent
// as its profile's command. GitHub is the scripted GitHub on the `HttpClient` seam, as in worker/flows/Todo.test.ts,
// whose `main` is the runner's mirror's commit. Smithers' own agent is never asked: its model dies if it is.
import { HostModel } from "@smthrs/model-host"
import { Model } from "@smthrs/model"
import { digestSync } from "@smthrs/crypto"
import { Agent } from "@smthrs/agent"
import { ConfigProvider, Effect, Exit, Layer, Redacted, Stream } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
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
import { REPOSITORY, reset, services as githubServices, sql } from "../github/test/fixtures.ts"
import { scriptedGitHub } from "../github/test/scriptedGitHub.ts"
import * as ModelEndpoint from "../ModelEndpoint.ts"
import { PersonalModels } from "../personal/Models.ts"
import { KEY, resetModels, seedKeys } from "../personal/test/harness.ts"
import * as Stack from "../stack/Stack.ts"
import { runFlow } from "../test/flowHost.ts"
import { eventually, testFile } from "../test/harness.ts"
import { machines } from "../test/todoMachines.ts"
import * as RunnersApi from "./Api.ts"
import * as Store from "./Store.ts"

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

/** The runner routes over real HTTP on a free local port. */
const serve = async (): Promise<{ readonly origin: string; readonly server: Server }> => {
  const handler = HttpEffect.toWebHandler(RunnersApi.make(await database(), { pollMillis: 100 }).fetch)
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
  return { origin: `http://localhost:${(server.address() as AddressInfo).port}`, server }
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
afterEach(async () => {
  for (const child of running) child.kill("SIGKILL")
  for (const server of servers) server.close()
  running = []
  servers = []
})

/** A model Smithers' own agent would ask: this test's TODOs never reach it. */
const noModel = Model.make({ stream: () => Stream.die(new Error("Smithers' own agent was asked")) })

/**
 * Everything a run needs, with a runner registered for the repository and the coding agent set. `run` sees every
 * command the attempt's machine runs; with `secrets`, SECRETS_KEY is set, so a run could open what its committer sealed.
 */
const setup = async (options: { readonly run?: (command: string) => number; readonly secrets?: boolean } = {}) => {
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  const { path, base } = mirror()
  // GitHub's main is the mirror's commit, with the same files.
  github.commits.set(base, { ...github.commits.get(github.refs.get("main")!)!, sha: base })
  github.refs.set("main", base)
  const { services } = await githubServices(runtime, github)
  const db = await database()
  const token = `runner-token-${crypto.randomUUID()}`
  await runtime.runPromise(Store.addRunner(
    { repoId: REPOSITORY.id, name: "test-runner", tokenSha256: digestSync(token), labels: ["linux"], capacity: 2 },
    { actorId: "person-admin", invocationKey: crypto.randomUUID() },
  ))
  await runtime.runPromise(Store.setAgent(
    { repoId: REPOSITORY.id, agent, coding: true },
    { actorId: "person-admin", invocationKey: crypto.randomUUID() },
  ))
  const { origin, server } = await serve()
  servers.push(server)
  const state = join(scratch, `runner-${crypto.randomUUID()}`)
  mkdirSync(state)
  writeFileSync(join(state, "runner-token"), token, { mode: 0o600 })
  const config = join(state, "runner.json")
  writeFileSync(config, JSON.stringify({
    origin,
    name: "test-runner",
    capacity: 2,
    stateDir: state,
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
  const run = (start: Stack.AttemptStart) =>
    runFlow(Todo.Todo, start, registration, { executionId: todoExecutionId(start.attemptId) })
  return { github, base, config, run }
}

const jobs = () =>
  sql(runtime, `SELECT key, status, outcome->>'_tag' AS outcome FROM agent_jobs ORDER BY key`) as Promise<
    Array<{ readonly key: string; readonly status: string; readonly outcome: string }>
  >

describe("a TODO on an external agent", { timeout: 240_000 }, () => {
  test("runs on the runner and publishes the agent's change as one App commit and pull request", async () => {
    const ctx = await setup()
    const runner = startRunner(ctx.config)
    running.push(runner.child)
    const start = await commit("Note alpha", "add the line `alpha` to `NOTES.md`")
    const ran = await ctx.run(start)
    expect(ran.exit, runner.log()).toEqual(Exit.succeed({ state: "merged" }))
    const pull = [...ctx.github.pulls.values()][0]!
    expect(ctx.github.tree("main").get("NOTES.md")).toBe("alpha\n")
    expect(ctx.github.tree("main").get("README.md")).toBe("# Widgets\n")
    const branchCommit = [...ctx.github.commits.values()].find((each) => each.message.startsWith("T1: "))!
    expect(branchCommit.parents).toEqual([ctx.base])
    expect(pull.merged).toBe(true)
    expect(await jobs()).toEqual([{ key: expect.stringMatching(/#g1$/), status: "done", outcome: "Done" }])
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
  })
})
