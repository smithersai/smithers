// Running a repository's flow by hand, and a run again (worker/ci/RunsApi.ts), through the real handler on this file's
// schema of the compose Postgres (`pnpm db:up`), against the scripted GitHub (read as the App with a real key, which
// also says each person's permission on the repository), the real `RepoRoles` (decision 0079), the real QuickJS realm,
// and, for Retry, a real engine that ran the flow on the Node host with a test `Machines`. The starts the routes ask
// for are recorded as a Durable Object would take them.
import wasmfile from "@jitl/quickjs-wasmfile-release-sync"
import { QuickJSVariant } from "@smthrs/harness"
import type { SandboxTools } from "@smthrs/sandbox"
import { FlowRuntime } from "@smthrs/flow"
import { Context, Effect, Exit, Layer, Metric, Option } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import { SqlClient } from "effect/sql"
import type { QuickJSSyncVariant } from "quickjs-emscripten-core"
import { beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { flowInputsRoute, manualExecutionId, repoFlowsRoute, repoRunsRoute } from "../../src/features/actions/contract.ts"
import * as Actor from "../Actor.ts"
import { Machines } from "../branch/Machines.ts"
import * as ExecutionHost from "../ExecutionHost.ts"
import { FlowStarter, StartConflict, StartUnavailable } from "../Flows.ts"
import { repositoryOf } from "../github/Config.ts"
import * as RepoRoles from "../github/RepoRoles.ts"
import { REPOSITORY, reset, services as githubServices } from "../github/test/fixtures.ts"
import { app } from "../github/test/harness.ts"
import { accountIdOf, appKey, type ScriptedGitHub, scriptedGitHub } from "../github/test/scriptedGitHub.ts"
import * as RepoRuns from "../RepoRuns.ts"
import { noCommands } from "../test/commands.ts"
import { build } from "../test/flowHost.ts"
import { eventually, signedIn, testFile, uuid } from "../test/harness.ts"
import type * as Realm from "./Realm.ts"
import * as RepoFlow from "./RepoFlow.ts"
import * as RunsApi from "./RunsApi.ts"

const runtime = testFile("repo_runs_api")

const MAYA = "4d2c6a1e-8b3f-4e5a-9c7d-1f2e3a4b5c6d"
const GUS = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
// Their role on the deployment's own repository says nothing of acme/widgets: GitHub's permission there does.
const maya: Actor.Actor = { subject: { kind: "person", id: MAYA }, role: null, login: "maya" }
const gus: Actor.Actor = { subject: { kind: "person", id: GUS }, role: "admin", login: "gus" }

beforeEach(async () => {
  await reset(runtime)
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.andThen(
      sql`TRUNCATE runs`,
      sql`INSERT INTO people (id, github_id, github_login) VALUES
        (${MAYA}, ${accountIdOf("maya")}, 'maya'), (${GUS}, ${accountIdOf("gus")}, 'gus')`,
    )))
})

const variant = QuickJSVariant.layerVariant(wasmfile as unknown as QuickJSSyncVariant)

const MANIFEST = JSON.stringify({
  apiVersion: 1,
  contributes: {
    triggers: [
      { on: "github.push", flow: "ci" },
      { on: "manual", flow: "release", title: "Release" },
      { on: "manual", flow: "ci" },
      { on: "manual", flow: "release" },
    ],
  },
})

const RELEASE = `
import { Flow } from "@smthrs/flow"
import { CiJob } from "@smthrs/sandbox"
import { Schema } from "effect"
export default Flow.make("release", {
  payload: {
    channel: Schema.Literals(["next", "latest"]),
    dryRun: Schema.Boolean.annotate({ default: true }),
  },
  body: (run: { readonly channel: string }) =>
    CiJob.make("publish", { steps: [{ name: "publish", run: "pnpm publish --tag " + run.channel }] }).call(run),
})
`

