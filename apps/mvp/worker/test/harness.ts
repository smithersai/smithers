// ChatApi's real handler for the worker tests, on a test file's own schema of the compose Postgres (`pnpm db:up`,
// db/TestDatabase.ts). The model is the only stand-in: a scripted `Model` through HostModel. ChatApi starts remote
// flows through a `FlowStarter` that records each start, unless a test sets one. Every log line, span and metric the
// handler records is kept for the test.
import { ImmutableCache } from "@smthrs/artifacts"
import { Model, type ModelEvent, type ModelRequest } from "@smthrs/model"
import { HostModel } from "@smthrs/model-host"
import { Logger as StructuredLogger } from "@smthrs/observability"
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  Layer,
  Logger,
  ManagedRuntime,
  Metric,
  Option,
  Redacted,
  Stream,
  Tracer,
} from "effect"
import { FetchHttpClient, HttpEffect, HttpServerRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import { afterAll, beforeAll, beforeEach } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as Actor from "../Actor.ts"
import * as RunCredentials from "../RunCredentials.ts"
import * as SessionKeys from "../SessionKeys.ts"
import * as ViewRealm from "../ViewRealm.ts"
import { BranchRoles } from "../branch/Access.ts"
import * as Conversations from "../branch/Conversations.ts"
import { repositoryOf } from "../github/Config.ts"
import * as RepoRoles from "../github/RepoRoles.ts"
import * as ConversationApi from "../branch/ConversationApi.ts"
import * as Chat from "../Chat.ts"
import * as DocsApi from "../docs/Api.ts"
import * as AboutStore from "../about/Store.ts"
import * as DocsSource from "../docs/Source.ts"
import * as Flows from "../Flows.ts"
import { PersonalModels } from "../personal/Models.ts"
import * as RepoAbout from "../RepoAbout.ts"
import { SecretKeys } from "../secrets/Keys.ts"
import type { CuratedFile } from "../home/Curated.ts"

/**
 * The test file's one runtime, on a schema of its own: built before the first test, so a missing Postgres fails the
 * file once with `pnpm db:up` in its message, emptied before each test, and dropped after the last.
 */
/**
 * `BranchRoles` as a deployment without the GitHub App gives them (decision 0079): the real `RepoRoles` over
 * `database`, with `repository` the deployment's own, so the session's role holds on every repository. A test of roles
 * on a repository the App is installed on builds its own over the scripted GitHub.
 */
export const branchRoles = (database: Layer.Layer<SqlClient.SqlClient, unknown>, repository = "smithersai/smithers") =>
  Layer.unwrap(
    Effect.map(
      RepoRoles.make(database, { repository: repositoryOf(repository), app: Option.none() }),
      (roles) => BranchRoles.layer(roles),
    ),
  )

export const testFile = (prefix: string) => {
  const runtime = ManagedRuntime.make(TestDatabase.layer(prefix))
  beforeAll(() => runtime.runPromise(Effect.void))
  beforeEach(() =>
    runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`TRUNCATE message_pins, timeline_summaries, messages, views, view_moves RESTART IDENTITY`))
  )
  afterAll(() => runtime.dispose())
  return runtime
}

type Runtime = ReturnType<typeof testFile>

export const uuid = () => crypto.randomUUID()

/** What the model streams for a request. */
type Script = (request: ModelRequest.ModelRequest) => Stream.Stream<ModelEvent.ModelEvent, Model.ModelFailure>
export const delta = (text: string): ModelEvent.ModelEvent => ({ type: "text-delta", id: "t", text })
export const usage: ModelEvent.ModelEvent = { type: "usage", inputTokens: 12, outputTokens: 34 }
export const stop: ModelEvent.ModelEvent = { type: "settle", stopReason: "stop" }
/** A model that answers with these pieces of text, then reports usage and stops. */
export const answers = (...pieces: ReadonlyArray<string>): Script => () =>
  Stream.make(...pieces.map(delta), usage, stop)
/** The text of a request's messages, in order. */
export const contents = (request: ModelRequest.ModelRequest) =>
  request.messages.map((message) => message.content.map((part) => ("text" in part ? part.text : "")).join(""))

