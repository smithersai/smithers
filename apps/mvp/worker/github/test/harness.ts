import * as GitHubCreation from "../../branch/GitHubCreation.ts"
// The git loop's routes (worker/github/Api.ts) for the tests, on a test file's own schema of the compose Postgres and
// Electric (`pnpm db:up`), as ChatApi serves them: who is asking from a `Sessions` layer, remote flows from a
// `FlowStarter` that records each start in an in-memory Durable Object storage (the same intent again is a no-op,
// another payload under its id a conflict) and, when `run` is set, runs it on the Node host against the scripted GitHub,
// as the Durable Object would. Every log line, span and metric is kept.
import type { Flow } from "@smthrs/flow"
import { FlowRuntime } from "@smthrs/flow"
import { Logger as StructuredLogger } from "@smthrs/observability"
import {
  ConfigProvider,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Metric,
  Option,
  Redacted,
  Scope,
  Tracer,
} from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import type { SqlClient } from "effect/sql"
import { onTestFinished } from "vitest"
import * as TestDatabase from "../../../db/TestDatabase.ts"
import {
  COMMENTS_TABLE,
  ITEMS_TABLE,
  SYNC_TABLE,
  TRIAGE_SETTINGS_TABLE,
  WRITES_TABLE,
} from "../../../src/features/issues/contract.ts"
import { PULL_COMMITS_TABLE, PULLS_TABLE, REVIEWS_TABLE, RUNS_TABLE } from "../../../src/features/pulls/contract.ts"
import * as Actor from "../../Actor.ts"
import * as ExecutionHost from "../../ExecutionHost.ts"
import { FlowStarter, StartConflict } from "../../Flows.ts"
import { build } from "../../test/flowHost.ts"
import { signedIn as signedInAs, type testFile } from "../../test/harness.ts"
import * as Api from "../Api.ts"
import type { GitHubApp, Repository } from "../Config.ts"
import * as RepoRoles from "../RepoRoles.ts"
import * as Host from "../Host.ts"
import type * as Triage from "../Triage.ts"
import { REPOSITORY, services as flowServices } from "./fixtures.ts"
import { APP_ID, appKey, SCRIPTED_API, type ScriptedGitHub, scriptedGitHub } from "./scriptedGitHub.ts"

type Runtime = ReturnType<typeof testFile>
type StructuredLog = ReturnType<typeof StructuredLogger.formatStructured.log>

/** The webhook secret the harness's App is configured with: a sentinel no record may carry. */
export const WEBHOOK_SECRET = "webhook-secret-sentinel-31f9"

/** The App as `Config.configured` reads it for the tests' repository. */
export const app = (overrides: Partial<GitHubApp> = {}): GitHubApp => ({
  appId: APP_ID,
  privateKey: Redacted.make("unused by the routes"),
  webhookSecret: Option.some(Redacted.make(WEBHOOK_SECRET)),
  repository: REPOSITORY,
  apiBaseUrl: SCRIPTED_API,
  ...overrides,
})

/** A Member signed in with session `session`; `null`, with none (local development's developer). */
export const member = (id: string = crypto.randomUUID(), session: string | null = crypto.randomUUID()): Actor.Actor => ({
  subject: { kind: "person", id },
  role: "member",
  ...(session === null ? {} : { session }),
})

const objectStorage = (): ExecutionHost.Storage => {
  const values = new Map<string, unknown>()
  return {
    get: <A>(key: string) => Effect.sync(() => values.get(key) as A | undefined),
    put: (key, value) => Effect.sync(() => void values.set(key, value)),
    delete: (key) => Effect.sync(() => values.delete(key)),
    deleteAll: () => Effect.sync(() => values.clear()),
    getAlarm: () => Effect.succeed(null),
    setAlarm: () => Effect.void,
    deleteAlarm: () => Effect.void,
  } as ExecutionHost.Storage
}