const CI = `
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { CiJob } from "@smthrs/sandbox"
import { Schema } from "effect"
const versions = CiJob.make("versions", { steps: [{ name: "node", run: "node --version" }] })
const lint = CiJob.make("lint", { steps: [{ name: "lint", run: "pnpm lint" }] })
export default Flow.make("ci", {
  payload: { nested: Schema.Struct({ a: Schema.String }) },
  body: (run: { readonly sha: string }) => Node.all({ versions: versions.call(run), lint: lint.call(run) }),
})
`

/** A machine whose command exits with `exits[command]` (0 unless set); with `hang`, a command never ends. */
const machine = (exits: Readonly<Record<string, number>> = {}, hang = false) =>
  Layer.succeed(
    Machines,
    Machines.of({
      commands: () => noCommands,
      tool: (branch, _owner, _callId, call) => {
        const command = (call as typeof SandboxTools.Run.Type).command
        if (hang && !command.startsWith("test ")) return Effect.never
        const exitCode = command.startsWith("test ") ? (command.endsWith(branch.branch) ? 0 : 1) : exits[command] ?? 0
        return Effect.succeed({
          generation: 1,
          result: { tool: "run" as const, exitCode, timedOut: false, stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0, truncated: false },
        })
      },
      sleepIfIdle: () => Effect.succeed("slept" as const),
    }),
  )

/** The routes over the scripted GitHub and an engine's schema, with the starts they asked for. */
const routes = async (
  github: ScriptedGitHub,
  options: {
    readonly actor?: Actor.Actor | null
    /** Sessions that can't be read. */
    readonly sessionsDown?: boolean
    readonly repoFlows?: boolean
    readonly app?: boolean
    readonly repositories?: ReadonlyArray<string>
    readonly engineSchema?: string
    readonly starter?: FlowStarter["Service"]
    /** GitHub out of reach: no scripted GitHub, and a base URL nothing listens on. */
    readonly unreachable?: boolean
  } = {},
) => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const server = await Effect.runPromise(TestDatabase.serverUrl)
  const starts: Array<{ readonly flow: string; readonly executionId: string; readonly payload: unknown }> = []
  const registry: Metric.MetricRegistry = new Map()
  const configured = options.app === false
    ? Option.none()
    : Option.some(app({ privateKey: await appKey(), ...(options.unreachable === true ? { apiBaseUrl: "http://127.0.0.1:1" } : {}) }))
  const http = options.unreachable === true ? {} : { http: github.http }
  const roles = await runtime.runPromise(RepoRoles.make(scratch.database, {
    repository: repositoryOf("acme/home"),
    app: configured,
    ...http,
  }))
  const api = await runtime.runPromise(RunsApi.make(scratch.database, {
    repositories: new Set(options.repositories ?? ["acme/widgets"]),
    app: configured,
    repoFlows: options.repoFlows ?? true,
    roles,
    engine: ExecutionHost.readDatabase(server.toString(), options.engineSchema ?? "flows_none"),
    variant,
    ...http,
  }))
  const starter = options.starter ?? FlowStarter.of({
    start: (flow, start) => Effect.sync(() => void starts.push({ flow: flow._tag, ...start })),
  })
  const handler = HttpEffect.toWebHandler(
    api.fetch.pipe(
      Effect.provide(
        options.sessionsDown === true
          ? Layer.succeed(Actor.Sessions, Actor.Sessions.of({ resolve: Effect.fail(new Actor.SessionsUnavailable()) }))
          : options.actor === null
          ? Actor.signedOut
          : signedIn(options.actor ?? maya),
      ),
      Effect.provideService(FlowStarter, starter),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(Metric.MetricRegistry, registry),
    ),
  )
  return {
    starts,
    engineSchema: options.engineSchema ?? "flows_none",
    fetch: (path: string, init?: RequestInit) => handler(new Request(`http://chat.test${path}`, init)),
    count: (metric: typeof RunsApi.starts, attributes: Record<string, string>) =>
      Effect.runSync(Metric.value(Metric.withAttributes(metric, attributes)).pipe(
        Effect.provideService(Metric.MetricRegistry, registry),
      )).count,
  }
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) })
const answer = async (response: Response) => [response.status, await response.json()] as const

