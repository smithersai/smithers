// A TODO's run read from the browser (worker/RemoteRuns.ts, ruling TODO-3) through the real handler, on this file's
// schema of the compose Postgres and Electric (`pnpm db:up`), against a real engine on a schema of its own: the Node
// host's (worker/test/flowHost.ts), which keeps its runs, journal and change feed in the same tables the Cloudflare host
// does. The run is a small flow under a TODO attempt's execution id, `todo:<attempt id>`; its payload carries a
// `Redacted` sentinel and its first step answers more than 16 KiB, so the read proves what leaves the engine.
import * as Pg from "@effect/sql-pg"
import { PostgresDatabase } from "@smthrs/database"
import { Action, Flow, FlowRuntime, Interpreter, RetryPolicy, Sleep } from "@smthrs/flow"
import { Database, EngineStore, Journal } from "@smthrs/flows"
import { Notification, NotificationQueue } from "@smthrs/notifications"
import { Logger as StructuredLogger } from "@smthrs/observability"
import { Node } from "@smthrs/plan"
import { ConfigProvider, Context, Effect, Layer, Logger, Metric, Option, Redacted, Schema, Tracer } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import { SqlClient } from "effect/sql"
import { beforeEach, describe, expect, test } from "vitest"
import * as TestDatabase from "../db/TestDatabase.ts"
import { todoExecutionId } from "../src/features/pulls/contract.ts"
import {
  CLOUD_RUNS_ROUTE,
  MAX_STEER_CHARS,
  REMOTE_RUN_SHAPE_ROUTE,
  remoteRunRoute,
  steersRoute,
  stopRoute,
} from "../src/features/runs/contract.ts"
import * as Actor from "./Actor.ts"
import * as CloudRuns from "./CloudRuns.ts"
import * as ExecutionHost from "./ExecutionHost.ts"
import * as RemoteRuns from "./RemoteRuns.ts"
import * as RepoRuns from "./RepoRuns.ts"
import * as RepoRoles from "./github/RepoRoles.ts"
import { repositoryOf } from "./github/Config.ts"
import * as Stack from "./stack/Stack.ts"
import { build } from "./test/flowHost.ts"
import { eventually, recorded, signedIn, testFile, uuid } from "./test/harness.ts"

const runtime = testFile("remote_runs")
beforeEach(() =>
  runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`TRUNCATE stack_ops, todo_attempts, todo_requests, todos, stacks, runs`))
)

const member: Actor.Actor = { subject: { kind: "person", id: "person-member" }, role: "member", login: "maya" }
const guest: Actor.Actor = { subject: { kind: "person", id: "person-guest" }, role: "guest", login: "gus" }

const SENTINEL = "sentinel-remote-run-4b7e-never-shown"

const Produce = Action.make("remote-runs-test/Produce", { payload: { size: Schema.Number }, success: Schema.String })

/** A run another starts: it produces `size` characters. */
const Child = Flow.make("remote-runs-test/Child", {
  description: "A run the watched run starts.",
  modelInvocable: false,
  payload: { size: Schema.Number },
  success: Schema.String,
  body: Node.capture({}, ({ size }) => Produce.call({ size })),
})

/** Produces `size` characters, waits `pauseMs` on a durable timer, then starts a child that produces more. */
const Watched = Flow.make("remote-runs-test/Watched", {
  description: "A run a person watches from another device.",
  modelInvocable: false,
  payload: { opaque: Schema.Redacted(Schema.String), size: Schema.Number, pauseMs: Schema.Number },
  success: Schema.String,
  error: Sleep.SleepRequestInvalid,
  body: Node.capture({}, ({ size, pauseMs }) =>
    Produce.call({ size }).pipe(
      Node.andThen(Sleep.action.call({ millis: pauseMs })),
      Node.andThen(Child.child({ size: 17_000 })),
    )),
})

/** A step under the steered agent's action name, `todo/Implement`, that ends at once. */
const Implemented = Action.make("todo/Implement", { payload: {}, success: Schema.String })

/** A run whose agent's step has ended and which then waits `pauseMs` on a durable timer, as a TODO in review does. */
const Reviewed = Flow.make("remote-runs-test/Reviewed", {
  description: "A run past its agent's step.",
  modelInvocable: false,
  payload: { pauseMs: Schema.Number },
  success: Schema.Void,
  error: Sleep.SleepRequestInvalid,
  body: Node.capture({}, ({ pauseMs }) => Implemented.call({}).pipe(Node.andThen(Sleep.action.call({ millis: pauseMs })))),
})

class ChecksFailed extends Schema.TaggedError<ChecksFailed>()("remote-runs-test/ChecksFailed", {
  code: Schema.Literal("checks_failed"),
}) {}

/** A TODO's checks step: it logs what it runs, a credential among it, and fails on both of its attempts. */
const Check = Action.make("remote-runs-test/Check", {
  payload: {},
  success: Schema.String,
  error: ChecksFailed,
  retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 2 }),
})

/** A run whose one step fails, as a TODO's failed checks do. */
const Checked = Flow.make("remote-runs-test/Checked", {
  description: "A run whose checks fail.",
  modelInvocable: false,
  payload: {},
  success: Schema.String,
  error: ChecksFailed,
  body: Node.capture({}, () => Check.call({})),
})

/** While set, `Produce` waits for it: a run holds in its first step until the test releases it. */
let producing: { readonly wait: Promise<void>; readonly entered: () => void } | undefined

const registration = Layer.mergeAll(
  Produce.toLayer(({ size }) => Effect.promise(() => {
    producing?.entered()
    return producing?.wait ?? Promise.resolve()
  }).pipe(Effect.as("x".repeat(size)))),
  Implemented.toLayer(() => Effect.succeed("done")),
  // A step that logs names and codes, as app steps do, plus a credential three ways the engine must redact.
  Check.toLayer(() =>
    Effect.gen(function* () {
      yield* Effect.logInfo("running checks", { suite: "unit" })
      yield* Effect.logInfo("token", Redacted.make(SENTINEL)).pipe(Effect.annotateLogs({ apiKey: SENTINEL }))
      yield* Effect.logInfo(`Authorization: Bearer ${SENTINEL}`)
      yield* Effect.logWarning("checks failed").pipe(Effect.annotateLogs({ code: "checks_failed", failures: 2 }))
      return yield* Effect.fail(new ChecksFailed({ code: "checks_failed" }))
    })),
  Interpreter.layer(Checked, { callbackIdentity: "stable" }),
  Interpreter.layer(Child, { callbackIdentity: "stable" }),
  Interpreter.layer(Watched, { callbackIdentity: "stable" }),
  Interpreter.layer(Reviewed, { callbackIdentity: "stable" }),
).pipe(Layer.provideMerge(Action.layerImplementations))

/** A TODO committed on a host that runs TODOs, to `repoId`'s stack: its first attempt, recorded by the writer. */
const attempt = (repoId = "github/octo/hello") =>
  runtime.runPromise(
    Effect.map(
      Stack.apply({
        opId: uuid(),
        repoId,
        actor: { id: member.subject.id, login: "maya" },
        via: "person",
        op: { kind: "commit", title: "Watch me", prompt: "Anything.", acceptance: [] },
      }, { runs: true }),
      (applied) => (applied.kind === "applied" ? applied.receipt.starts[0]! : undefined)!,
    ),
  )

/** The engine a test watches, on its own schema of the compose Postgres, until `body` settles. */
interface Engine {
  readonly schema: string
  readonly database: Layer.Layer<SqlClient.SqlClient>
  /** A writer of the engine's schema, as ChatApi admits a steer. */
  readonly writer: Layer.Layer<SqlClient.SqlClient>
  /** Runs `Watched` as `executionId` to its end. */
  readonly run: (executionId: string, pauseMs?: number) => Promise<void>
  /** Starts `Watched` as `executionId` and returns at once; the run goes on until the engine closes. */
  readonly start: (executionId: string, pauseMs: number) => Promise<void>
  readonly cancel: (executionId: string) => Promise<void>
  /** Starts `Reviewed` as `executionId` and returns at once. */
  readonly review: (executionId: string, pauseMs: number) => Promise<void>
  /** Runs `Checked` as `executionId` until it fails. */
  readonly check: (executionId: string) => Promise<void>
  /** A run's status in the engine. */
  readonly status: (executionId: string) => Promise<string | undefined>
  /** The runs a run started. */
  readonly children: (executionId: string) => Promise<ReadonlyArray<string>>
}

