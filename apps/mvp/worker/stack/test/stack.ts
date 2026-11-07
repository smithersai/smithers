// The stack's routes (worker/stack/Api.ts) for the worker tests, on a test file's own schema of the compose Postgres
// (`pnpm db:up`) and the compose Electric, recording every log line, span and metric. Who is signed in is a test's
// `Sessions`; a host that runs TODOs is a test's `TodoRuns`, recording each start and stop, or failing them.
import { Logger as StructuredLogger } from "@smthrs/observability"
import { ConfigProvider, Effect, Layer, Logger, Metric, Option, Tracer } from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import { SqlClient } from "effect/sql"
import * as TestDatabase from "../../../db/TestDatabase.ts"
import { TODO_REQUESTS_TABLE, TODOS_TABLE } from "../../../src/features/todos/contract.ts"
import * as Actor from "../../Actor.vibe"
import type { testFile } from "../../test/harness.ts"
import { signedIn } from "../../test/harness.ts"
import * as Api from "../Api.ts"
import * as Stack from "../Stack.ts"
import { type Repository, repositoryOf } from "../../github/Config.vibe"
import * as RepoRoles from "../../github/RepoRoles.ts"

type Runtime = ReturnType<typeof testFile>
type StructuredLog = ReturnType<typeof StructuredLogger.formatStructured.log>

/** What a test's run host does: records each start and stop, or refuses them with `RunsUnavailable`. */
export interface Runs {
  readonly started: Array<Stack.AttemptStart>
  readonly stopped: Array<Stack.AttemptStop>
  /** Refuses the next `count` starts or stops. */
  readonly refuse: (count: number) => void
  readonly layer: Layer.Layer<Stack.TodoRuns>
}

/** A run host that records what the route hands it. */
export const runs = (): Runs => {
  const started: Array<Stack.AttemptStart> = []
  const stopped: Array<Stack.AttemptStop> = []
  let refusing = 0
  const refused = () => {
    if (refusing === 0) return false
    refusing -= 1
    return true
  }
  return {
    started,
    stopped,
    refuse: (count) => void (refusing += count),
    layer: Layer.succeed(
      Stack.TodoRuns,
      Stack.TodoRuns.of({
        start: (attempt) =>
          Effect.suspend(() =>
            refused()
              ? Effect.fail(new Stack.RunsUnavailable({ errorCode: "no_host" }))
              : Effect.sync(() => void started.push(attempt))
          ),
        stop: (attempt) =>
          Effect.suspend(() =>
            refused()
              ? Effect.fail(new Stack.RunsUnavailable({ errorCode: "no_host" }))
              : Effect.sync(() => void stopped.push(attempt))
          ),
      }),
    ),
  }
}

export interface StackOptions {
  /** Who is signed in on every request: nobody unless set. */
  readonly actor?: Actor.Actor
  /** Sessions in place of `actor`. */
  readonly sessions?: Layer.Layer<Actor.Sessions>
  /** The host's `TodoRuns`: none unless set, as on a host that runs no TODOs. */
  readonly runs?: Runs
  /** Who has which role where: the deployment's own repository `octo/hello` and no App unless set (decision 0079). */
  readonly roles?: Partial<RepoRoles.Options>
  /** A faulty `RepoRoles` in place of the real one. */
  readonly faultyRoles?: RepoRoles.RepoRoles<never>
  /** The real `RepoRoles`, changed: a test that interleaves something between a role's read and its change. */
  readonly wrapRoles?: (roles: RepoRoles.RepoRoles<never>) => RepoRoles.RepoRoles<never>
  /** Reads an issue from GitHub for `attach`'s live check: none unless set, as on a deployment with no App. */
  readonly refreshIssue?: (repository: Repository, number: number) => Effect.Effect<void, unknown, SqlClient.SqlClient>
  /** A faulty database service for the status read's unavailable and privacy path. */
  readonly faultyDatabase?: Layer.Layer<SqlClient.SqlClient, unknown>
}

/** The deployment's own repository in these tests: the one whose role is the session's. */
export const OWN_REPOSITORY = repositoryOf("octo/hello")

/** The stack's routes on the file's schema, as ChatApi routes them. */
export const stackHarness = async (runtime: Runtime, options: StackOptions = {}) => {
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
  /** Every request sent to Electric, as sent, before the table is pointed at the file's schema. */
  const electric: Array<URL> = []
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    electric.push(new URL(url))
    const table = url.searchParams.get("table")
    if (table === TODOS_TABLE || table === TODO_REQUESTS_TABLE) url.searchParams.set("table", `${scratch.name}.${table}`)
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
  const roles = options.faultyRoles ?? await runtime.runPromise(
    observed(RepoRoles.make(scratch.database, { repository: OWN_REPOSITORY, app: Option.none(), ...options.roles })),
  )
  const api = await runtime.runPromise(observed(Api.make(options.faultyDatabase ?? scratch.database, options.wrapRoles === undefined ? roles : options.wrapRoles(roles), options.refreshIssue === undefined ? {} : { refreshIssue: options.refreshIssue })))
  const routes = options.runs === undefined ? api.fetch : api.fetch.pipe(Effect.provide(options.runs.layer))
  const handler = HttpEffect.toWebHandler(
    observed(
      routes.pipe(
        Effect.provide(options.sessions ?? (options.actor === undefined ? Actor.signedOut : signedIn(options.actor))),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    ),
  )
  const line = (message: string) => logs.filter((log) => log.message === message)
  return {
    fetch: (path: string, init?: RequestInit) => handler(new Request(`http://chat.test${path}`, init)),
    electric,
    count: (metric: Metric.Metric<number, Metric.CounterState<number>>, attributes: Record<string, string>) =>
      runtime.runSync(
        Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
      ).count,
    snapshot: () => runtime.runSync(Metric.snapshot.pipe(Effect.provideService(Metric.MetricRegistry, registry))),
    line,
    /** The one line logged with this message. */
    only: (message: string) => {
      const lines = line(message)
      if (lines.length !== 1) throw new Error(`expected one ${message} line, got ${lines.length}`)
      return lines[0]!
    },
    logs,
    spans,
  }
}

export type StackHarness = Awaited<ReturnType<typeof stackHarness>>