const rows = () =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ execution: string; flow: string; event: string; ref: string; launched_by: string; status: string }>`
      SELECT execution, flow, event, ref, launched_by, status FROM runs ORDER BY execution`))

/**
 * The scripted repository with the manifest and both flows on main, where Maya may write and Gus only read. Gus is an
 * Admin of the deployment's own repository, which gives him nothing here.
 */
const repository = () => {
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  github.roles.set("maya", "write")
  github.roles.set("gus", "read")
  const sha = github.push("main", {
    ".smithers/factory.json": MANIFEST,
    ".smithers/flows/release/flow.ts": RELEASE,
    ".smithers/flows/ci/flow.ts": CI,
  })
  return { github, sha }
}

describe("GET /api/repos/<owner>/<name>/flows", () => {
  test("the flows a person runs by hand, once each, with their titles, and the default branch", async () => {
    const { github } = repository()
    const h = await routes(github)
    expect(await answer(await h.fetch(repoFlowsRoute(REPOSITORY.owner, REPOSITORY.name)))).toEqual([
      200,
      { flows: [{ name: "release", title: "Release" }, { name: "ci" }], defaultBranch: "main" },
    ])
    expect(h.count(RunsApi.reads, { read: "flows", outcome: "read" })).toBe(1)
  })

  test("a repository without a manifest has none to run by hand", async () => {
    const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    github.roles.set("maya", "write")
    github.push("main", { "README.md": "hello" })
    const h = await routes(github)
    expect(await answer(await h.fetch(repoFlowsRoute(REPOSITORY.owner, REPOSITORY.name))))
      .toEqual([200, { flows: [], defaultBranch: "main" }])
  })

  test("refuses who isn't a Member on the repository, one flows don't run for, flows off, and GitHub down", async () => {
    const { github } = repository()
    const path = repoFlowsRoute(REPOSITORY.owner, REPOSITORY.name)
    const cases: ReadonlyArray<[Parameters<typeof routes>[1], string, number, string]> = [
      [{ actor: null }, path, 401, "authentication"],
      // An Admin of the deployment's own repository who only reads this one.
      [{ actor: gus }, path, 403, "forbidden"],
      [{ sessionsDown: true }, path, 503, "unavailable"],
      [{}, repoFlowsRoute("acme", "other"), 404, "not_found"],
      [{ repositories: [] }, path, 404, "not_found"],
      [{ repoFlows: false }, path, 503, "off"],
      [{ app: false }, path, 503, "off"],
      [{ unreachable: true }, path, 503, "unavailable"],
    ]
    for (const [options, target, status, code] of cases) {
      const h = await routes(github, options)
      expect([code, ...(await answer(await h.fetch(target)))]).toEqual([code, status, { code }])
    }
    const h = await routes(github)
    expect((await h.fetch(path, { method: "POST" })).status).toBe(405)
    expect((await h.fetch(`${flowInputsRoute(REPOSITORY.owner, REPOSITORY.name, "release")}?ref=main`, { method: "POST" })).status)
      .toBe(405)
    expect(await answer(await h.fetch(flowInputsRoute(REPOSITORY.owner, REPOSITORY.name, "release")))).toEqual([400, { code: "invalid" }])
  })

  test("the allowlist is matched without case, and an agent acting for a Member reads them too", async () => {
    const { github } = repository()
    const h = await routes(github, { actor: { ...maya, act: { kind: "agent", id: "chat-run-1" } } })
    expect((await h.fetch(repoFlowsRoute("Acme", "Widgets"))).status).toBe(200)
  })
})