const withEngine = <A>(body: (engine: Engine) => Promise<A>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { context, engine } = yield* build(registration)
        const scope = yield* Effect.scope
        const server = yield* TestDatabase.serverUrl
        const flows = Context.get(context, FlowRuntime.FlowRuntime)
        const execute = (executionId: string, pauseMs: number) =>
          flows.execute(Watched, {
            executionId,
            payload: { opaque: Redacted.make(SENTINEL), size: 20_000, pauseMs },
          }).pipe(Effect.provide(context))
        return yield* Effect.promise(() =>
          body({
            schema: engine.schema,
            // As ChatApi reads the deployed engine: read-only.
            database: ExecutionHost.readDatabase(server.toString(), engine.schema),
            writer: ExecutionHost.database(server.toString(), engine.schema),
            review: (executionId, pauseMs) =>
              Effect.runPromise(Effect.asVoid(Effect.forkIn(
                Effect.ignore(flows.execute(Reviewed, { executionId, payload: { pauseMs } }).pipe(Effect.provide(context))),
                scope,
              ))),
            check: (executionId) =>
              Effect.runPromise(Effect.ignore(flows.execute(Checked, { executionId, payload: {} }).pipe(Effect.provide(context)))),
            status: (executionId) => Effect.runPromise(engine.status(executionId)),
            children: (executionId) =>
              Effect.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
                sql<{ readonly run_id: string }>`
                  SELECT run_id FROM flows_runs WHERE parent_run_id = ${executionId}
                  UNION SELECT child_id FROM flows_run_parents WHERE parent_id = ${executionId}`).pipe(
                  Effect.map((rows) => rows.map((row) => row.run_id)),
                  Effect.provide(ExecutionHost.readDatabase(server.toString(), engine.schema)),
                )),
            cancel: (executionId) => Effect.runPromise(flows.interrupt(Watched, executionId).pipe(Effect.provide(context))),
            run: (executionId, pauseMs = 0) => Effect.runPromise(Effect.asVoid(Effect.orDie(execute(executionId, pauseMs)))),
            start: (executionId, pauseMs) =>
              Effect.runPromise(Effect.asVoid(Effect.forkIn(Effect.ignore(execute(executionId, pauseMs)), scope))),
          })
        )
      }),
    ) as Effect.Effect<A>,
  )

type StructuredLog = ReturnType<typeof StructuredLogger.formatStructured.log>

/** The routes as ChatApi serves them, over this file's schema and `engine`, recording every log line, span and metric. */
const routes = async (
  engine: Pick<Engine, "schema" | "database" | "writer">,
  options: {
    readonly actor?: Actor.Actor
    readonly sessions?: Layer.Layer<Actor.Sessions>
    /** The app's tables: the file's schema unless set. */
    readonly database?: Layer.Layer<SqlClient.SqlClient>
    /** What the run's Durable Object does with a stop; nothing unless set. */
    readonly roles?: RepoRoles.RepoRoles
    readonly stop?: (runId: string) => Effect.Effect<void, unknown>
  } = {},
) => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(spanOptions) {
      const span = new Tracer.NativeSpan(spanOptions)
      spans.push(span)
      return span
    },
  })
  const logs: Array<StructuredLog> = []
  const logger = Logger.make((logOptions) => void logs.push(StructuredLogger.formatStructured.log(logOptions)))
  const registry: Metric.MetricRegistry = new Map()
  /** Every request sent to Electric. */
  const electric: Array<URL> = []
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    electric.push(new URL(url))
    return globalThis.fetch(url, init)
  }
  const provider = ConfigProvider.fromUnknown({ ELECTRIC_URL: await runtime.runPromise(TestDatabase.electricUrl) })
  const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Metric.MetricRegistry, registry),
      Effect.provideService(ConfigProvider.ConfigProvider, provider),
    )
  const api = await runtime.runPromise(
    observed(Effect.flatMap(options.roles === undefined
      ? RepoRoles.make(scratch.database, { repository: repositoryOf("octo/hello"), app: Option.none() })
      : Effect.succeed(options.roles), (roles) =>
      RemoteRuns.make(options.database ?? scratch.database, {
        database: engine.database,
        writer: engine.writer,
        schema: engine.schema,
        flows: [Watched, Reviewed, Checked],
        stop: options.stop ?? (() => Effect.void),
      }, roles)),
    ),
  )
  const handler = HttpEffect.toWebHandler(
    observed(
      api.fetch.pipe(
        Effect.provide(options.sessions ?? (options.actor === undefined ? Actor.signedOut : signedIn(options.actor))),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    ),
  )
  return {
    fetch: (path: string, init?: RequestInit) => handler(new Request(`http://chat.test${path}`, init)),
    electric,
    logs,
    spans,
    line: (message: string) => logs.filter((log) => log.message === message),
    count: (metric: Metric.Metric<number, Metric.CounterState<number>>, attributes: Record<string, string>) =>
      runtime.runSync(
        Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
      ).count,
    snapshot: () => runtime.runSync(Metric.snapshot.pipe(Effect.provideService(Metric.MetricRegistry, registry))),
  }
}

/**
 * A database whose tables aren't there: a real reader of a schema nobody made, so every statement on it fails as
 * Postgres fails it. Read-only, so opening it makes nothing.
 */
const missing = (schema: string) =>
  Layer.unwrap(
    Effect.map(TestDatabase.serverUrl, (server) =>
      PostgresDatabase.layer({ url: server.toString(), driver: Pg, schema, readOnly: true, postgres: { maxConnections: 1 } })),
  ).pipe(Layer.orDie)

/** A response's status and body: a run as the engine reads it, unless refused. */
const json = async (response: Response): Promise<readonly [number, EngineStore.RunInspection.Inspection]> => [
  response.status,
  await response.json(),
]

/** A shape's snapshot, or changes after its last cursor, and the rows those messages install. */
const firstShape = async (
  h: Awaited<ReturnType<typeof routes>>,
  runId: string,
  cursor?: { readonly handle: string; readonly offset: string; readonly rows: ReadonlyArray<Record<string, string>> },
) => {
  const query = new URLSearchParams({ run: runId, offset: cursor?.offset ?? "-1" })
  if (cursor !== undefined) {
    query.set("handle", cursor.handle)
    query.set("live", "true")
  }
  const response = await h.fetch(`${REMOTE_RUN_SHAPE_ROUTE}?${query}`)
  const body = response.status === 200
    ? ((await response.json()) as Array<{ value?: Record<string, string>; headers: { operation?: string } }>)
    : []
  // Electric returns changes, including multiple revisions of a row, rather than a new snapshot at every offset.
  const rows = new Map(cursor?.rows.map((row) => [row.run_id!, row]))
  for (const message of body) {
    if (message.value === undefined) continue
    const id = message.value.run_id!
    if (message.headers.operation === "delete") rows.delete(id)
    else rows.set(id, { ...rows.get(id), ...message.value })
  }
  return {
    status: response.status,
    handle: response.headers.get("electric-handle"),
    offset: response.headers.get("electric-offset"),
    rows: [...rows.values()],
  }
}

/**
 * A `RepoRoles` whose GitHub says `roles` on each repository they name, and the session's role on the deployment's own,
 * octo/hello; no role anywhere else. A test service in place of GitHub (test.faults-by-injection).
 */
const rolesOn = (roles: Readonly<Record<string, Actor.Role | null>>): RepoRoles.RepoRoles => ({
  repository: repositoryOf("octo/hello"),
  resolve: (actor, repository) =>
    Effect.succeed({
      role: repository.id === "github/octo/hello" ? actor.role : roles[repository.id] ?? null,
      held: Option.none(),
    }),
})

