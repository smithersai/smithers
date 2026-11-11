// A repository's runs' rows (worker/RepoRuns.ts) on this file's schema of the compose Postgres (`pnpm db:up`), against
// a real engine on a schema of its own (worker/test/flowHost.ts), which keeps its runs in the same tables the Cloudflare
// host does: a recorded run settles from the engine's own status, and the runs it started are admitted as its own.
import { Action, Flow, FlowRuntime, Interpreter, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Context, Effect, Layer, Metric, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import * as ExecutionHost from "./ExecutionHost.ts"
import * as RepoRuns from "./RepoRuns.ts"
import { build } from "./test/flowHost.ts"
import { eventually, testFile, uuid } from "./test/harness.ts"

const runtime = testFile("repo_runs")
beforeEach(() => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE runs`)))

const SHA = "a".repeat(40)

class Broke extends Schema.TaggedError<Broke>()("repo-runs-test/Broke", {}) {}

const Job = Action.make("repo-runs-test/Job", { payload: { fail: Schema.Boolean }, success: Schema.String, error: Broke })

/** A job a run starts. */
const Child = Flow.make("repo-runs-test/Child", {
  description: "A job.",
  modelInvocable: false,
  payload: { fail: Schema.Boolean },
  success: Schema.String,
  error: Broke,
  body: Node.capture({}, ({ fail }) => Job.call({ fail })),
})

/** A repository's run: a wait of `pauseMs`, then one job, which fails when asked. */
const Run = Flow.make("repo-runs-test/Run", {
  description: "A repository's run.",
  modelInvocable: false,
  payload: { fail: Schema.Boolean, pauseMs: Schema.Number },
  success: Schema.String,
  error: Schema.Union([Broke, Sleep.SleepRequestInvalid]),
  body: Node.capture({}, ({ fail, pauseMs }) =>
    Sleep.action.call({ millis: pauseMs }).pipe(Node.andThen(Child.child({ fail })))),
})

const registration = Layer.mergeAll(
  Job.toLayer(({ fail }) => (fail ? Effect.fail(new Broke()) : Effect.succeed("passed"))),
  Interpreter.layer(Child, { callbackIdentity: "stable" }),
  Interpreter.layer(Run, { callbackIdentity: "stable" }),
).pipe(Layer.provideMerge(Action.layerImplementations))

/** A run recorded for `octo/hello` at `SHA`. */
const run = (execution: string, overrides: Partial<RepoRuns.RepoRun> = {}): RepoRuns.RepoRun => ({
  execution,
  repoId: "github/octo/hello",
  flow: "ci",
  sha: SHA,
  ref: "main",
  event: "push",
  launchedBy: "github",
  ...overrides,
})

const rows = () =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ readonly id: string; readonly execution: string; readonly status: string; readonly event: string }>`
      SELECT id::text, execution, status, event FROM runs ORDER BY execution`))

/** An engine on its own schema, read as the Durable Object reads it, until `body` settles. */
const withEngine = <A>(
  body: (engine: {
    readonly database: Layer.Layer<SqlClient.SqlClient>
    readonly execute: (executionId: string, fail: boolean) => Promise<void>
    /** Starts a run that waits a minute, and returns once the engine holds it waiting. */
    readonly park: (executionId: string) => Promise<void>
    readonly status: (executionId: string) => Promise<string | undefined>
    readonly cancel: (executionId: string) => Promise<void>
    readonly children: (executionId: string) => Promise<ReadonlyArray<string>>
  }) => Promise<A>,
): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const { context, engine } = yield* build(registration)
    const scope = yield* Effect.scope
    const server = yield* TestDatabase.serverUrl
    const flows = Context.get(context, FlowRuntime.FlowRuntime)
    const database = ExecutionHost.readDatabase(server.toString(), engine.schema)
    return yield* Effect.promise(() =>
      body({
        database,
        execute: (executionId, fail) =>
          Effect.runPromise(
            Effect.ignore(flows.execute(Run, { executionId, payload: { fail, pauseMs: 0 } }).pipe(Effect.provide(context))),
          ),
        park: async (executionId) => {
          await Effect.runPromise(Effect.asVoid(Effect.forkIn(
            Effect.ignore(flows.execute(Run, { executionId, payload: { fail: false, pauseMs: 60_000 } }).pipe(
              Effect.provide(context),
            )),
            scope,
          )))
          await eventually(async () => (await Effect.runPromise(engine.status(executionId))) === "suspended", 10_000)
        },
        status: (executionId) => Effect.runPromise(engine.status(executionId)),
        cancel: (executionId) => Effect.runPromise(flows.interrupt(Run, executionId).pipe(Effect.provide(context))),
        children: (executionId) =>
          Effect.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
            sql<{ readonly run_id: string }>`
              SELECT run_id FROM flows_runs WHERE parent_run_id = ${executionId}
              UNION SELECT child_id FROM flows_run_parents WHERE parent_id = ${executionId}`).pipe(
              Effect.map((found) => found.map((row) => row.run_id)),
              Effect.provide(database),
            )),
      })
    )
  })) as Effect.Effect<A>)

const registry = (): Metric.MetricRegistry => new Map()

describe("record", () => {
  test("records a run working under its execution's own row id, once", async () => {
    const metrics = registry()
    const execution = `ci:${uuid()}`
    const recorded = (value: RepoRuns.RepoRun) =>
      runtime.runPromise(RepoRuns.record(value).pipe(Effect.provideService(Metric.MetricRegistry, metrics)))
    expect(await recorded(run(execution))).toBe(true)
    // A start sent again: the same row, nothing new, even with other words.
    expect(await recorded(run(execution, { event: "manual" }))).toBe(false)
    const id = await runtime.runPromise(RepoRuns.rowIdOf(execution))
    expect(await rows()).toEqual([{ id, execution, status: "working", event: "push" }])
    const counted = (outcome: string) =>
      runtime.runSync(Metric.value(Metric.withAttributes(RepoRuns.writes, { op: "record", outcome })).pipe(
        Effect.provideService(Metric.MetricRegistry, metrics),
      )).count
    expect([counted("recorded"), counted("existing")]).toEqual([1, 1])
  })

  test("refuses a row without its commit, ref or event, and an event it doesn't know", async () => {
    for (const partial of [{ sha: "short" }, { ref: "" }, { event: "workflow_dispatch" as never }]) {
      const exit = await runtime.runPromiseExit(RepoRuns.record(run(`ci:${uuid()}`, partial)))
      expect(exit._tag).toBe("Failure")
    }
    expect(await rows()).toEqual([])
  })
})

describe("settle", () => {
  test("a passed run is done, a failed one failed, a stopped one stopped; again, or unsettled, changes nothing", async () => {
    await withEngine(async (engine) => {
      const passed = `ci:${uuid()}`
      const failed = `ci:${uuid()}`
      const stopped = `ci:${uuid()}`
      const waiting = `ci:${uuid()}`
      const unbegun = `ci:${uuid()}`
      for (const execution of [passed, failed, stopped, waiting, unbegun]) await runtime.runPromise(RepoRuns.record(run(execution)))
      await engine.execute(passed, false)
      await engine.execute(failed, true)
      await engine.park(stopped)
      await engine.cancel(stopped)
      await eventually(async () => (await engine.status(stopped)) === "cancelled", 10_000)
      await engine.park(waiting)
      const settled = (execution: string) => runtime.runPromise(RepoRuns.settle(execution, engine.database))
      expect(await settled(passed)).toEqual(Option.some("done"))
      expect(await settled(failed)).toEqual(Option.some("failed"))
      // Stopped while it waited: the engine records it cancelled.
      expect(await settled(stopped)).toEqual(Option.some("stopped"))
      // Still waiting: nothing to settle.
      expect(await settled(waiting)).toEqual(Option.none())
      // Its object settled a run the engine never began: it was stopped before it started.
      expect(await settled(unbegun)).toEqual(Option.some("stopped"))
      // A settlement seen twice writes once; a run no row records is no repository's.
      expect(await settled(passed)).toEqual(Option.none())
      expect(await settled(`chat-expire-${uuid()}`)).toEqual(Option.none())
      const states = new Map((await rows()).map((row) => [row.execution, row.status]))
      expect([passed, failed, stopped, waiting, unbegun].map((execution) => states.get(execution))).toEqual([
        "done",
        "failed",
        "stopped",
        "working",
        "stopped",
      ])
    })
  })
})

describe("admit", () => {
  test("a recorded run is its own; a job it started is its run's; any other run is none", async () => {
    await withEngine(async (engine) => {
      const execution = `ci:${uuid()}`
      const notBegun = `ci:${uuid()}`
      const unrecorded = `other:${uuid()}`
      await runtime.runPromise(RepoRuns.record(run(execution)))
      await runtime.runPromise(RepoRuns.record(run(notBegun, { repoId: "github/octo/other" })))
      await engine.execute(execution, false)
      await engine.execute(unrecorded, false)
      const [job] = await engine.children(execution)
      const [unrecordedJob] = await engine.children(unrecorded)
      const admitted = (runId: string) => runtime.runPromise(RepoRuns.admit(runId, engine.database))
      const own = Option.some({ execution, repoId: "github/octo/hello" })
      expect(await admitted(execution)).toEqual(own)
      expect(await admitted(job!)).toEqual(own)
      expect(await admitted(notBegun)).toEqual(Option.some({ execution: notBegun, repoId: "github/octo/other" }))
      expect(await admitted(unrecorded)).toEqual(Option.none())
      expect(await admitted(unrecordedJob!)).toEqual(Option.none())
      expect(await admitted(`ci:${uuid()}`)).toEqual(Option.none())
      // Past the walk's depth, a job is no run's.
      expect(await runtime.runPromise(RepoRuns.admit(job!, engine.database, 0))).toEqual(Option.none())
    })
  })
})