describe("GET /api/repos/<owner>/<name>/flows/<flow>?ref=", () => {
  test("a flow's inputs at the branch's head, read in the realm, and the commit they were read at", async () => {
    const { github, sha } = repository()
    const h = await routes(github)
    expect(await answer(await h.fetch(`${flowInputsRoute(REPOSITORY.owner, REPOSITORY.name, "release")}?ref=main`))).toEqual([
      200,
      {
        sha,
        inputs: {
          type: "object",
          properties: { channel: { type: "string", enum: ["next", "latest"] }, dryRun: { type: "boolean", default: true } },
          required: ["channel"],
        },
      },
    ])
  })

  test("refuses a flow with no manual trigger, a branch or flow that isn't there, a bad ref, and a form no one can fill", async () => {
    const { github } = repository()
    github.push("main", { ".smithers/flows/gone/flow.ts": RELEASE })
    const h = await routes(github)
    const inputs = (flow: string, ref: string) => `${flowInputsRoute(REPOSITORY.owner, REPOSITORY.name, flow)}?ref=${ref}`
    expect(await answer(await h.fetch(inputs("gone", "main")))).toEqual([404, { code: "not_manual" }])
    expect(await answer(await h.fetch(inputs("release", "nope")))).toEqual([404, { code: "not_found" }])
    expect(await answer(await h.fetch(inputs("release", "..")))).toEqual([400, { code: "invalid" }])
    expect(await answer(await h.fetch(inputs("Bad Flow", "main")))).toEqual([400, { code: "invalid" }])
    expect(await answer(await h.fetch(inputs("ci", "main")))).toEqual([422, { code: "inputs" }])
    const noFile = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
    noFile.roles.set("maya", "write")
    noFile.push("main", { ".smithers/factory.json": MANIFEST })
    expect(await answer(await (await routes(noFile)).fetch(inputs("release", "main")))).toEqual([404, { code: "not_found" }])
  })
})

describe("POST /api/repos/<owner>/<name>/runs", () => {
  test("a run by hand: recorded as the person's, started at the branch's head with its inputs, once", async () => {
    const { github, sha } = repository()
    const h = await routes(github)
    const id = uuid()
    const runId = manualExecutionId("release", id)
    const body = { id, flow: "release", ref: "main", input: { channel: "next", dryRun: false } }
    expect(await answer(await h.fetch(repoRunsRoute(REPOSITORY.owner, REPOSITORY.name), post(body)))).toEqual([202, { runId }])
    expect(h.starts).toEqual([{
      flow: "repo/Run",
      executionId: runId,
      payload: {
        run: runId,
        repo: "acme/widgets",
        flow: "release",
        sha,
        ref: "refs/heads/main",
        event: "manual",
        secrets: true,
        input: { channel: "next", dryRun: false },
      },
    }])
    expect(await rows()).toEqual([{
      execution: runId,
      flow: "release",
      event: "manual",
      ref: "refs/heads/main",
      launched_by: MAYA,
      status: "working",
    }])
    // Sent again after the branch moved on: the same run, at the commit it first recorded.
    github.push("main", { "CHANGELOG.md": "next" })
    expect(await answer(await h.fetch(repoRunsRoute(REPOSITORY.owner, REPOSITORY.name), post(body)))).toEqual([200, { runId }])
    expect(await rows()).toHaveLength(1)
    expect((h.starts[1]!.payload as { readonly sha: string }).sha).toBe(sha)
    // A field the person leaves out that the form gives a default reaches the body with it.
    const defaulted = uuid()
    await h.fetch(repoRunsRoute(REPOSITORY.owner, REPOSITORY.name), post({ id: defaulted, flow: "release", ref: "main", input: { channel: "next" } }))
    expect(h.starts.at(-1)!.payload).toMatchObject({ input: { channel: "next", dryRun: true } })
    expect([h.count(RunsApi.starts, { kind: "manual", outcome: "started" }), h.count(RunsApi.starts, { kind: "manual", outcome: "existing" })])
      .toEqual([2, 1])
  })

  test("refuses a reader of the repository, inputs that don't fit the form, a body that isn't one, and a start the host can't record", async () => {
    const { github } = repository()
    const h = await routes(github)
    const path = repoRunsRoute(REPOSITORY.owner, REPOSITORY.name)
    const start = (input: unknown, extra: object = {}) => post({ id: uuid(), flow: "release", ref: "main", input, ...extra })
    expect(await answer(await (await routes(github, { actor: gus })).fetch(path, start({ channel: "next" }))))
      .toEqual([403, { code: "forbidden" }])
    for (const input of [{}, { channel: "beta" }, { channel: "next", dryRun: "yes" }, { channel: "next", other: 1 }, { channel: "next", toString: 1 }]) {
      expect([input, ...(await answer(await h.fetch(path, start(input))))]).toEqual([input, 422, { code: "inputs" }])
    }
    expect(await answer(await h.fetch(path, start({ channel: "next" }, { ref: "nope" })))).toEqual([404, { code: "not_found" }])
    expect(await answer(await h.fetch(path, start({}, { flow: "ci" })))).toEqual([422, { code: "inputs" }])
    expect(await answer(await h.fetch(path, start({ channel: "x".repeat(9_000) })))).toEqual([400, { code: "invalid" }])
    expect(await answer(await h.fetch(path, start({ channel: "next" }, { ref: "a b" })))).toEqual([400, { code: "invalid" }])
    expect(await answer(await h.fetch(path, post({ id: "not-a-uuid", flow: "release", ref: "main" })))).toEqual([400, { code: "invalid" }])
    expect((await h.fetch(path)).status).toBe(405)
    expect(h.starts).toEqual([])
    expect(await rows()).toEqual([])
    // An id the host holds for another run: refused, nothing new.
    const held = await routes(github, { starter: FlowStarter.of({ start: () => Effect.fail(new StartConflict()) }) })
    expect(await answer(await held.fetch(path, start({ channel: "next" })))).toEqual([409, { code: "conflict" }])
    const down = await routes(github, {
      starter: FlowStarter.of({ start: () => Effect.fail(new StartUnavailable({ errorCode: "no_host" })) }),
    })
    expect(await answer(await down.fetch(path, start({ channel: "next" })))).toEqual([503, { code: "unavailable" }])
  })
})