describe("a TODO's run on another repository (decision 0079)", () => {
  test("the role there decides watching, following and steering; the deployment's role never does", async () => {
    const start = await attempt("github/acme/widgets")
    const runId = todoExecutionId(start.attemptId)
    await withEngine(async (engine) => {
      await engine.run(runId)
      // The deployment's Member, a Guest on acme/widgets: refused everywhere.
      const outsider = await routes(engine, { actor: member, roles: rolesOn({ "github/acme/widgets": "guest" }) })
      expect((await outsider.fetch(remoteRunRoute(runId))).status).toBe(403)
      expect((await firstShape(outsider, runId)).status).toBe(403)
      const steer = await outsider.fetch(steersRoute(runId), post({ id: uuid(), body: "Use tabs" }))
      expect([steer.status, await steer.json()]).toEqual([403, { code: "forbidden" }])
      // The deployment's Guest, a Member of acme/widgets: reads and follows it; the settled run takes no steer.
      const insider = await routes(engine, { actor: guest, roles: rolesOn({ "github/acme/widgets": "member" }) })
      expect((await insider.fetch(remoteRunRoute(runId))).status).toBe(200)
      expect((await firstShape(insider, runId)).status).toBe(200)
      const settled = await insider.fetch(steersRoute(runId), post({ id: uuid(), body: "Use tabs" }))
      expect([settled.status, await settled.json()]).toEqual([409, { code: "not_working" }])
    })
  })

  test("GitHub not answering is 503 for a TODO's run, never a guessed role", async () => {
    const start = await attempt("github/acme/widgets")
    const runId = todoExecutionId(start.attemptId)
    await withEngine(async (engine) => {
      const h = await routes(engine, { actor: member, roles: {
        repository: repositoryOf("octo/hello"),
        resolve: () => Effect.fail(new RepoRoles.RoleRefused({ code: "github_unavailable" })),
      } })
      expect((await h.fetch(remoteRunRoute(runId))).status).toBe(503)
      expect((await firstShape(h, runId)).status).toBe(503)
      expect((await h.fetch(steersRoute(runId), post({ id: uuid(), body: "Use tabs" }))).status).toBe(503)
    })
  })
})

describe("GET /api/remote-runs/<runId>", () => {
  test("a Member reads a TODO's run as the engine reads it: steps, a page of the journal, values redacted and cut", async () => {
    const start = await attempt()
    const runId = todoExecutionId(start.attemptId)
    await withEngine(async (engine) => {
      await engine.run(runId)
      const h = await routes(engine, { actor: member })
      const response = await h.fetch(remoteRunRoute(runId))
      expect([response.status, response.headers.get("cache-control"), response.headers.get("content-type")]).toEqual([
        200,
        "no-store",
        "application/json",
      ])
      const text = await response.text()
      expect(text).not.toContain(SENTINEL)
      const read = JSON.parse(text) as EngineStore.RunInspection.Inspection
      expect(read.run).toMatchObject({ runId, flowName: "remote-runs-test/Watched", status: "completed", parentRunId: null })
      expect(read.run.input.text).toContain("<redacted>")
      const produced = read.steps.filter((step) => step.action === "remote-runs-test/Produce")
      expect(produced.map((step) => step.output?.clipped)).toEqual([true])
      // The run it started: a summary with its input and result, as the engine reads them, the result cut.
      expect(read.children.map((child) => [child.flowName, child.status, child.result?.clipped])).toEqual([
        ["remote-runs-test/Child", "completed", true],
      ])
      expect(read.journal.hasMore).toBe(false)
      expect(read.run.lastSeq).toBe(read.journal.events.at(-1)!.seq)

      // Paged: the first two events, then the rest after them.
      const [, first] = await json(await h.fetch(`${remoteRunRoute(runId)}?limit=2`))
      expect([first.journal.events.length, first.journal.hasMore]).toEqual([2, true])
      const [, rest] = await json(await h.fetch(`${remoteRunRoute(runId)}?afterSeq=${first.journal.nextSeq}&limit=500`))
      expect([...first.journal.events, ...rest.journal.events].map((event) => event.seq)).toEqual(
        read.journal.events.map((event) => event.seq),
      )

      // One record per read, with sizes and the outcome: never a value.
      const lines = h.line("run.inspect").map((line) => line.annotations)
      expect(lines).toHaveLength(3)
      // Every value the read cut: the long step's output and attempt, the child's result, and the events carrying them.
      const cut = text.split(`"clipped":true`).length - 1
      expect(cut).toBeGreaterThanOrEqual(3)
      expect(lines[0]).toMatchObject({ host: "remote", outcome: "read", runId, status: 200, clipped: cut })
      expect(lines[0]!.events).toBe(read.journal.events.length)
      expect(lines[0]!.bytes).toBe(new TextEncoder().encode(text).length)
      expect(h.count(RemoteRuns.reads, { outcome: "read" })).toBe(3)
      expect(h.spans.filter((span) => span.name === "run.inspect")).toHaveLength(3)
      expect(recorded(h)).not.toContain(SENTINEL)
      expect(recorded(h)).not.toContain("xxxxxxxx")
    })
  })

  test("a TODO's failed step carries its log lines, attributed to its attempts, with a credential it logged redacted", async () => {
    const start = await attempt()
    const runId = todoExecutionId(start.attemptId)
    await withEngine(async (engine) => {
      await engine.check(runId)
      expect(await engine.status(runId)).toBe("failed")
      const h = await routes(engine, { actor: member })
      type Read = { readonly text: string; readonly read: EngineStore.RunInspection.Inspection }
      const read = async (): Promise<Read> => {
        const response = await h.fetch(remoteRunRoute(runId))
        const text = await response.text()
        return { text, read: JSON.parse(text) as EngineStore.RunInspection.Inspection }
      }
      const logsOf = ({ read }: Read) =>
        read.journal.events
          .filter((event) => event.eventType === Journal.TelemetryLog.eventType)
          .map((event) => JSON.parse(event.payload.text) as Journal.TelemetryLog.Log)
      // The lossy channel commits after the step settles, so the read is retried until its last record is in.
      let last: Read = await read()
      await eventually(async () => {
        last = await read()
        return logsOf(last).length === 8
      }, 10_000)
      expect(last.text).not.toContain(SENTINEL)
      const step = last.read.steps.find((candidate) => candidate.action === "remote-runs-test/Check")!
      expect([step.status, step.attempts.map((recorded) => recorded.state)]).toEqual(["failed", ["failed", "failed"]])
      // Joined as the run page joins them: by the digests the step's node settled with.
      const settled = last.read.journal.events
        .filter((event) => event.eventType === "flows.engine.node-settled")
        .map((event) => JSON.parse(event.payload.text) as { nodeId: string; stepKeyDigests?: ReadonlyArray<string> })
        .find((node) => node.nodeId === step.nodeId)!
      const lines = logsOf(last).filter((log) =>
        log.annotations.runId === runId && settled.stepKeyDigests!.includes(log.annotations.stepKeyDigest as string)
      )
      expect(lines.map((log) => [log.annotations.attempt, log.level, log.message])).toEqual([1, 2].flatMap((tried) => [
        [tried, "Info", ["running checks", { suite: "unit" }]],
        [tried, "Info", ["token", "<redacted>"]],
        [tried, "Info", ["Authorization: Bearer [REDACTED_TOKEN]"]],
        [tried, "Warn", ["checks failed"]],
      ]))
      expect(lines[1]!.annotations.apiKey).toBe("[REDACTED]")
      expect(lines[3]!.annotations).toMatchObject({ code: "checks_failed", failures: 2 })
      expect(recorded(h)).not.toContain(SENTINEL)
    })
  })

  test("refuses who may not read it, a bad page, a run no TODO started and one the engine hasn't begun", async () => {
    const start = await attempt()
    const runId = todoExecutionId(start.attemptId)
    await withEngine(async (engine) => {
      const cases: ReadonlyArray<[Parameters<typeof routes>[1], string, number, string]> = [
        [{}, remoteRunRoute(runId), 401, "authentication"],
        [{ actor: guest }, remoteRunRoute(runId), 403, "forbidden"],
        [{ actor: member }, `${remoteRunRoute(runId)}?afterSeq=-2`, 400, "invalid"],
        [{ actor: member }, `${remoteRunRoute(runId)}?afterSeq=one`, 400, "invalid"],
        [{ actor: member }, `${remoteRunRoute(runId)}?limit=0`, 400, "invalid"],
        [{ actor: member }, `${remoteRunRoute(runId)}?limit=501`, 400, "invalid"],
        [{ actor: member }, `${remoteRunRoute(runId)}?limit=1.5`, 400, "invalid"],
        [{ actor: member }, remoteRunRoute(todoExecutionId(uuid())), 404, "not_found"],
        [{ actor: member }, remoteRunRoute("chat-expire-1"), 404, "not_found"],
        // Recorded by the writer, and not yet begun by the engine.
        [{ actor: member }, remoteRunRoute(runId), 404, "not_started"],
      ]
      for (const [options, path, status, code] of cases) {
        const h = await routes(engine, options)
        const response = await h.fetch(path)
        expect([path, response.status, await response.json(), response.headers.get("cache-control")]).toEqual([
          path,
          status,
          { code },
          "no-store",
        ])
        expect(h.line("run.inspect").map((line) => line.annotations.outcome)).toEqual([code])
        expect(h.count(RemoteRuns.reads, { outcome: code })).toBe(1)
      }
      const h = await routes(engine, { actor: member })
      expect((await h.fetch(remoteRunRoute(runId), { method: "POST" })).status).toBe(405)
      expect(h.line("run.inspect").map((line) => line.annotations.outcome)).toEqual(["method"])
    })
  })

  test("answers 503 when sessions, the app's database or the engine can't, and the device asks again", async () => {
    const start = await attempt()
    const runId = todoExecutionId(start.attemptId)
    const sessionsDown = Layer.succeed(Actor.Sessions, Actor.Sessions.of({ resolve: Effect.fail(new Actor.SessionsUnavailable()) }))
    await withEngine(async (engine) => {
      await engine.run(runId)
      const cases: ReadonlyArray<[Awaited<ReturnType<typeof routes>>, string | undefined]> = [
        [await routes(engine, { sessions: sessionsDown }), undefined],
        [await routes(engine, { actor: member, database: missing("remote_runs_no_app") }), "sql:"],
        [
          await routes({ schema: engine.schema, database: missing("remote_runs_no_engine"), writer: engine.writer }, {
            actor: member,
          }),
          "@smthrs/",
        ],
      ]
      for (const [h, errorCode] of cases) {
        const response = await h.fetch(remoteRunRoute(runId))
        expect([response.status, await response.json(), response.headers.get("retry-after")]).toEqual([
          503,
          { code: "unavailable" },
          "5",
        ])
        const line = h.line("run.inspect")[0]!.annotations
        expect(line.outcome).toBe("unavailable")
        if (errorCode !== undefined) expect(String(line.errorCode)).toContain(errorCode)
      }
    })
  })
})

