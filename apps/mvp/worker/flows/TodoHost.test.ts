// The coding factory's flows on the Durable Object's handlers (worker/ExecutionHost.ts `withTodos`): a head's
// `checks/Run` registered beside the `todo` run and driven to the end over the compose Postgres (`pnpm db:up`) with an
// in-memory object storage, as worker/github/Host.test.ts drives `github/Write`. The machine is a test `Machines`.
import * as Pg from "@effect/sql-pg"
import { Agent } from "@smthrs/agent"
import { Context, Effect, Layer, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, expect, test } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { checkExecutionId } from "../../src/features/pulls/contract.ts"
import { Machines } from "../branch/Machines.ts"
import { noCommands } from "../test/commands.ts"
import * as ExecutionHost from "../ExecutionHost.ts"
import * as Expire from "./Expire.ts"
import { judgeSeat, judging, REPOSITORY, reset, services as githubServices, signedIn, sql } from "../github/test/fixtures.ts"
import { scriptedGitHub } from "../github/test/scriptedGitHub.ts"
import { testFile } from "../test/harness.ts"
import * as Checks from "./Checks.ts"
import * as Todo from "./Todo.ts"
import * as TodoBaseClosed from "./TodoBaseClosed.ts"
import * as TodoDrop from "./TodoDrop.ts"
import * as TodoAgent from "./TodoAgent.ts"

const runtime = testFile("todo_host")
beforeEach(async () => {
  await reset(runtime)
  await sql(runtime, "TRUNCATE runs")
})

test("withTodos registers the todo run and a head's checks, and the object runs checks/Run to the end", async () => {
  const github = scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
  const maya = await signedIn(runtime, { login: "maya", token: github.userToken("maya") })
  const { seat } = await judgeSeat(runtime, judging("abstain"))
  const { services } = await githubServices(runtime, github, { judge: seat })
  // No App on the repository: the review check fails at once; the machine refuses every call, so the head's checkout
  // fails and no script runs.
  github.installed = false
  const machines = Layer.succeed(Machines, Machines.of({
    commands: () => noCommands,
    tool: () => Effect.fail({ _tag: "@smthrs/sandbox/SandboxTools/ToolRefused", reason: "not_found" } as never),
    sleepIfIdle: () => Effect.die("unused"),
  }))
  const flows = ExecutionHost.withTodos(
    ExecutionHost.remote({ database: services.database, expiry: Expire.DEFAULT_EXPIRY }),
    Effect.succeed({ ...services, judgeFor: () => seat, start: () => Effect.void }),
    machines,
    TodoAgent.registration(seat, services.database, Agent.layerSandbox),
  )
  expect(flows.flows.slice(-4)).toEqual([Todo.Todo, TodoDrop.Drop, TodoBaseClosed.Invalidate, Checks.ChecksRun])
  expect(flows.flows.some((flow) => flow._tag === "issue/Prototype")).toBe(false)
  const values = new Map<string, unknown>()
  const storage: ExecutionHost.Storage = {
    get: <A>(key: string) => Effect.sync(() => structuredClone(values.get(key)) as A | undefined),
    put: (key, value) => Effect.sync(() => void values.set(key, structuredClone(value))),
    delete: (key) => Effect.sync(() => values.delete(key)),
    setAlarm: () => Effect.void,
    deleteAlarm: () => Effect.void,
  }
  const request: Checks.ChecksRequest = {
    repoId: REPOSITORY.id,
    sha: "a".repeat(40),
    prNumber: 1,
    baseSha: "b".repeat(40),
    attemptId: crypto.randomUUID(),
    branch: "smithers/t1",
    ownerId: maya.personId,
  }
  await Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      const url = (yield* TestDatabase.serverUrl).toString()
      const admin = yield* Layer.build(Pg.PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }))
      const client = Context.get(admin, SqlClient.SqlClient)
      const name = `flows_${crypto.randomUUID().replaceAll("-", "")}`
      yield* Effect.addFinalizer(() => Effect.orDie(client`DROP SCHEMA IF EXISTS ${client(name)} CASCADE`))
      const executionId = checkExecutionId(request.repoId, request.sha, "all")
      const host = ExecutionHost.make(storage, {
        hostId: `object-${executionId}`,
        database: ExecutionHost.database(url, name),
        flows,
        router: { start: () => Effect.void, wake: () => Effect.void },
      })
      yield* host.start(yield* ExecutionHost.intent(Checks.ChecksRun, { executionId, payload: request }))
      let driven = yield* host.alarm()
      for (let drives = 1; driven._tag !== "Settled" && drives < 20; drives++) driven = yield* host.alarm()
      expect(driven).toMatchObject({ _tag: "Settled" })
    })),
  )
  expect(await sql(runtime, `SELECT flow, status FROM runs ORDER BY flow`)).toEqual([
    { flow: "checks/checkout", status: "failed" },
    { flow: "checks/review", status: "failed" },
  ])
})