/** A reader of the engine schema the routes read. */
const engineOf = async (h: { readonly engineSchema: string }) =>
  ExecutionHost.readDatabase((await Effect.runPromise(TestDatabase.serverUrl)).toString(), h.engineSchema)

describe("POST /api/repos/<owner>/<name>/runs: a run again", { timeout: 120_000 }, () => {
  /**
   * An engine that ran `ci` at `sha` to its end on a machine where `exits` say how commands end, as a trigger's run
   * recorded on the repository; `use` gets the routes over that engine and the run's request.
   */
  const afterRun = async (
    exits: Readonly<Record<string, number>>,
    use: (h: Awaited<ReturnType<typeof routes>>, request: RepoFlow.RunRequest, stop: () => Promise<void>) => Promise<void>,
    hang = false,
  ) => {
    const { github, sha } = repository()
    const { services } = await githubServices(runtime, github)
    const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { context, engine } = yield* build(
        ExecutionHost.withRepoFlows(
          ExecutionHost.withCiJobs({ flows: [], registration: Layer.empty }, machine(exits, hang)),
          Effect.succeed({ ...services, machines: [] }),
          variant,
        ).registration,
      )
      const runId = `ci:${uuid()}`
      const request: RepoFlow.RunRequest = {
        run: runId,
        repo: "acme/widgets",
        flow: "ci",
        sha,
        ref: "refs/heads/main",
        event: "push",
        secrets: true,
      }
      yield* RepoRuns.record({ execution: runId, repoId: REPOSITORY.id, flow: "ci", sha, ref: request.ref, event: "push", launchedBy: "github" })
        .pipe(Effect.provide(scratch.database))
      const flows = Context.get(context, FlowRuntime.FlowRuntime)
      const execute = flows.execute(RepoFlow.Run, { executionId: runId, payload: request }).pipe(Effect.provide(context))
      if (hang) {
        yield* Effect.forkScoped(execute)
        yield* Effect.promise(() =>
          eventually(async () => (await Effect.runPromise(engine.status(runId))) === "running", 30_000))
      } else {
        expect(Exit.isSuccess(yield* Effect.exit(execute))).toBe(true)
      }
      const stop = async () => {
        await Effect.runPromise(flows.interrupt(RepoFlow.Run, runId).pipe(Effect.provide(context)))
        await eventually(async () => (await Effect.runPromise(engine.status(runId))) === "cancelled", 30_000)
      }
      yield* Effect.promise(async () => use(await routes(github, { engineSchema: engine.schema }), request, stop))
    })) as Effect.Effect<void>)
  }

  test("Retry runs the flow again at its commit; Retry failed only its jobs that didn't pass", async () => {
    await afterRun({ "pnpm lint": 1 }, async (h, request) => {
      const path = repoRunsRoute(REPOSITORY.owner, REPOSITORY.name)
      const again = uuid()
      expect(await answer(await h.fetch(path, post({ id: again, retryOf: request.run, failed: false }))))
        .toEqual([202, { runId: manualExecutionId("ci", again) }])
      const failedOnly = uuid()
      expect(await answer(await h.fetch(path, post({ id: failedOnly, retryOf: request.run, failed: true }))))
        .toEqual([202, { runId: manualExecutionId("ci", failedOnly) }])
      expect(h.starts.map((start) => start.payload)).toEqual([
        { ...request, run: manualExecutionId("ci", again) },
        { ...request, run: manualExecutionId("ci", failedOnly), only: ["lint"] },
      ])
      expect((await rows()).map((row) => [row.execution, row.event, row.launched_by])).toEqual(expect.arrayContaining([
        [manualExecutionId("ci", again), "push", MAYA],
        [manualExecutionId("ci", failedOnly), "push", MAYA],
      ]))
      expect([h.count(RunsApi.starts, { kind: "retry", outcome: "started" }), h.count(RunsApi.starts, { kind: "retry_failed", outcome: "started" })])
        .toEqual([1, 1])
      // Only a Member on the run's repository runs it again.
      const reader = await routes(scriptedGitHubWith("gus", "read"), { actor: gus, engineSchema: h.engineSchema })
      expect(await answer(await reader.fetch(path, post({ id: uuid(), retryOf: request.run, failed: false }))))
        .toEqual([403, { code: "forbidden" }])
    })
  })

  test("refuses a run still going; once stopped, Retry failed has no result to read failed jobs from", async () => {
    await afterRun({}, async (h, request, stop) => {
      const path = repoRunsRoute(REPOSITORY.owner, REPOSITORY.name)
      expect(await answer(await h.fetch(path, post({ id: uuid(), retryOf: request.run, failed: false }))))
        .toEqual([409, { code: "not_settled" }])
      await stop()
      // A stopped run has no result to report from.
      expect(await Effect.runPromise(RepoFlow.reportedFailure(request.run, await engineOf(h)))).toBe(false)
      expect(await answer(await h.fetch(path, post({ id: uuid(), retryOf: request.run, failed: true }))))
        .toEqual([409, { code: "nothing_failed" }])
      // A stopped run runs again whole.
      const id = uuid()
      expect(await answer(await h.fetch(path, post({ id, retryOf: request.run, failed: false }))))
        .toEqual([202, { runId: manualExecutionId("ci", id) }])
      // The same Retry sent again is the same run; another with an id the host holds is refused.
      const other = await routes(scriptedGitHubWith("maya", "write"), {
        engineSchema: h.engineSchema,
        starter: FlowStarter.of({ start: () => Effect.fail(new StartConflict()) }),
      })
      expect(await answer(await other.fetch(path, post({ id: uuid(), retryOf: request.run, failed: false }))))
        .toEqual([409, { code: "conflict" }])
      expect(await answer(await h.fetch(path, post({ id, retryOf: request.run, failed: false }))))
        .toEqual([200, { runId: manualExecutionId("ci", id) }])
    }, true)
  })

  test("refuses Retry failed of a run that passed, a run not begun, a run never recorded, and another repository's", async () => {
    await afterRun({}, async (h, request) => {
      const engine = await engineOf(h)
      expect(await runtime.runPromise(RepoRuns.settle(request.run, engine, RepoFlow.reportedFailure(request.run, engine))))
        .toEqual(Option.some("done"))
      const path = repoRunsRoute(REPOSITORY.owner, REPOSITORY.name)
      const retry = (retryOf: string, failed: boolean) => post({ id: uuid(), retryOf, failed })
      expect(await answer(await h.fetch(path, retry(request.run, true)))).toEqual([409, { code: "nothing_failed" }])
      // Recorded, and the engine never began it.
      const waiting = `ci:${uuid()}`
      await runtime.runPromise(RepoRuns.record({
        execution: waiting, repoId: REPOSITORY.id, flow: "ci", sha: request.sha, ref: request.ref, event: "push", launchedBy: "github",
      }))
      expect(await answer(await h.fetch(path, retry(waiting, false)))).toEqual([409, { code: "not_settled" }])
      expect(await answer(await h.fetch(path, retry(`ci:${uuid()}`, false)))).toEqual([404, { code: "not_found" }])
      // Another repository's run, asked through this one's route.
      const elsewhere = `ci:${uuid()}`
      await runtime.runPromise(RepoRuns.record({
        execution: elsewhere, repoId: "github/acme/other", flow: "ci", sha: request.sha, ref: request.ref, event: "push", launchedBy: "github",
      }))
      expect(await answer(await h.fetch(path, retry(elsewhere, false)))).toEqual([404, { code: "not_found" }])
      expect(h.starts).toEqual([])
    })
  })
})