describe("GET /api/shapes/remote-runs", () => {
  test("a Member follows the run's row of the engine's change feed: its id and revision, from the engine's schema", async () => {
    const start = await attempt()
    const runId = todoExecutionId(start.attemptId)
    await withEngine(async (engine) => {
      await engine.run(runId)
      const h = await routes(engine, { actor: member })
      const first = await firstShape(h, runId)
      expect(first.status).toBe(200)
      expect(first.rows).toEqual([{ run_id: runId, revision: expect.any(String) }])
      expect(Object.fromEntries(h.electric[0]!.searchParams)).toMatchObject({
        table: `${engine.schema}.flows_run_changes`,
        where: "run_id = $1",
        "params[1]": runId,
        columns: "run_id,revision",
      })
      expect(h.count(RemoteRuns.shapeRequests, { status: "200", live: "false" })).toBe(1)
    })
  })

  test("the row moves while the run works: a live request answers when the run's next step begins", async () => {
    const start = await attempt()
    const runId = todoExecutionId(start.attemptId)
    await withEngine(async (engine) => {
      const h = await routes(engine, { actor: member })
      // Started, then held in its first step until the shape has its row: the run can't finish before it is followed.
      let release = () => {}
      let entered = () => {}
      const stepEntered = new Promise<void>((resolve) => (entered = resolve))
      producing = { wait: new Promise<void>((resolve) => (release = resolve)), entered }
      let first: Awaited<ReturnType<typeof firstShape>>
      try {
        first = await firstShape(h, runId)
        expect(first.status).toBe(200)
        expect(first.rows).toEqual([])
        await engine.start(runId, 0)
        await stepEntered
        await eventually(async () => {
          // The original snapshot can be empty forever. Consume its cursor to see the later insertion.
          first = await firstShape(h, runId, { handle: first.handle!, offset: first.offset!, rows: first.rows })
          return first.rows.length === 1
        }, 10_000)
        expect(first.status).toBe(200)
        expect(first.rows).toEqual([{ run_id: runId, revision: expect.any(String) }])
      } finally {
        producing = undefined
        release()
      }
      const before = Number(first.rows[0]!.revision)
      // Follow it live until the revision moves on.
      let offset = first.offset!
      let moved: number | undefined
      for (let request = 0; request < 20 && moved === undefined; request++) {
        const response = await h.fetch(
          `${REMOTE_RUN_SHAPE_ROUTE}?run=${encodeURIComponent(runId)}&offset=${offset}&handle=${first.handle}&live=true`,
        )
        offset = response.headers.get("electric-offset") ?? offset
        const messages = (await response.json()) as Array<{ value?: { revision?: string } }>
        const revision = messages.find((message) => message.value?.revision !== undefined)?.value?.revision
        if (revision !== undefined && Number(revision) > before) moved = Number(revision)
      }
      expect(moved).toBeGreaterThan(before)
    })
  }, 60_000)

  test("refuses who may not follow it, and a run no TODO started", async () => {
    const start = await attempt()
    const runId = todoExecutionId(start.attemptId)
    const sessionsDown = Layer.succeed(Actor.Sessions, Actor.Sessions.of({ resolve: Effect.fail(new Actor.SessionsUnavailable()) }))
    await withEngine(async (engine) => {
      const cases: ReadonlyArray<[Parameters<typeof routes>[1], string, number]> = [
        [{}, runId, 401],
        [{ actor: guest }, runId, 403],
        [{ sessions: sessionsDown }, runId, 503],
        [{ actor: member }, todoExecutionId(uuid()), 403],
        [{ actor: member }, "chat-expire-1", 403],
      ]
      for (const [options, run, status] of cases) {
        const h = await routes(engine, options)
        expect([run, (await firstShape(h, run)).status]).toEqual([run, status])
        expect(h.electric).toEqual([])
      }
      // A request that names no run follows none.
      const none = await routes(engine, { actor: member })
      expect((await none.fetch(`${REMOTE_RUN_SHAPE_ROUTE}?offset=-1`)).status).toBe(403)
      expect(none.electric).toEqual([])
      // The app's tables can't be read: whose run it is can't be told, so the device keeps its rows and asks again.
      const h = await routes(engine, { actor: member, database: missing("remote_runs_no_app") })
      expect((await firstShape(h, runId)).status).toBe(503)
      expect(h.electric).toEqual([])
    })
  })
})

/** A queue over the engine's journal, as the run's agent and the route reach it. */
const queueOver = (engine: Pick<Engine, "writer">) =>
  NotificationQueue.layer.pipe(
    Layer.provide(Journal.SqlJournal.layer({ capacity: 1024, overflow: "reject" })),
    Layer.provide(Layer.provideMerge(Database.DurableWriter.layer(), engine.writer)),
  )

/** What a run holds undelivered. */
const pendingOf = (engine: Pick<Engine, "writer">, runId: string) =>
  Effect.runPromise(
    Effect.flatMap(NotificationQueue.NotificationQueue, (queue) => queue.pending(runId)).pipe(
      Effect.provide(queueOver(engine)),
      Effect.scoped,
    ),
  )

const STEER_SENTINEL = "sentinel-steer-9c1d-never-recorded"

/** A steer's request. */
const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
})

