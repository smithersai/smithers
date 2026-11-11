import { TestSchemas } from "@smthrs/database"
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
import * as TodoSession from "./TodoSession.ts"

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
    Effect.succeed({ ...services, reviewerFor: () => seat, start: () => Effect.void }),
    machines,
    TodoAgent.registration(seat, services.database, Agent.layerSandbox),
  )
  // An external agent's step runs as its own child execution, with its two continuations (decision 0136).
  const todoFlows = [
    Todo.Todo,
    ...TodoSession.Session.flows,
    TodoDrop.Drop,
    TodoBaseClosed.Invalidate,
    Checks.ChecksRun,
    Checks.ReviewRun,
    // The review flows rounds, which a heads review runs as its child execution.
    ...Checks.reviewFlows,
  ]
  expect(flows.flows.slice(-todoFlows.length)).toEqual(todoFlows)
  expect(flows.flows.some((flow) => flow._tag === "issue/Prototype")).toBe(false)
  /** One execution's object: its own storage, routing the executions it starts to their own objects. */
  interface Host {
    readonly start: (intent: Effect.Success<ReturnType<typeof ExecutionHost.intent>>) => Effect.Effect<unknown, unknown>
    readonly wake: () => Effect.Effect<unknown, unknown>
    readonly alarm: () => Effect.Effect<{ readonly _tag: string }, unknown>
  }
  const objects = new Map<string, Host>()
  const objectOf = (executionId: string, url: string, schema: string): Host => {
    const found = objects.get(executionId)
    if (found !== undefined) return found
    const values = new Map<string, unknown>()
    const storage: ExecutionHost.Storage = {
      get: <A>(key: string) => Effect.sync(() => structuredClone(values.get(key)) as A | undefined),
      put: (key, value) => Effect.sync(() => void values.set(key, structuredClone(value))),
      delete: (key) => Effect.sync(() => values.delete(key)),
      setAlarm: () => Effect.void,
      deleteAlarm: () => Effect.void,
    }
    const host = ExecutionHost.make(storage, {
      hostId: `object-${executionId}`,
      database: ExecutionHost.database(url, schema),
      flows,
      router: {
        start: (intent) => Effect.suspend(() => objectOf(intent.executionId, url, schema).start(intent)),
        wake: (id) => Effect.suspend(() => objectOf(id, url, schema).wake()),
      },
    }) as unknown as Host
    objects.set(executionId, host)
    return host
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
      const name = TestSchemas.schemaName("flows")
      yield* Effect.addFinalizer(() => Effect.orDie(client`DROP SCHEMA IF EXISTS ${client(name)} CASCADE`))
      const executionId = checkExecutionId(request.repoId, request.sha, "all")
      const host = objectOf(executionId, url, name)
      yield* host.start(yield* ExecutionHost.intent(Checks.ChecksRun, { executionId, payload: request }))
      // The head's review runs the review flow's rounds as a child execution on its own object, which wakes this one
      // when it settles: each object's alarm runs until checks/Run settles.
      let driven = yield* host.alarm()
      for (let drives = 1; driven._tag !== "Settled" && drives < 40; drives++) {
        for (const [id, other] of [...objects]) if (id !== executionId) yield* other.alarm()
        driven = yield* host.alarm()
      }
      expect(driven).toMatchObject({ _tag: "Settled" })
      expect(objects.size).toBeGreaterThan(1)
    })),
  )
  expect(await sql(runtime, `SELECT flow, status FROM runs ORDER BY flow`)).toEqual([
    { flow: "checks/checkout", status: "failed" },
    { flow: "checks/review", status: "failed" },
  ])
})