// The record ChatApi's JSON logger writes (Logger.layerStructuredJson in @smthrs/observability), span ids included.
type StructuredLog = ReturnType<typeof StructuredLogger.formatStructured.log>

interface HarnessOptions {
  /** ChatApi's configuration, in place of the environment. */
  readonly config?: Record<string, string>
  /** The database ChatApi connects to: the file's schema unless set. */
  readonly database?: Layer.Layer<SqlClient.SqlClient, unknown>
  /** Who has which role on a branch's repository: as a deployment without the App gives them unless set. */
  readonly branchRoles?: Layer.Layer<BranchRoles>
  /** Where ChatApi starts a remote flow: one that records each start in `starts` unless set. */
  readonly starter?: Flows.FlowStarter["Service"]
  /**
   * The fetch ChatApi calls Electric, the model's provider and outside pages with: the global one unless set. A test
   * that checks pages passes `outsideWeb` (worker/test/pages.ts), so it never reaches the internet.
   */
  readonly fetch?: typeof globalThis.fetch
  /** Who is signed in on every request: nobody unless set, as in production before sign-in is configured. */
  readonly actor?: Actor.Actor
  /** Sessions in place of `actor`: sign-in's own, reading the session cookie (worker/test/signIn.ts). */
  readonly sessions?: Layer.Layer<Actor.Sessions>
  /** The default model's id: `test-model` unless set. */
  readonly modelId?: string
  /**
   * The deployment's default model in place of the scripted one: the agent evals' real model (evals/agent.eval.ts).
   * `script` and `modelId` go unused, and `requests` stays empty.
   */
  readonly model?: HostModel["Service"]
  /** `MODEL_SPEND_ALERTS`' default, as the dev stack sets it to `false`; production's, on, unless set. */
  readonly spendAlerts?: boolean
  /** The curated homes a `docs` view's repository may name its docs in: the real ones unless set. */
  readonly homes?: ReadonlyArray<CuratedFile>
  /** People's own models in place of the real ones over the file's schema, under `PERSONAL_KEYS`. */
  readonly personalModels?: Layer.Layer<PersonalModels>
}

/** SECRETS_KEY for the people's own models in a harness. */
export const PERSONAL_KEYS = Redacted.make("fedcba9876543210".repeat(4))

/** ChatApi's routes on the file's schema and a scripted model, recording every log line, span and metric. */
/** One presentation realm for every harness in a test file: QuickJS compiles once. */
const nodeRealm = ViewRealm.once(ViewRealm.loadNode)