describe("POST /api/remote-runs/<runId>/steers", () => {
  test("a Member's message joins the working run's queue once, as their steer; a resend answers what it answered", async () => {
    const start = await attempt()
    const runId = todoExecutionId(start.attemptId)
    await withEngine(async (engine) => {
      await engine.start(runId, 60_000)
      await eventually(async () => (await engine.status(runId)) === "suspended" || (await engine.status(runId)) === "running", 10_000)
      const h = await routes(engine, { actor: member })
      const id = uuid()
      const body = `Also add a line ${STEER_SENTINEL}`
      const taken = await h.fetch(steersRoute(runId), post({ id, body }))
      const receipt = (await taken.json()) as { id: string; seq: number }
      expect([taken.status, taken.headers.get("cache-control"), receipt.id]).toEqual([202, "no-store", id])
      expect(receipt.seq).toBeGreaterThanOrEqual(0)
      // The same message again, as an outbox resends it: the same receipt, and still one message.
      const again = await h.fetch(steersRoute(runId), post({ id: id.toUpperCase(), body }))
      expect([again.status, await again.json()]).toEqual([200, receipt])
      // Another message under the same id is a conflict, and changes nothing.
      const other = await h.fetch(steersRoute(runId), post({ id, body: "Something else" }))
      expect([other.status, await other.json()]).toEqual([409, { code: "conflict" }])

      const pending = await pendingOf(engine, runId)
      expect(pending).toEqual([
        {
          _tag: "human-steer",
          id,
          delivery: "steer",
          targetLineageId: runId,
          provenance: {
            sourceRunId: runId,
            sourceLineageId: runId,
            sourceTurn: 0,
            sourceActor: `person:${member.subject.id}`,
            attribution: { login: "maya", via: "person" },
          },
          payload: { kind: "Message", body },
        },
      ])
      // Ids, outcomes and sizes only: never the message.
      const lines = h.line("run.steer").map((line) => line.annotations)
      expect(lines.map((line) => [line.outcome, line.status])).toEqual([["taken", 202], ["existing", 200], ["conflict", 409]])
      expect(lines[0]).toMatchObject({ host: "remote", runId, steerId: id, via: "person" })
      expect(h.count(RemoteRuns.steers, { outcome: "taken" })).toBe(1)
      expect(h.spans.filter((span) => span.name === "run.steer")).toHaveLength(3)
      expect(recorded(h)).not.toContain(STEER_SENTINEL)
    })
  }, 60_000)

  test("a steer waiting for its writer refuses a run that ends before admission", async () => {
    const runId = todoExecutionId((await attempt()).attemptId)
    await withEngine(async (engine) => {
      await engine.start(runId, 60_000)
      await eventually(async () => (await engine.status(runId)) === "suspended", 10_000)
      let entered!: () => void
      let release!: () => void
      const waiting = new Promise<void>((resolve) => { entered = resolve })
      const go = new Promise<void>((resolve) => { release = resolve })
      const writer = Layer.unwrap(Effect.promise(async () => {
        entered()
        await go
        return engine.writer
      }))
      const h = await routes({ ...engine, writer }, { actor: member })
      const pending = h.fetch(steersRoute(runId), post({ id: uuid(), body: "Too late" }))
      try {
        await waiting
        await engine.cancel(runId)
        await eventually(async () => (await engine.status(runId)) === "cancelled", 10_000)
      } finally {
        release()
      }
      const response = await pending
      expect([response.status, await response.json()]).toEqual([409, { code: "not_working" }])
      expect(await pendingOf(engine, runId)).toEqual([])
    })
  }, 60_000)

  test("an admitted steer retains its receipt after completion", async () => {
    const runId = todoExecutionId((await attempt()).attemptId)
    await withEngine(async (engine) => {
      await engine.start(runId, 60_000)
      await eventually(async () => (await engine.status(runId)) === "suspended", 10_000)
      const h = await routes(engine, { actor: member })
      const message = { id: uuid(), body: "Keep this receipt" }
      const taken = await h.fetch(steersRoute(runId), post(message))
      expect(taken.status).toBe(202)
      const receipt = await taken.json()
      await engine.cancel(runId)
      await eventually(async () => (await engine.status(runId)) === "cancelled", 10_000)
      const again = await h.fetch(steersRoute(runId), post(message))
      expect([again.status, await again.json()]).toEqual([200, receipt])
    })
  }, 60_000)

  test("an agent acting for a Member steers too, and the run's model reads that it came through an agent", async () => {
    const start = await attempt()
    const runId = todoExecutionId(start.attemptId)
    await withEngine(async (engine) => {
      await engine.start(runId, 60_000)
      await eventually(async () => (await engine.status(runId)) !== undefined, 10_000)
      const h = await routes(engine, { actor: { ...member, act: { kind: "agent", id: "chat-run-1" } } })
      const id = uuid()
      expect((await h.fetch(steersRoute(runId), post({ id, body: "Keep it short" }))).status).toBe(202)
      expect((await pendingOf(engine, runId))[0]!.provenance.attribution).toEqual({ login: "maya", via: "agent" })
      expect(h.line("run.steer")[0]!.annotations.via).toBe("agent")
    })
  }, 60_000)

  test("refuses who may not steer, a bad message, a run no TODO started, and a run with no agent left to steer", async () => {
    const first = await attempt()
    const runId = todoExecutionId(first.attemptId)
    await withEngine(async (engine) => {
      const body = { id: uuid(), body: "Use tabs" }
      // Recorded by the writer and not begun by the engine: nothing reads a queue yet.
      const cases: ReadonlyArray<[Parameters<typeof routes>[1], string, RequestInit, number, string]> = [
        [{}, runId, post(body), 401, "authentication"],
        [{ actor: guest }, runId, post(body), 403, "forbidden"],
        [{ actor: member }, runId, post("{"), 400, "invalid"],
        [{ actor: member }, runId, { method: "POST", body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) }, 400, "invalid"],
        [{ actor: member }, runId, post({ id: "not-a-uuid", body: "x" }), 400, "invalid"],
        [{ actor: member }, runId, post({ id: uuid(), body: " \n " }), 400, "invalid"],
        [{ actor: member }, runId, post({ id: uuid(), body: "x".repeat(MAX_STEER_CHARS + 1) }), 413, "too_large"],
        // Few enough characters, but each escapes to six bytes: its record would pass the engine's cut of a value.
        [{ actor: member }, runId, post({ id: uuid(), body: "\u0001".repeat(MAX_STEER_CHARS) }), 413, "too_large"],
        [{ actor: member }, runId, post({ id: uuid(), body: "x".repeat(40_000) }), 413, "too_large"],
        [{ actor: member }, todoExecutionId(uuid()), post(body), 404, "not_found"],
        // A repository's run has no agent to steer.
        [{ actor: member }, `ci:${uuid()}`, post(body), 404, "not_found"],
        [{ actor: member }, runId, post(body), 409, "not_working"],
      ]
      for (const [options, target, init, status, code] of cases) {
        const h = await routes(engine, options)
        const response = await h.fetch(steersRoute(target), init)
        expect([code, response.status, await response.json(), response.headers.get("cache-control")]).toEqual([
          code,
          status,
          { code },
          "no-store",
        ])
        expect(h.line("run.steer").map((line) => line.annotations.outcome)).toEqual([code])
        expect(h.count(RemoteRuns.steers, { outcome: code })).toBe(1)
      }
      const h = await routes(engine, { actor: member })
      expect((await h.fetch(steersRoute(runId))).status).toBe(405)
      expect(h.line("run.steer").map((line) => line.annotations.outcome)).toEqual(["method"])

      // Settled: nothing will read the queue again.
      await engine.run(runId)
      expect((await h.fetch(steersRoute(runId), post(body))).status).toBe(409)
      // Working, but its agent's step has ended: the message would never be read.
      // Another stack's TODO: one stack runs one TODO at a time.
      const second = todoExecutionId((await attempt("github/octo/other")).attemptId)
      await engine.review(second, 60_000)
      await eventually(async () => (await engine.status(second)) === "suspended", 10_000)
      // A Member of octo/other too, whose role there decides (decision 0079).
      const other = await routes(engine, { actor: member, roles: rolesOn({ "github/octo/other": "member" }) })
      const late = await other.fetch(steersRoute(second), post({ id: uuid(), body: "Too late" }))
      expect([late.status, await late.json()]).toEqual([409, { code: "not_working" }])
      expect(await pendingOf(engine, second)).toEqual([])
    })
  }, 60_000)

  test("a run holding 128 undelivered messages refuses the next one as full, keeping nothing", async () => {
    const start = await attempt()
    const runId = todoExecutionId(start.attemptId)
    await withEngine(async (engine) => {
      await engine.start(runId, 60_000)
      await eventually(async () => (await engine.status(runId)) !== undefined, 10_000)
      // 127 messages already wait, admitted through the run's queue as the route admits them; the route takes the 128th.
      await Effect.runPromise(
        Effect.flatMap(NotificationQueue.NotificationQueue, (queue) =>
          Effect.forEach(Array.from({ length: 127 }, (_, n) => n), (n) =>
            queue.admit(runId, Notification.humanSteer({
              runId,
              id: uuid(),
              actor: `person:${member.subject.id}`,
              payload: { kind: "Message", body: `message ${n}` },
            })))).pipe(Effect.provide(queueOver(engine)), Effect.scoped),
      )
      const h = await routes(engine, { actor: member })
      expect((await h.fetch(steersRoute(runId), post({ id: uuid(), body: "the 128th" }))).status).toBe(202)
      const full = await h.fetch(steersRoute(runId), post({ id: uuid(), body: "one more" }))
      expect([full.status, await full.json()]).toEqual([429, { code: "full" }])
      expect(await pendingOf(engine, runId)).toHaveLength(128)
    })
  }, 120_000)

  test("answers 503 when sessions, the app's database or the engine can't", async () => {
    const start = await attempt()
    const runId = todoExecutionId(start.attemptId)
    const server = await Effect.runPromise(TestDatabase.serverUrl)
    const empty = `remote_runs_no_journal_${crypto.randomUUID().replaceAll("-", "")}`
    const noJournal = PostgresDatabase.layer({ url: server.toString(), driver: Pg, schema: empty, postgres: { maxConnections: 1 } })
      .pipe(Layer.orDie)
    const sessionsDown = Layer.succeed(Actor.Sessions, Actor.Sessions.of({ resolve: Effect.fail(new Actor.SessionsUnavailable()) }))
    await withEngine(async (engine) => {
      await engine.start(runId, 60_000)
      await eventually(async () => (await engine.status(runId)) !== undefined, 10_000)
      const cases: ReadonlyArray<[Awaited<ReturnType<typeof routes>>, string | undefined]> = [
        [await routes(engine, { sessions: sessionsDown }), undefined],
        [await routes(engine, { actor: member, database: missing("remote_runs_no_app") }), "sql:"],
        [
          await routes({ schema: engine.schema, database: engine.database, writer: missing("remote_runs_no_writer") }, {
            actor: member,
          }),
          undefined,
        ],
        // A writer whose schema has no journal: the queue can't be read, and says so as a code.
        [
          await routes({ schema: engine.schema, database: engine.database, writer: noJournal }, { actor: member }),
          "@smthrs/journal",
        ],
      ]
      for (const [h, errorCode] of cases) {
        const response = await h.fetch(steersRoute(runId), post({ id: uuid(), body: "Use tabs" }))
        expect([response.status, await response.json(), response.headers.get("retry-after")]).toEqual([
          503,
          { code: "unavailable" },
          "5",
        ])
        const line = h.line("run.steer")[0]!.annotations
        expect(line.outcome).toBe("unavailable")
        if (errorCode !== undefined) expect(String(line.errorCode)).toContain(errorCode)
      }
    })
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(`DROP SCHEMA IF EXISTS ${empty} CASCADE`)))
  }, 60_000)
})