export interface Options {
  /** The App: configured with the webhook secret unless set; `null` for a deployment without it. */
  readonly app?: GitHubApp | null
  /** Who is asking: a Member unless set; `null` signed out. */
  readonly actor?: Actor.Actor | null
  /** Sessions in place of `actor`. */
  readonly sessions?: Layer.Layer<Actor.Sessions>
  /** Where flows start: the recording starter unless set. */
  readonly starter?: FlowStarter["Service"]
  /** Run each started flow on the Node host against `github`. */
  readonly run?: boolean
  readonly github?: ScriptedGitHub
  /** Triage's judge for the flows `run` runs: one that abstains unless set (test/fixtures.ts `judgeSeat`). */
  readonly judge?: Triage.Services["judge"]
  /** The database the routes use: the file's schema unless set. */
  readonly database?: Layer.Layer<SqlClient.SqlClient, unknown>
  /**
   * The deployment's own repository: `REPOSITORY` unless set. Another one makes `github`'s repository a second
   * repository the deployment acts on, whose roles GitHub gives (decision 0079).
   */
  readonly own?: Repository
  /** `GITHUB_ALLOWED_REPOSITORIES`, as ids: none unless set. */
  readonly allowed?: ReadonlySet<string>
  /** Who has which role where: the real `RepoRoles` unless set, as a test of a faulty one sets it. */
  readonly roles?: RepoRoles.RepoRoles<never>
  readonly repoFlows?: boolean
  /** Exercise the production fetch transport against a test HTTP server. */
  readonly metadata?: { readonly url: string; readonly token: string }
}

let harnessKey: Promise<Redacted.Redacted<string>> | undefined