export const harness = async (runtime: Runtime, script: Script, options: HarnessOptions = {}) => {
  const scratch = await runtime.runPromise(Effect.gen(function* () {
    return yield* TestDatabase.Scratch
  }))
  const database = options.database ?? scratch.database
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(spanOptions) {
      const span = new Tracer.NativeSpan(spanOptions)
      spans.push(span)
      return span
    },
  })
  const logs: Array<StructuredLog> = []
  const logger = Logger.make((logOptions) => {
    logs.push(StructuredLogger.formatStructured.log(logOptions))
  })
  const registry: Metric.MetricRegistry = new Map()
  const requests: Array<ModelRequest.ModelRequest> = []
  const starts: Array<{ readonly flow: string; readonly executionId: string; readonly payload: unknown }> = []
  // Hosted inference is on in tests, as under `alchemy dev`, so the scripted model answers; a test turns it off.
  const config = ConfigProvider.fromUnknown({
    ELECTRIC_URL: await runtime.runPromise(TestDatabase.electricUrl),
    HOSTED_MODEL_ENABLED: "true",
    ...options.config,
  })
  const homeRepository = await runtime.runPromise(Conversations.configuredHomeRepositoryNames.pipe(Effect.provideService(ConfigProvider.ConfigProvider, config)))
  const model = Model.make({
    stream: (request) => {
      requests.push(request)
      return script(request)
    },
  })
  const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(Metric.MetricRegistry, registry),
      Effect.provideService(ConfigProvider.ConfigProvider, config),
      Effect.provideService(Conversations.homeRepositoryNames, homeRepository),
    )
  const hostModel = Layer.succeed(
    HostModel,
    options.model ?? HostModel.of({
      modelId: options.modelId ?? "test-model",
      model,
      // ChatApi calls the model only through the endpoint, which streams `model`; nothing prepares a request.
      route: { prepare: () => Effect.die(new Error("the scripted model has no route")) },
    }),
  )
  const chat = await runtime.runPromise(
    observed(
      Chat.make(database, {
        ...(options.spendAlerts === undefined ? {} : { spendAlerts: options.spendAlerts }),
        // Generated views render in the realm Node compiles, loaded once for the whole file (worker/ViewRealm.ts).
        realm: nodeRealm,
      }).pipe(
        Effect.provide(hostModel),
      ),
    ),
  )
  const starter = options.starter ?? Flows.FlowStarter.of({
    start: (flow, { executionId, payload }) =>
      Effect.sync(() => void starts.push({ flow: flow._tag, executionId, payload })),
  })
  // One cache for the harness's life, so a page checked twice is answered from it the second time.
  const webCache = Layer.succeed(
    ImmutableCache.ImmutableCache,
    ImmutableCache.make(ImmutableCache.makeMemoryWebCache(), { backend: "memory" }),
  )
  // Docs, which a `docs` view reads its page from (worker/docs/Source.ts): kept, like ChatApi's, for the harness's life.
  const docsCache = Layer.succeed(
    ImmutableCache.ImmutableCache,
    ImmutableCache.make(ImmutableCache.makeMemoryWebCache(), { backend: "memory" }),
  )
  const docsSettings = await runtime.runPromise(observed(DocsSource.settings))
  // What GitHub says of a repository, which names its docs: RepoApi's about read over this file's schema, none kept.
  await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DELETE FROM repo_about`))
  const about = await runtime.runPromise(observed(
    Effect.flatMap(RepoAbout.settings, (settings) => RepoAbout.make(settings, AboutStore.postgres(database), database)).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, options.fetch ?? globalThis.fetch),
    ),
  ))
  const docsSource = DocsSource.layer(docsSettings, { about, ...(options.homes === undefined ? {} : { homes: options.homes }) }).pipe(
    Layer.provide(Layer.merge(FetchHttpClient.layer, docsCache)),
  )
  // ChatApi routes a repository's docs before the chat routes (worker/ChatApiProgram.ts): open to everyone.
  const docs = DocsApi.make()
  const conversations = await runtime.runPromise(observed(ConversationApi.make(database)))
  const routed = Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
    const path = new URL(request.url, "http://chat.test").pathname
    return DocsApi.handles(path) ? docs.fetch : ConversationApi.handles(path) ? conversations.fetch : chat.fetch
  })
  const handler = HttpEffect.toWebHandler(
    observed(
      routed.pipe(
        Effect.provideService(Flows.FlowStarter, starter),
        Effect.provide(docsSource),
        Effect.provide(
          options.sessions ?? (options.actor === undefined ? signedOut : signedIn(options.actor)),
        ),
        // Sessions that bring no run credentials of their own, such as a faulty test's, get credentials for nobody.
        Effect.provide(credentialsFor([])),
        Effect.provide(options.branchRoles ?? branchRoles(database)),
        // People's own models, their keys under PERSONAL_KEYS: the real ones, read from the file's schema, unless set.
        Effect.provide(options.personalModels ?? PersonalModels.layer(database).pipe(Layer.provide(SecretKeys.layer(PERSONAL_KEYS)))),
        Effect.provide(Layer.merge(FetchHttpClient.layer, webCache)),
        Effect.provideService(FetchHttpClient.Fetch, options.fetch ?? globalThis.fetch),
      ),
    ),
  )
  const line = (message: string) => logs.filter((log) => log.message === message)
  return {
    fetch: (path: string, init?: RequestInit) => handler(new Request(`http://chat.test${path}`, init)),
    ask: (body: unknown, headers: Record<string, string> = {}) =>
      handler(
        new Request("http://chat.test/api/questions", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
      ),
    /** The remote flows ChatApi started through the default `FlowStarter`, in order. */
    starts,
    count: (metric: Metric.Metric<number, Metric.CounterState<number>>, attributes: Record<string, string>) =>
      runtime.runSync(
        Metric.value(Metric.withAttributes(metric, attributes)).pipe(
          Effect.provideService(Metric.MetricRegistry, registry),
        ),
      ).count,
    snapshot: () => runtime.runSync(Metric.snapshot.pipe(Effect.provideService(Metric.MetricRegistry, registry))),
    line,
    /** The one line logged with this message. */
    only: (message: string) => {
      const lines = line(message)
      if (lines.length !== 1) throw new Error(`expected one ${message} line, got ${lines.length}`)
      return lines[0]!
    },
    span: (name: string) => spans.filter((span) => span.name === name),
    spans,
    logs,
    requests,
  }
}