/** A repository's run recorded under `execution`, as a trigger or a person's Run records it. */
const recordRepoRun = (execution: string) =>
  runtime.runPromise(RepoRuns.record({
    execution,
    repoId: "github/octo/hello",
    flow: "ci",
    sha: "b".repeat(40),
    ref: "main",
    event: "push",
    launchedBy: "github",
  }))

describe("a repository's run", () => {
  test("a Member reads it and the runs it started, and follows each; a run no repository recorded stays refused", async () => {
    const runId = `ci:${uuid()}`
    await recordRepoRun(runId)
    await withEngine(async (engine) => {
      await engine.run(runId)
      await engine.run(`unrecorded:${uuid()}`)
      const [job] = await engine.children(runId)
      const h = await routes(engine, { actor: member })
      const [status, read] = await json(await h.fetch(remoteRunRoute(runId)))
      expect([status, read.run.runId, read.run.status, read.children.map((child) => child.runId)]).toEqual([
        200,
        runId,
        "completed",
        [job],
      ])
      const [childStatus, child] = await json(await h.fetch(remoteRunRoute(job!)))
      expect([childStatus, child.run.parentRunId]).toEqual([200, runId])
      expect((await firstShape(h, job!)).rows).toEqual([{ run_id: job, revision: expect.any(String) }])
      expect((await firstShape(h, runId)).status).toBe(200)

      expect((await h.fetch(remoteRunRoute(`ci:${uuid()}`))).status).toBe(404)
      expect((await firstShape(h, `ci:${uuid()}`)).status).toBe(403)
      const guest_ = await routes(engine, { actor: guest })
      expect((await guest_.fetch(remoteRunRoute(runId))).status).toBe(403)
      expect(recorded(h)).not.toContain(SENTINEL)
    })
  })

  test("another repository's run is unavailable when repository roles are not configured", async () => {
    const runId = `ci:${uuid()}`
    await runtime.runPromise(RepoRuns.record({
      execution: runId,
      repoId: "github/octo/private",
      flow: "ci",
      sha: "e".repeat(40),
      ref: "main",
      event: "push",
      launchedBy: "github",
    }))
    await withEngine(async (engine) => {
      await engine.run(runId)
      const h = await routes(engine, { actor: member, stop: () => Effect.die("never asked") })
      expect([(await h.fetch(remoteRunRoute(runId))).status, (await firstShape(h, runId)).status]).toEqual([503, 503])
      const stopped = await h.fetch(stopRoute(runId), { method: "POST" })
      expect([stopped.status, await stopped.json()]).toEqual([503, { code: "unavailable" }])
    })
  })

  test.each(["unavailable", "rate_limited", "app_not_installed"] as const)("a repository role refusal %s fails closed for inspection, following and Stop", async (code) => {
    const runId = `ci:${uuid()}`
    await recordRepoRun(runId)
    await withEngine(async (engine) => {
      await engine.run(runId)
      const h = await routes(engine, { actor: member, roles: {
        repository: repositoryOf("octo/hello"),
        resolve: () => Effect.fail(new RepoRoles.RoleRefused({ code })),
      }, stop: () => Effect.die("never asked") })
      const status = code === "app_not_installed" ? 404 : 503
      expect((await h.fetch(remoteRunRoute(runId))).status).toBe(status)
      expect((await firstShape(h, runId)).status).toBe(code === "app_not_installed" ? 403 : 503)
      expect((await h.fetch(stopRoute(runId), { method: "POST" })).status).toBe(status)
    })
  })

  test("a repository's flow named todo is the repository's run, not a TODO's", async () => {
    const runId = `todo:${uuid()}`
    await recordRepoRun(runId)
    await withEngine(async (engine) => {
      await engine.run(runId)
      const h = await routes(engine, { actor: member })
      expect((await h.fetch(remoteRunRoute(runId))).status).toBe(200)
      expect((await firstShape(h, runId)).status).toBe(200)
    })
  })

  test("a recorded run the engine hasn't begun reads not_started", async () => {
    const runId = `ci:${uuid()}`
    await recordRepoRun(runId)
    await withEngine(async (engine) => {
      const h = await routes(engine, { actor: member })
      const response = await h.fetch(remoteRunRoute(runId))
      expect([response.status, await response.json()]).toEqual([404, { code: "not_started" }])
    })
  })
})