/** The scripted repository where `login` has `permission`, and nothing on it. */
const scriptedGitHubWith = (login: string, permission: string) => {
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  github.roles.set(login, permission)
  return github
}

test("the routes' paths: a repository's flows, a flow, and its runs; nothing else", () => {
  expect(RunsApi.parsePath("/api/repos/acme/widgets/flows")).toEqual({ kind: "flows", owner: "acme", name: "widgets" })
  expect(RunsApi.parsePath("/api/repos/acme/widgets/flows/ci")).toEqual({ kind: "inputs", owner: "acme", name: "widgets", flow: "ci" })
  expect(RunsApi.parsePath("/api/repos/acme/widgets/runs")).toEqual({ kind: "runs", owner: "acme", name: "widgets" })
  for (const path of [
    "/api/repos/acme/widgets",
    "/api/repos/acme/widgets/flows/",
    "/api/repos//widgets/runs",
    "/api/repos/acme/widgets/runs/x",
    "/api/repos/acme/widgets/writes",
    "/api/repos/%E0%A4%A/widgets/runs",
    "/api/issues",
  ]) {
    expect([path, RunsApi.handles(path)]).toEqual([path, false])
  }
})

test("fits: only the form's fields, each of its type and choices, every required one present", () => {
  const inputs: Realm.Inputs = {
    type: "object",
    properties: {
      count: { type: "integer" },
      ratio: { type: "number" },
      dry: { type: "boolean" },
      channel: { type: "string", enum: ["next", "latest"] },
    },
    required: ["channel"],
  }
  expect(RunsApi.fits(inputs, { channel: "next", count: 2, ratio: 0.5, dry: false })).toBe(true)
  expect(RunsApi.fits(inputs, { channel: "next", count: 2.5 })).toBe(false)
  expect(RunsApi.fits(inputs, { channel: "next", ratio: Number.POSITIVE_INFINITY })).toBe(false)
  expect(RunsApi.fits(inputs, { channel: "next", ratio: "1" })).toBe(false)
  expect(RunsApi.fits(inputs, { channel: "next", dry: "no" })).toBe(false)
  expect(RunsApi.fits(inputs, { channel: "beta" })).toBe(false)
  expect(RunsApi.fits(inputs, { count: 1 })).toBe(false)
  expect(RunsApi.fits(inputs, { channel: "next", constructor: "x" })).toBe(false)
})

test("withDefaults: a left-out field gets its default; one given keeps its value, false and 0 included", () => {
  const inputs: Realm.Inputs = {
    type: "object",
    properties: { dry: { type: "boolean", default: true }, n: { type: "integer", default: 3 }, tag: { type: "string" } },
    required: [],
  }
  expect(RunsApi.withDefaults(inputs, {})).toEqual({ dry: true, n: 3 })
  expect(RunsApi.withDefaults(inputs, { dry: false, n: 0, tag: "x" })).toEqual({ dry: false, n: 0, tag: "x" })
})