/** The GitHub routes as a web handler, with what they started and recorded. */
export const githubHarness = async (runtime: Runtime, options: Options = {}) => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const database = options.database ?? scratch.database
  const github = options.github ?? scriptedGitHub(REPOSITORY.owner, REPOSITORY.name)
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
  const provider = ConfigProvider.fromUnknown({ ...await runtime.runPromise(TestDatabase.fixtureConfig), ...(options.metadata === undefined ? {} : { GITHUB_API_URL: options.metadata.url, GITHUB_TOKEN: options.metadata.token }) })
  const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Metric.MetricRegistry, registry),
      Effect.provideService(ConfigProvider.ConfigProvider, provider),
    )

  const scope = await Effect.runPromise(Scope.make())
  const fibers = new Map<string, Fiber.Fiber<unknown, unknown>>()
  onTestFinished(async () => {
    await Effect.runPromise(Fiber.interruptAll([...fibers.values()]))
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  // The Node host's engine with the GitHub flows, built when the first flow starts.
  let engine: Context.Context<FlowRuntime.FlowRuntime> | undefined
  const engineFor = Effect.gen(function* () {
    if (engine !== undefined) return engine
    const { services } = yield* Effect.promise(() =>
      flowServices(runtime, github, { database, ...(options.judge === undefined ? {} : { judge: options.judge }) })
    )
    const built = yield* build(Host.registration(services).pipe(Layer.provide(Layer.succeed(GitHubCreation.Settings, { app: Option.none(), allowed: Option.none() }))), { maxConnections: 3 }).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.orDie,
    )
    engine = built.context
    return built.context
  })

  const objects = new Map<string, ExecutionHost.Storage>()
  const starts: Array<{ readonly flow: string; readonly executionId: string; readonly payload: unknown }> = []
  const starter = options.starter ?? FlowStarter.of({
    start: (flow: Flow.Any, start: { readonly executionId: string; readonly payload: unknown }) =>
      Effect.gen(function* () {
        let object = objects.get(start.executionId)
        if (object === undefined) objects.set(start.executionId, object = objectStorage())
        const intent = yield* Effect.orDie(
          ExecutionHost.intent(flow, { executionId: start.executionId, payload: start.payload as never }),
        )
        yield* ExecutionHost.recordStart(object, intent).pipe(
          Effect.catchTag("@smthrs/platform-cloudflare/IntentConflict", () => Effect.fail(new StartConflict())),
        )
        starts.push({ flow: flow._tag, executionId: start.executionId, payload: start.payload })
        if (options.run !== true || fibers.has(start.executionId)) return
        const flows = Context.get(yield* engineFor, FlowRuntime.FlowRuntime)
        const run = flows.execute(flow as never, { executionId: start.executionId, payload: start.payload as never })
        fibers.set(start.executionId, Effect.runFork(observed(run as Effect.Effect<unknown, unknown>)))
      }),
  })

  const own = options.own ?? REPOSITORY
  // A real key, made once per file: a role on another repository is read with the App (decision 0079 §3).
  const configured = options.app === null
    ? Option.none<GitHubApp>()
    : Option.some(options.app ?? app({ privateKey: await (harnessKey ??= appKey()) }))
  const roles = options.roles ?? await runtime.runPromise(observed(RepoRoles.make(database, {
    repository: own,
    app: configured,
    allowed: Option.fromUndefinedOr(options.allowed),
    http: github.http,
  })))
  const routes = await runtime.runPromise(
    observed(Api.make(database, { repository: own, app: configured, roles, ...(options.metadata === undefined ? { http: github.http } : {}), repoFlows: options.repoFlows === true, allowed: Option.fromUndefinedOr(options.allowed) }).pipe(Effect.provideService(Scope.Scope, scope))),
  )
  // Electric, as the routes call it: each table in this file's schema.
  const tables = new Set([
    ITEMS_TABLE,
    COMMENTS_TABLE,
    WRITES_TABLE,
    SYNC_TABLE,
    TRIAGE_SETTINGS_TABLE,
    PULLS_TABLE,
    PULL_COMMITS_TABLE,
    REVIEWS_TABLE,
    RUNS_TABLE,
  ])
  const electric: typeof globalThis.fetch = (input, init) => {
    const upstream = new URL(input instanceof Request ? input.url : String(input))
    const table = upstream.searchParams.get("table")
    if (table !== null && tables.has(table)) upstream.searchParams.set("table", `${scratch.name}.${table}`)
    return globalThis.fetch(upstream, init)
  }
  const handler = HttpEffect.toWebHandler(
    observed(
      routes.fetch.pipe(
        Effect.provide(
          options.sessions ?? (options.actor === null ? Actor.signedOut : signedInAs(options.actor ?? member())),
        ),
        Effect.provideService(FlowStarter, starter),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, electric),
      ),
    ),
  )
  const origin = "http://github.test"
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(new URL(String(input), origin), init)
    return handler(request)
  }) as typeof globalThis.fetch

  const count = (metric: Metric.Metric<number, Metric.CounterState<number>>, attributes: Record<string, string>) =>
    Effect.runSync(
      Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
    ).count

  return {
    fetch,
    github,
    starts,
    logs,
    spans,
    count,
    snapshot: () => Effect.runSync(Metric.snapshot.pipe(Effect.provideService(Metric.MetricRegistry, registry))),
    line: (message: string) => logs.filter((log) => log.message === message),
    /** Waits for every flow started so far to end. */
    settled: async () => {
      for (const fiber of fibers.values()) await Effect.runPromise(Effect.exit(Fiber.join(fiber)))
    },
  }
}

/** GitHub's signature over `body` with `secret`: `sha256=<hex>`. */
export const sign = async (body: string, secret = WEBHOOK_SECRET) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))
  return `sha256=${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

/** A webhook delivery as GitHub sends it, signed with `secret`. */
export const delivery = async (
  event: string,
  payload: unknown,
  options: { readonly id?: string; readonly secret?: string; readonly signature?: string } = {},
) => {
  const body = JSON.stringify(payload)
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": options.id ?? crypto.randomUUID(),
      "x-hub-signature-256": options.signature ?? (await sign(body, options.secret)),
    },
    body,
  } satisfies RequestInit
}