describe("POST /api/remote-runs/<runId>/stop", () => {
  test("a Member stops a working run on its object, once it is recorded; the engine settles it cancelled", async () => {
    const runId = `ci:${uuid()}`
    await recordRepoRun(runId)
    await withEngine(async (engine) => {
      await engine.start(runId, 60_000)
      await eventually(async () => (await engine.status(runId)) === "suspended", 10_000)
      const asked: Array<string> = []
      const h = await routes(engine, {
        actor: member,
        // What the object does (worker/ExecutionHost.ts `cancel`): the engine's own interrupt of the run.
        stop: (id) =>
          Effect.promise(async () => {
            asked.push(id)
            await engine.cancel(id)
          }),
      })
      const response = await h.fetch(stopRoute(runId), { method: "POST" })
      expect([response.status, await response.json(), response.headers.get("cache-control")]).toEqual([
        202,
        { outcome: "requested" },
        "no-store",
      ])
      expect(asked).toEqual([runId])
      await eventually(async () => (await engine.status(runId)) === "cancelled", 10_000)
      expect(h.line("run.stop").map((line) => line.annotations)).toEqual([
        expect.objectContaining({ host: "remote", runId, via: "person", outcome: "requested", status: 202 }),
      ])
      expect(h.count(RemoteRuns.stops, { outcome: "requested" })).toBe(1)
      expect(h.spans.filter((span) => span.name === "run.stop")).toHaveLength(1)
    })
  })

  test("an agent acting for a Member stops one too; a run that ended answers settled, and its object is never asked", async () => {
    const runId = `ci:${uuid()}`
    await recordRepoRun(runId)
    await withEngine(async (engine) => {
      const unbegun = `ci:${uuid()}`
      await recordRepoRun(unbegun)
      const asked: Array<string> = []
      const h = await routes(engine, {
        actor: { ...member, act: { kind: "agent", id: "chat-run-1" } },
        stop: (id) => Effect.sync(() => void asked.push(id)),
      })
      // Recorded and not begun: its object stops it before it starts.
      expect(await json(await h.fetch(stopRoute(unbegun), { method: "POST" }))).toEqual([202, { outcome: "requested" }])
      await engine.run(runId)
      const response = await h.fetch(stopRoute(runId), { method: "POST" })
      expect([response.status, await response.json()]).toEqual([200, { outcome: "settled" }])
      expect(asked).toEqual([unbegun])
      expect(h.line("run.stop").map((line) => [line.annotations.via, line.annotations.outcome])).toEqual([
        ["agent", "requested"],
        ["agent", "settled"],
      ])
    })
  })

  test("refuses who may not stop it, a job, a run no repository recorded, and an object that couldn't take it", async () => {
    const runId = `ci:${uuid()}`
    await recordRepoRun(runId)
    const down = `ci:${uuid()}`
    await recordRepoRun(down)
    const sessionsDown = Layer.succeed(Actor.Sessions, Actor.Sessions.of({ resolve: Effect.fail(new Actor.SessionsUnavailable()) }))
    await withEngine(async (engine) => {
      await engine.run(runId)
      const [job] = await engine.children(runId)
      const cases: ReadonlyArray<[Parameters<typeof routes>[1], string, number, string]> = [
        [{}, runId, 401, "authentication"],
        [{ actor: guest }, runId, 403, "forbidden"],
        [{ sessions: sessionsDown }, runId, 503, "unavailable"],
        [{ actor: member }, job!, 404, "not_found"],
        [{ actor: member }, `ci:${uuid()}`, 404, "not_found"],
        [{ actor: member, stop: () => Effect.fail("object down") }, down, 503, "unavailable"],
        [{ actor: member, database: missing("remote_runs_no_app_stop") }, runId, 503, "unavailable"],
      ]
      for (const [options, id, status, code] of cases) {
        const h = await routes(engine, options)
        const response = await h.fetch(stopRoute(id), { method: "POST" })
        expect([id === job ? "job" : id, response.status, await response.json()]).toEqual([
          id === job ? "job" : id,
          status,
          { code },
        ])
        expect(response.headers.get("retry-after")).toBe(status === 503 ? "5" : null)
        expect(h.line("run.stop").map((line) => line.annotations.outcome)).toEqual([code])
      }
      const h = await routes(engine, { actor: member })
      expect((await h.fetch(stopRoute(runId))).status).toBe(405)
      expect(h.line("run.stop").map((line) => line.annotations.outcome)).toEqual(["method"])
    })
  })
})

const admin: Actor.Actor = { subject: { kind: "person", id: "person-admin" }, role: "admin", login: "ada" }

