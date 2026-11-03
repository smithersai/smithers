// Stop through the real HTTP handler, session store, role receipts, engine and agent job store.
import { AgentRunner } from "@smthrs/agent"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Context, Deferred, Effect, Layer, Option } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import { stopRoute } from "../src/features/runs/contract.ts"
import * as ExecutionHost from "./ExecutionHost.ts"
import * as RemoteRuns from "./RemoteRuns.ts"
import * as RepoRuns from "./RepoRuns.ts"
import * as Stack from "./stack/Stack.ts"
import * as Jobs from "./runners/Jobs.ts"
import * as RepoRoles from "./github/RepoRoles.ts"
import { repositoryOf } from "./github/Config.ts"
import { app } from "./github/test/harness.ts"
import { reset, REPOSITORY } from "./github/test/fixtures.ts"
import { accountIdOf, appKey, scriptedGitHub } from "./github/test/scriptedGitHub.ts"
import { configured, cookie, signInHarness } from "./test/signIn.ts"
import { build } from "./test/flowHost.ts"
import { testFile, uuid } from "./test/harness.ts"

const runtime = testFile("remote_run_authority")
beforeEach(async () => {
  await reset(runtime)
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`TRUNCATE runs, stack_ops, todo_attempts, todo_requests, todos, stacks, agent_jobs CASCADE`))
})

// A running external-agent action makes the TODO eligible for Stop. Its real job lives in Postgres.
const Session = Action.make("agent/Session", { payload: {} })
const Working = Flow.make("stop-authority/Working", {
  payload: {}, body: Node.capture({}, () => Session.call({})),
})

test.each([
  { kind: "repo", authority: "session", gate: "github" },
  { kind: "todo", authority: "session", gate: "github" },
  { kind: "repo", authority: "role", gate: "held" },
  { kind: "todo", authority: "role", gate: "held" },
  { kind: "repo", authority: "unchanged", gate: "held" },
  { kind: "todo", authority: "unchanged", gate: "held" },
] as const)("delayed $kind cancel rechecks $authority after $gate read", async ({ kind, authority, gate }) => {
  const auth = await signInHarness(runtime, { config: configured })
  auth.github.person = { id: accountIdOf("maya"), login: "maya" }
  const signed = await auth.signInAs()
  expect(signed.response.status).toBe(303)
  const [person] = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ id: string }>`SELECT id::text FROM people WHERE github_login = 'maya'`))
  const database = (await runtime.runPromise(TestDatabase.Scratch)).database
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  github.roles.set("maya", "write")
  const roles = await runtime.runPromise(RepoRoles.make(database, {
    repository: repositoryOf("acme/home"), app: Option.some(app({ privateKey: await appKey() })), http: github.http,
  }))
  let entered!: () => void
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { entered = resolve })
  const proceed = new Promise<void>((resolve) => { release = resolve })
  if (gate === "github") github.faults.push({
    match: (method, path) => method === "GET" && path.endsWith("/collaborators/maya/permission"),
    hold: () => { entered(); return proceed },
  })
  const delayedRoles = gate === "held" ? { ...roles,
    resolve: (...args: Parameters<typeof roles.resolve>) => roles.resolve(...args).pipe(
      Effect.tap(() => Effect.promise(() => { entered(); return proceed })),
    ),
  } : roles
  await runtime.runPromise(Effect.scoped(Effect.gen(function* () {
    const working = yield* Deferred.make<void>()
    const registration = Layer.merge(Session.toLayer(() => Deferred.succeed(working, undefined).pipe(Effect.andThen(Effect.never))),
      Interpreter.layer(Working)).pipe(Layer.provideMerge(Action.layerImplementations))
    const { context, engine } = yield* build(registration)
    const server = yield* TestDatabase.serverUrl
    let runId = `ci:${uuid()}`
    let jobKey: string | undefined
    if (kind === "todo") {
      const applied = yield* Stack.apply({ opId: uuid(), repoId: REPOSITORY.id,
        actor: { id: person!.id, login: "maya" }, via: "person",
        op: { kind: "commit", title: "Stop authority", prompt: "Inspect", acceptance: [] },
      }, { runs: true }).pipe(Effect.provide(database))
      if (applied.kind !== "applied") return yield* Effect.die("attempt not admitted")
      const start = applied.receipt.starts[0]!
      runId = `todo:${start.attemptId}`
      jobKey = `stop-authority:${uuid()}#g1`
      const task: AgentRunner.Task = {
        agent: { name: "coder", labels: [], profile: "coder", maxHours: 1, restarts: 0 },
        repository: REPOSITORY.id, base: "a".repeat(40), system: [], prompt: "Inspect",
        limits: { files: 1, bytes: 100 }, context: { attemptId: start.attemptId },
      }
      yield* Jobs.make(database).start(task, jobKey)
      yield* Effect.forkScoped((Context.get(context, FlowRuntime.FlowRuntime)).execute(Working, {
        executionId: runId, payload: {},
      }).pipe(Effect.provide(context)))
      yield* Deferred.await(working)
    } else {
      yield* RepoRuns.record({ execution: runId, repoId: REPOSITORY.id, flow: "ci", sha: "a".repeat(40),
        ref: "refs/heads/main", event: "manual", launchedBy: person!.id }).pipe(Effect.provide(database))
    }
    const stopped: string[] = []
    const api = yield* RemoteRuns.make(database, {
      database: ExecutionHost.readDatabase(server.toString(), engine.schema),
      writer: ExecutionHost.database(server.toString(), engine.schema), schema: engine.schema, flows: [Working],
      repositoryRun: (execution) => Effect.succeed(Option.some({ execution, repoId: REPOSITORY.id })),
      stop: (execution) => Effect.sync(() => void stopped.push(execution)), transcript: () => Effect.die("unused"),
    }, delayedRoles)
    const handler = HttpEffect.toWebHandler(api.fetch.pipe(Effect.provide(auth.sessions), Effect.provide(FetchHttpClient.layer)))
    yield* Effect.promise(async () => {
      const pending = handler(new Request(`http://chat.test${stopRoute(runId)}`, {
        method: "POST", headers: { cookie: cookie(signed.cookies), "x-smithers-device-person": person!.id },
      }))
      await Promise.race([waiting, pending.then((response) => { throw new Error(`stop ended before gate: ${response.status}`) })])
      try {
        await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => authority === "session"
          ? sql`UPDATE sessions SET revoked_at = clock_timestamp(), revoked_reason = 'sign_out' WHERE person_id = ${person!.id}`
          : authority === "role"
          ? sql`UPDATE github_repo_roles SET role = 'guest' WHERE repo_id = ${REPOSITORY.id} AND person_id = ${person!.id}`
          : Effect.void))
      } finally { release() }
      const response = await pending
      expect([response.status, await response.json()], `delayed cancel must revalidate ${authority}`).toEqual(
        authority === "unchanged" ? [202, { outcome: "requested" }]
          : authority === "session" ? [401, { code: "authentication" }] : [403, { code: "forbidden" }],
      )
      expect(stopped).toEqual(kind === "repo" && authority === "unchanged" ? [runId] : [])
      if (jobKey !== undefined) {
        const [job] = await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql<{ cancel_requested: boolean; status: string }>`SELECT cancel_requested, status FROM agent_jobs WHERE key = ${jobKey}`))
        expect(job).toEqual(authority === "unchanged"
          ? { cancel_requested: true, status: "cancelled" } : { cancel_requested: false, status: "queued" })
      }
    })
  })))
})