type Harness = Awaited<ReturnType<typeof harness>>

/** The secret a test's run credentials are signed with: a sentinel no record may carry. */
export const RUN_CREDENTIAL_SECRET = "run-credential-secret-sentinel-".padEnd(64, "5")

/**
 * Run credentials signed with the test's key (worker/RunCredentials.ts): a credential reads as its person while they
 * are one of `people`, as a live session would.
 */
export const credentialsFor = (people: ReadonlyArray<Actor.Actor>) =>
  Layer.effect(
    RunCredentials.RunCredentials,
    Effect.map(SessionKeys.make(Redacted.make(RUN_CREDENTIAL_SECRET)), (keys) =>
      RunCredentials.make({
        keys,
        person: (claims) => Effect.succeed(Option.fromNullishOr(people.find((who) => who.subject.id === claims.sub))),
      })),
  )

/**
 * Sessions where every request is `actor`, unless it carries a run credential, which reads as its run acting for them
 * (worker/RunCredentials.ts): how a test, or local development, provides who is signed in. With the credentials.
 */
export const signedIn = (actor: Actor.Actor) =>
  RunCredentials.sessionsWith(Effect.succeedSome(actor)).pipe(Layer.provideMerge(credentialsFor([actor])))

/** Every request signed out, with run credentials for nobody: what ChatApi resolves before sign-in is configured. */
export const signedOut = Layer.merge(Actor.signedOut, credentialsFor([]))

/**
 * Everything a harness recorded that an exporter sends, as one string to search: log lines, span attributes, events
 * and failures (an exporter sends a span's failure as its status message and an exception event), and metric
 * attributes.
 */
export const recorded = (h: Pick<Harness, "logs" | "spans" | "snapshot">) =>
  JSON.stringify(
    {
      logs: h.logs,
      spans: h.spans.map((span) => ({
        attributes: [...span.attributes],
        events: span.events,
        failure: span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
          ? Cause.pretty(span.status.exit.cause)
          : null,
      })),
      metrics: h.snapshot().map((metric) => metric.attributes),
    },
    (_, value) => (typeof value === "bigint" ? String(value) : value),
  )

interface Row {
  readonly id: string
  readonly role: string
  readonly text: string
  readonly status: string
  readonly failure: string | null
  readonly questionId: string | null
  readonly modelId: string | null
  readonly stopReason: string | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly position: number
  readonly xmin: number
}

/** A message as Postgres holds it. */
export const row = (runtime: Runtime, id: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const [found] = yield* sql<Row>`
        SELECT id, role, text, status, failure, question_id AS "questionId", model_id AS "modelId",
          stop_reason AS "stopReason", input_tokens AS "inputTokens", output_tokens AS "outputTokens",
          position::int AS position, xmin::text::int AS xmin
        FROM messages WHERE id = ${id}`
      return found!
    }),
  )

export const rowCount = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.map(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ readonly n: number }>`SELECT count(*)::int AS n FROM messages`,
      ),
      ([result]) => result!.n,
    ),
  )

/** Polls until `check` holds, for up to `withinMs` (two seconds unless set): a condition, never a fixed wait. */
export const eventually = async (check: () => boolean | Promise<boolean>, withinMs = 2_000) => {
  for (let attempt = 0; attempt < withinMs / 20; attempt++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("condition never held")
}

/** The home conversation's id (worker/branch/Conversations.ts): what an ask that names no conversation belongs to. */
export const homeConversation = (runtime: Runtime) =>
  runtime.runPromise(Effect.map(Conversations.home, (home) => home!))