/** A run the deployment itself started, as the engine keeps its row: never begun, `pending`. */
const keptRun = (engine: Pick<Engine, "writer">, runId: string, flowName: string, createdAtMs: number) =>
  Effect.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
      VALUES (${runId}, 'pending', ${createdAtMs}, ${JSON.stringify({ version: 1, flowName, payload: {} })})`).pipe(
    Effect.provide(engine.writer),
  ))

type Listed = { readonly runs: ReadonlyArray<Record<string, unknown>> }

/** The list route's answer: its status and body. */
const listed = async (h: Awaited<ReturnType<typeof routes>>, query = "") => {
  const response = await h.fetch(`${CLOUD_RUNS_ROUTE}${query}`)
  return [response.status, await response.json() as Listed, response] as const
}

describe("GET /api/cloud-runs", () => {
  test("a Member lists TODO runs and the repository's runs with the engine's state; an Admin also the system flows", async () => {
    const begun = await attempt()
    // A second TODO on another repository's stack, so its attempt starts at once rather than waiting its turn.
    const waiting = await attempt("github/octo/second")
    // As a TODO's second attempt records it: a retry.
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`UPDATE todo_attempts SET ordinal = 2 WHERE id = ${waiting.attemptId}::uuid`))
    const repoRun = `ci:${uuid()}`
    await recordRepoRun(repoRun)
    await withEngine(async (engine) => {
      await engine.run(todoExecutionId(begun.attemptId))
      await engine.run(repoRun)
      await keptRun(engine, `ops-spend-${uuid()}`, "ops/SpendAlert", Date.now() + 60_000)
      await keptRun(engine, `chat-expire-${uuid()}`, "chat/Expire", Date.now() + 120_000)
      const h = await routes(engine, { actor: member })
      const [status, body, response] = await listed(h)
      expect([status, response.headers.get("cache-control")]).toEqual([200, "no-store"])
      const byId = new Map(body.runs.map((run) => [run.runId, run]))
      expect(byId.get(todoExecutionId(begun.attemptId))).toMatchObject({
        flow: "todo", kind: "todo", status: "completed", trigger: "commit", branch: null, actor: "maya", repo: "octo/hello",
        cancelRequested: false, startedAtMs: expect.any(Number), finishedAtMs: expect.any(Number),
      })
      // The engine hasn't begun the second attempt's run: what its TODO recorded, pending.
      expect(byId.get(todoExecutionId(waiting.attemptId))).toMatchObject({
        kind: "todo", status: "pending", trigger: "retry", repo: "octo/second", startedAtMs: null, finishedAtMs: null,
        createdAtMs: expect.any(Number),
      })
      expect(byId.get(repoRun)).toMatchObject({
        flow: "ci", kind: "repo", status: "completed", trigger: "push", branch: "main", actor: "github", repo: "octo/hello",
      })
      // Newest first, and no system flow for a Member.
      expect(body.runs.map((run) => run.createdAtMs)).toEqual(
        [...body.runs.map((run) => run.createdAtMs as number)].sort((left, right) => right - left),
      )
      expect(body.runs.map((run) => run.kind)).not.toContain("system")
      expect(h.line("runs.cloud.list")[0]).toMatchObject({
        annotations: { outcome: "read", runs: 3, todo: 2, repo: 1, system: 0, status: 200 },
      })
      expect(h.count(CloudRuns.lists, { outcome: "read" })).toBe(1)

      const a = await routes(engine, { actor: admin })
      const [, all] = await listed(a)
      const system = all.runs.filter((run) => run.kind === "system")
      // A system flow is listed by its declaration; a conversation's never.
      expect(system).toEqual([expect.objectContaining({
        flow: "ops/SpendAlert", status: "pending", trigger: "system", branch: null, actor: null, repo: null,
      })])
      expect(all.runs[0]!.flow).toBe("ops/SpendAlert")
      expect(all.runs.some((run) => run.flow === "chat/Expire")).toBe(false)
      // At most `limit`, newest first.
      const [, one] = await listed(a, "?limit=1")
      expect(one.runs.map((run) => run.flow)).toEqual(["ops/SpendAlert"])
      expect(recorded(a)).not.toContain("maya")
    })
  })

  test("a TODO whose work failed reads failed though its engine completed", async () => {
    const start = await attempt()
    const runId = todoExecutionId(start.attemptId)
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`UPDATE todo_attempts SET status = 'failed' WHERE id = ${start.attemptId}::uuid`))
    await withEngine(async (engine) => {
      await engine.run(runId)
      const [, body] = await listed(await routes(engine, { actor: member }))
      expect(body.runs.find((run) => run.runId === runId)).toMatchObject({ status: "failed" })
    })
  })

  test("an Admin reads a system flow's run page; a Member, and any flow the list never shows, stay refused", async () => {
    const spend = `ops-spend-${uuid()}`
    const expire = `chat-expire-${uuid()}`
    await withEngine(async (engine) => {
      await keptRun(engine, spend, "ops/SpendAlert", Date.now())
      await keptRun(engine, expire, "chat/Expire", Date.now())
      const a = await routes(engine, { actor: admin })
      const [status, read] = await json(await a.fetch(remoteRunRoute(spend)))
      expect([status, read.run.flowName, read.run.status]).toEqual([200, "ops/SpendAlert", "pending"])
      expect((await firstShape(a, spend)).status).toBe(200)
      expect((await a.fetch(remoteRunRoute(expire))).status).toBe(404)
      // A system run is never stopped from here: only a repository's run stops.
      expect((await a.fetch(stopRoute(spend), { method: "POST" })).status).toBe(404)
      const m = await routes(engine, { actor: member })
      expect((await m.fetch(remoteRunRoute(spend))).status).toBe(404)
      expect((await (await routes(engine, { actor: guest })).fetch(remoteRunRoute(spend))).status).toBe(403)
      expect((await firstShape(m, spend)).status).toBe(403)
    })
  })

  test("a repository whose role can't be read now leaves its runs out and the read partial; a Guest lists nothing", async () => {
    const start = await attempt()
    const repoRun = `ci:${uuid()}`
    await recordRepoRun(repoRun)
    await withEngine(async (engine) => {
      const h = await routes(engine, {
        actor: member,
        roles: { repository: repositoryOf("octo/hello"), resolve: () => Effect.fail(new RepoRoles.RoleRefused({ code: "unavailable" })) },
      })
      const [status, body] = await listed(h)
      expect(status).toBe(200)
      expect(body.runs.map((run) => run.runId)).toEqual([todoExecutionId(start.attemptId)])
      expect(h.line("runs.cloud.list")[0]?.annotations).toMatchObject({ outcome: "partial" })
      // A refusal that isn't about now (no App on the repository) leaves the runs out without a partial read.
      const missing_ = await routes(engine, {
        actor: member,
        roles: { repository: repositoryOf("octo/hello"), resolve: () => Effect.fail(new RepoRoles.RoleRefused({ code: "app_not_installed" })) },
      })
      await listed(missing_)
      expect(missing_.line("runs.cloud.list")[0]?.annotations).toMatchObject({ outcome: "read", repo: 0 })
      const [, nothing] = await listed(await routes(engine, { actor: guest }))
      expect(nothing.runs).toEqual([])
    })
  })

  test("reads at most eight repositories' roles; the runs of any older repository wait, and the read says partial", async () => {
    const repos = Array.from({ length: CloudRuns.MAX_REPOSITORIES + 1 }, (_, index) => `github/octo/r${index}`)
    for (const repoId of repos) {
      await runtime.runPromise(RepoRuns.record({
        execution: `ci:${uuid()}`, repoId, flow: "ci", sha: "c".repeat(40), ref: "main", event: "pull_request", launchedBy: "github",
      }))
    }
    await withEngine(async (engine) => {
      const asked: Array<string> = []
      const h = await routes(engine, {
        actor: member,
        roles: {
          repository: repositoryOf("octo/hello"),
          resolve: (_, repository) => Effect.sync(() => {
            asked.push(`${repository.owner}/${repository.name}`)
            return { role: "member" as const, source: "github" as const }
          }) as never,
        },
      })
      const [, body] = await listed(h)
      expect(asked).toHaveLength(CloudRuns.MAX_REPOSITORIES)
      expect(body.runs).toHaveLength(CloudRuns.MAX_REPOSITORIES)
      expect(body.runs.every((run) => run.trigger === "pull_request")).toBe(true)
      expect(h.line("runs.cloud.list")[0]?.annotations).toMatchObject({ outcome: "partial" })
    })
  })

  test("refuses who isn't signed in, a bad limit and another method; 503 when sessions or the engine can't answer", async () => {
    await withEngine(async (engine) => {
      const out = await routes(engine)
      const [status, body] = await listed(out)
      expect([status, body]).toEqual([401, { code: "authentication" }])
      const h = await routes(engine, { actor: member })
      for (const query of ["?limit=0", "?limit=51", "?limit=x"]) {
        expect([query, (await listed(h, query))[0]]).toEqual([query, 400])
      }
      expect((await h.fetch(CLOUD_RUNS_ROUTE, { method: "POST" })).status).toBe(405)
      const sessionsDown = Layer.succeed(Actor.Sessions, Actor.Sessions.of({ resolve: Effect.fail(new Actor.SessionsUnavailable()) }))
      const [down, , downResponse] = await listed(await routes(engine, { sessions: sessionsDown }))
      expect([down, downResponse.headers.get("retry-after")]).toEqual([503, "5"])
      const broken = await routes({ ...engine, database: missing(`missing_${uuid().slice(0, 8).replaceAll("-", "")}`) }, { actor: member })
      await recordRepoRun(`ci:${uuid()}`)
      expect((await listed(broken))[0]).toBe(503)
      expect(broken.line("runs.cloud.list")[0]?.annotations).toMatchObject({ outcome: "unavailable", errorCode: expect.any(String) })
    })
  })
})

describe("the routes", () => {
  test("handle the run route and the shape, and nothing else", () => {
    const runId = todoExecutionId(uuid())
    expect(RemoteRuns.handles(remoteRunRoute(runId))).toBe(true)
    expect(RemoteRuns.handles(REMOTE_RUN_SHAPE_ROUTE)).toBe(true)
    expect(RemoteRuns.handles(CLOUD_RUNS_ROUTE)).toBe(true)
    expect(RemoteRuns.handles(steersRoute(runId))).toBe(true)
    expect(RemoteRuns.parseSteerPath(steersRoute(runId))).toBe(runId)
    expect(RemoteRuns.parseSteerPath(remoteRunRoute(runId))).toBeUndefined()
    expect(RemoteRuns.handles(`${steersRoute(runId)}/x`)).toBe(false)
    for (const path of ["/api/remote-runs", "/api/remote-runs/", `/api/remote-runs/${runId}/steer`, "/api/runs/x", "/api/remote-runs/%E0%A4%A"]) {
      expect([path, RemoteRuns.handles(path)]).toEqual([path, false])
    }
    expect(RemoteRuns.parseRunPath(remoteRunRoute(runId))).toBe(runId)
    expect(RemoteRuns.handles(stopRoute(runId))).toBe(true)
    expect(RemoteRuns.parseStopPath(stopRoute(runId))).toBe(runId)
    expect(RemoteRuns.parseStopPath(steersRoute(runId))).toBeUndefined()
  })

  test("a path the module doesn't serve is 404", async () => {
    await withEngine(async (engine) => {
      const h = await routes(engine, { actor: member })
      expect((await h.fetch("/api/remote-runs")).status).toBe(404)
    })
  })
})
