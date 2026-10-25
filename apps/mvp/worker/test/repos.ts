// RepoApi's real handler (worker/RepoApi.ts) for the repository tests, on a test file's own schema of the compose
// Postgres and Electric (`pnpm db:up`, db/TestDatabase.ts). Code Storage and GitHub are the scripted providers
// (worker/test/codeStorage.ts). A clone RepoApi starts records its intent on its execution's Durable Object storage,
// in memory, as ChatApi's starter does, and runs on the Node host (worker/test/flowHost.ts) in this process, as the
// Durable Object runs it. Every log line, span and metric the handler and the flow record is kept.
import { ImmutableCache } from "@smthrs/artifacts"
import type { CodeStorage } from "@smthrs/effect-code-storage"
import { type Flow, FlowRuntime } from "@smthrs/flow"
import { Logger as StructuredLogger } from "@smthrs/observability"
import {
  ConfigProvider,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Metric,
  Option,
  Scope,
  Tracer,
} from "effect"
import { FetchHttpClient, HttpEffect } from "effect/http"
import { SqlClient } from "effect/sql"
import { onTestFinished } from "vitest"
import * as TestDatabase from "../../db/TestDatabase.ts"
import { repoId, REPOSITORIES_TABLE } from "../../src/features/repo/contract.ts"
import * as Actor from "../Actor.ts"
import * as ExecutionHost from "../ExecutionHost.ts"
import { repositoryOf } from "../github/Config.ts"
import * as RepoRoles from "../github/RepoRoles.ts"
import * as DocsApi from "../docs/Api.ts"
import * as DocsSource from "../docs/Source.ts"
import { FlowStarter, StartConflict } from "../Flows.ts"
import * as RepoClone from "../flows/RepoClone.ts"
import * as HomeApi from "../home/Api.ts"
import type { CuratedFile } from "../home/Curated.ts"
import * as RepoApi from "../RepoApi.ts"
import * as RepoReads from "../RepoReads.ts"
import * as Repos from "../Repos.ts"
import type { RepoUpstream } from "../RepoUpstream.ts"
import { fixture, type GitHubRepository, type Scripted, scripted as makeScripted } from "./codeStorage.ts"
import { GITHUB_API, type ScriptedGitHub, scriptedGitHub } from "./githubRest.ts"
import { build, type Engine } from "./flowHost.ts"
import { signedIn, type testFile } from "./harness.ts"
import { outsideWeb, type Page } from "./pages.ts"

type Runtime = ReturnType<typeof testFile>

/** The person a harness signs every request in as, unless told otherwise. */
export const member: Actor.Actor = { subject: { kind: "person", id: "octocat" }, role: "member" }

/**
 * Electric's shape of `table` in this file's schema: open (created if need be) at its latest offset. A truncate reaches
 * it as `409 must-refetch` once Electric has replicated it, which `truncated` waits for.
 */
const openShape = (table: string) =>
  Effect.gen(function* () {
    const { name } = yield* TestDatabase.Scratch
    const shape = `${yield* TestDatabase.electricUrl}/v1/shape?table=${name}.${table}`
    let at = "offset=-1"
    for (;;) {
      const response = yield* Effect.promise((signal) => fetch(`${shape}&${at}`, { signal }))
      if (!response.ok) return yield* Effect.die(new Error(`Electric answered ${response.status} for ${table}`))
      const body = (yield* Effect.promise(() => response.json())) as ReadonlyArray<{ readonly headers?: { readonly control?: string } }>
      at = `offset=${response.headers.get("electric-offset")}&handle=${response.headers.get("electric-handle")}`
      if (body.some((message) => message.headers?.control === "up-to-date")) return { shape, at }
    }
  })

/** Waits until Electric has replicated a truncate of the shape `openShape` opened: it answers 409 must-refetch. */
const truncated = ({ shape, at }: { readonly shape: string; readonly at: string }) =>
  Effect.gen(function* () {
    let next = at
    for (;;) {
      const response = yield* Effect.promise((signal) => fetch(`${shape}&${next}&live=true`, { signal }))
      yield* Effect.promise(() => response.text())
      if (response.status === 409) return
      if (!response.ok) return yield* Effect.die(new Error(`Electric answered ${response.status} after a truncate`))
      next = `offset=${response.headers.get("electric-offset")}&handle=${response.headers.get("electric-handle")}`
    }
  })

/**
 * Empties the repository tables and the clones' feed rows, and resumes imports, for a test that starts from nothing.
 * It returns once Electric has replicated the truncate: until then Electric still serves the shapes it had, so a tab
 * the next test opens would start from the last test's rows.
 */
export const resetRepos = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const shapes = yield* Effect.forEach([REPOSITORIES_TABLE], openShape)
      yield* sql`TRUNCATE repositories, code_storage_usage`
      yield* sql`TRUNCATE clone_requests`
      yield* sql`DELETE FROM notifications WHERE kind = 'clone'`
      yield* sql`UPDATE repo_imports SET paused = false`
      yield* Effect.forEach(shapes, truncated, { discard: true })
    }).pipe(
      // Inside the hook's 30 s, so a stalled Electric fails the hook with this, and its requests are cancelled.
      Effect.timeout("20 seconds"),
      Effect.orDie,
    ),
  )

type StructuredLog = ReturnType<typeof StructuredLogger.formatStructured.log>

/** A Durable Object's storage in memory, as far as starting an execution reads and writes it. */
const objectStorage = (): ExecutionHost.Storage => {
  const values = new Map<string, unknown>()
  return {
    get: <A>(key: string) => Effect.sync(() => values.get(key) as A | undefined),
    put: (key, value) => Effect.sync(() => void values.set(key, value)),
    delete: (key) => Effect.sync(() => values.delete(key)),
    setAlarm: () => Effect.void,
    deleteAlarm: () => Effect.void,
  }
}

export interface RepoHarnessOptions {
  /** Who is signed in on every request: `member` unless set; `null` is signed out. */
  readonly actor?: Actor.Actor | null
  /** Sessions in place of `actor`, such as ones that can't be read. */
  readonly sessions?: Layer.Layer<Actor.Sessions>
  /** The curated homes ChatApi's home route answers, as worker/ChatApi.ts routes it: the real ones unless set. */
  readonly homes?: ReadonlyArray<CuratedFile>
  /**
   * The repository sign-in reads roles on (`GITHUB_REPOSITORY`), `owner/name`: the home route counts the actor's role
   * there alone. Unless set, a repository no test opens, so a role counts nowhere.
   */
  readonly roles?: string
  /** RepoApi's and the flow's configuration, in place of the environment. */
  readonly config?: Record<string, string>
  /** The scripted Code Storage and GitHub: a fresh one unless set. */
  readonly scripted?: Scripted
  /** GitHub in place of the scripted one: the real `RepoUpstream` in the live tests. */
  readonly upstream?: RepoUpstream["Service"]
  /** A Code Storage client in place of the scripted one, or `"none"` for a deployment without an organization. */
  readonly codeStorage?: CodeStorage.Client | "none"
  /** The database RepoApi and the flow reach: the file's schema unless set. */
  readonly database?: Layer.Layer<SqlClient.SqlClient, unknown>
  /** Where clones start: each execution's Durable Object storage in memory, then the Node host, unless set. */
  readonly starter?: FlowStarter["Service"]
  /** The clone's deadline from its request: 10 minutes unless set. */
  readonly deadline?: Duration.Input
  /** Whether the Smithers GitHub App is installed on every repository Index asks about: not unless set. */
  readonly installed?: boolean
  /**
   * GitHub's REST API as RepoApi's about route reaches it (`GITHUB_API_URL`, `https://api.github.com` unless the config
   * says otherwise): the scripted one (worker/test/githubRest.ts) unless set.
   */
  readonly github?: ScriptedGitHub
  /** The outside web the docs routes read docs sites from, by URL (worker/test/pages.ts): none unless set. */
  readonly pages?: Readonly<Record<string, Page>>
  /**
   * Keeps what the file's `repo_about` holds: this harness is another isolate or data center over the same store. Each
   * harness starts with none kept unless set, as each Worker's cache did.
   */
  readonly keepAbout?: boolean
}

/**
 * RepoApi on the file's schema, with clones running on the Node host in this process. The harness closes when its
 * test finishes: running clones are interrupted and the engine's schema dropped.
 */
export const repoHarness = async (runtime: Runtime, options: RepoHarnessOptions = {}) => {
  const scratch = await runtime.runPromise(Effect.service(TestDatabase.Scratch))
  const database = options.database ?? scratch.database
  if (options.keepAbout !== true) await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DELETE FROM repo_about`))
  const scripted = options.scripted ?? makeScripted()
  const codeStorage = options.codeStorage ?? scripted.client
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
  const provider = ConfigProvider.fromUnknown({ ...await runtime.runPromise(TestDatabase.fixtureConfig), ...options.config })
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

  const budgets = await Effect.runPromise(observed(Repos.budgets))
  // The Node host's engine, built when the first clone starts, with few connections: a test file builds many.
  let engine: { readonly context: Context.Context<FlowRuntime.FlowRuntime>; readonly engine: Engine } | undefined
  const engineFor = (client: CodeStorage.Client) =>
    Effect.gen(function* () {
      if (engine !== undefined) return engine
      const built = yield* build(
        RepoClone.registration({
          database,
          codeStorage: client,
          upstream: options.upstream ?? scripted.upstream,
          budgets,
          deadline: Duration.fromInputUnsafe(options.deadline ?? "10 minutes"),
          index: (owner, name, sha) =>
            RepoReads.make({ codeStorage: client, database, budgets, maxTreePaths: 50_000, maxRefs: 1_000 })
              .files(owner, name, sha).pipe(
                Effect.provideContext(cache),
                Effect.mapError(() => new RepoClone.CloneUnavailable()),
              ),
          installed: () => Effect.succeed(options.installed ?? false),
        }),
        { maxConnections: 3 },
      ).pipe(Effect.provideService(Scope.Scope, scope), Effect.orDie)
      engine = built
      return built
    })
  // Each execution's Durable Object storage, by execution id. Like a deployed object's, it outlives a reset of the
  // database: `resetRepos` empties the tables and leaves these.
  const objects = new Map<string, ExecutionHost.Storage>()
  const starter = options.starter ?? FlowStarter.of({
    start: (flow: Flow.Any, start: { readonly executionId: string; readonly payload: unknown }) =>
      Effect.gen(function* () {
        if (codeStorage === "none") return
        // As ChatApi's starter: the same intent again changes nothing; another payload under the id is a conflict.
        let object = objects.get(start.executionId)
        if (object === undefined) objects.set(start.executionId, object = objectStorage())
        const intent = yield* Effect.orDie(
          ExecutionHost.intent(flow, { executionId: start.executionId, payload: start.payload as never }),
        )
        yield* ExecutionHost.recordStart(object, intent).pipe(
          Effect.catchTag("@smthrs/platform-cloudflare/IntentConflict", () => Effect.fail(new StartConflict())),
        )
        if (fibers.has(start.executionId)) return
        const flows = Context.get((yield* engineFor(codeStorage)).context, FlowRuntime.FlowRuntime)
        const run = flows.execute(flow as never, { executionId: start.executionId, payload: start.payload as never })
        fibers.set(start.executionId, Effect.runFork(observed(run as Effect.Effect<unknown, unknown>)))
      }),
  })

  const cache = await Effect.runPromise(
    Layer.buildWithScope(ImmutableCache.layerMemory(), scope),
  )
  const repo = await runtime.runPromise(
    // Its read token comes from the file's configuration, which names none: no GitHub call is made building it.
    observed(
      RepoApi.make(database, { codeStorage: codeStorage === "none" ? Option.none() : Option.some(codeStorage) }).pipe(
        Effect.provide(FetchHttpClient.layer),
      ),
    ),
  )
  // What RepoApi calls out to: Electric, with the table in this file's schema, and GitHub's REST API, scripted.
  const github = options.github ?? scriptedGitHub()
  // Docs sites are the outside web: the pages a test names answer, any other is unreachable.
  const asked: Array<string> = []
  const outside = outsideWeb(options.pages ?? {}, asked)
  const electric: typeof globalThis.fetch = (input, init) => {
    const upstream = new URL(input instanceof Request ? input.url : String(input))
    if (upstream.origin === GITHUB_API) return github.fetch(new Request(upstream, init))
    if (upstream.protocol === "https:") return outside(input, init)
    if (upstream.searchParams.get("table") === REPOSITORIES_TABLE) {
      upstream.searchParams.set("table", `${scratch.name}.${REPOSITORIES_TABLE}`)
    }
    return globalThis.fetch(upstream, init)
  }
  const handler = HttpEffect.toWebHandler(
    observed(
      repo.fetch.pipe(
        Effect.provide(
          options.sessions ?? (options.actor === null ? Actor.signedOut : signedIn(options.actor ?? member)),
        ),
        Effect.provideService(FlowStarter, starter),
        Effect.provideContext(cache),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, electric),
      ),
    ),
  )
  // ChatApi's home route, which worker/ChatApi.ts routes before RepoApi's: who the asker is, and the curated homes.
  // Without the App, a person has a role only on the deployment's own repository (decision 0079): RepoRoles answers
  // `not_configured` on any other, and the home shows them a visitor's sections there.
  const roles = await runtime.runPromise(observed(RepoRoles.make(database, {
    repository: repositoryOf(options.roles ?? "smithersai/smithers"),
    app: Option.none(),
  })))
  const home = HomeApi.make({ roles, ...(options.homes === undefined ? {} : { files: options.homes }) })
  const homeHandler = HttpEffect.toWebHandler(
    observed(
      home.fetch.pipe(
        Effect.provide(
          options.sessions ?? (options.actor === null ? Actor.signedOut : signedIn(options.actor ?? member)),
        ),
      ),
    ),
  )
  // A repository's docs, which worker/ChatApi.ts routes before RepoApi's reads: the index its home names, read from
  // the outside web through the same cache as what GitHub says of it.
  const docsSettings = await runtime.runPromise(observed(DocsSource.settings.pipe(
    Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, electric),
  )))
  const docs = DocsApi.make()
  const docsHandler = HttpEffect.toWebHandler(
    observed(
      docs.fetch.pipe(
        Effect.provide(
          DocsSource.layer(docsSettings, {
            about: repo.about,
            ...(options.homes === undefined ? {} : { homes: options.homes }),
          }).pipe(
            Layer.provide(Layer.merge(FetchHttpClient.layer, Layer.succeedContext(cache))),
          ),
        ),
        Effect.provideService(FetchHttpClient.Fetch, electric),
      ),
    ),
  )
  const origin = "http://repos.test"
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(new URL(String(input), origin), init)
    const path = new URL(request.url).pathname
    return HomeApi.handles(path) ? homeHandler(request) : DocsApi.handles(path) ? docsHandler(request) : handler(request)
  }) as typeof globalThis.fetch
  const line = (message: string) => logs.filter((log) => log.message === message)
  const request = (owner: string, name: string) =>
    fetch("/api/repos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner, name }),
    })
  const launch = (owner: string, name: string, cloneId: string) =>
    fetch("/api/repos/launch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner, name, cloneId }),
    })

  return {
    origin,
    /** RepoApi as the browser reaches it: a full URL or a path on `origin`. */
    fetch,
    scripted,
    /** GitHub's REST API as the about route reaches it, scripted. */
    github,
    /** Every outside page the docs routes requested, in order. */
    asked,
    /**
     * Asks for a clone of `owner/name` and launches the attempt it answers, as `repo/clone`'s two steps do; answers the
     * request's response.
     */
    clone: async (owner: string, name: string) => {
      const requested = await request(owner, name)
      if (requested.status === 200 || requested.status === 202) {
        const { cloneId } = (await requested.clone().json()) as { readonly cloneId: string }
        await (await launch(owner, name, cloneId)).text()
      }
      return requested
    },
    /** Asks for a clone of `owner/name` and nothing more: `POST /api/repos`. */
    request,
    /** Launches attempt `cloneId` of `owner/name`: `POST /api/repos/launch`. */
    launch,
    /** Waits for every clone started so far to end. */
    settled: async () => {
      for (const fiber of fibers.values()) await Effect.runPromise(Effect.exit(Fiber.join(fiber)))
    },
    /** The clone executions started, by execution id. */
    started: () => [...fibers.keys()],
    /** The real engine schema, for asserting it belongs to this fixture database. */
    engineSchema: () => engine?.engine.schema,
    /** Publishes `owner/name` on the scripted GitHub, clones it to the end, and answers its id and head commit. */
    seed: async (owner: string, name: string, repository: GitHubRepository = fixture()) => {
      scripted.publish(owner, name, repository)
      const answer = await (await request(owner, name)).json() as { readonly cloneId: string }
      await (await launch(owner, name, answer.cloneId)).text()
      for (const fiber of fibers.values()) await Effect.runPromise(Effect.exit(Fiber.join(fiber)))
      return { id: repoId(owner, name), headSha: repository.commit.sha, answer }
    },
    /** The reads RepoApi answers with, for the agent's flows on this host, over this harness's cache. */
    reader: () =>
      Option.match(repo.reads, {
        onNone: () => {
          throw new Error("this harness has no Code Storage")
        },
        onSome: (reads) =>
          RepoReads.reader(reads as never, Layer.succeedContext(cache)),
      }),
    count: (metric: Metric.Metric<number, Metric.CounterState<number>>, attributes: Record<string, string> = {}) =>
      Effect.runSync(
        Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
      ).count,
    gauge: (metric: Metric.Metric<number, Metric.GaugeState<number>>) =>
      Effect.runSync(Metric.value(metric).pipe(Effect.provideService(Metric.MetricRegistry, registry))).value,
    snapshot: () => Effect.runSync(Metric.snapshot.pipe(Effect.provideService(Metric.MetricRegistry, registry))),
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
    /** A clone execution's status in the engine. */
    status: (executionId: string) =>
      engine === undefined ? Promise.resolve(undefined) : Effect.runPromise(engine.engine.status(executionId)),
  }
}

export type RepoHarness = Awaited<ReturnType<typeof repoHarness>>

/** A `repositories` row as Postgres holds it. */
export const repositoryRow = (runtime: Runtime, id: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const [row] = yield* sql<{
        readonly id: string
        readonly owner: string
        readonly name: string
        readonly status: string
        readonly failure: string | null
        readonly capacity: string | null
        readonly storedBytes: string | null
        readonly retryAt: Date | null
        readonly defaultBranch: string | null
        readonly headSha: string | null
        readonly headMessage: string | null
        readonly headAuthor: string | null
        readonly attempt: number
        readonly cloneId: string
        readonly settledAt: Date | null
        readonly stage: string | null
        readonly requestedBy: string | null
        readonly reclaimable: boolean
      }>`
        SELECT id, owner, name, status, failure, capacity, stored_bytes::text AS "storedBytes", retry_at AS "retryAt",
          default_branch AS "defaultBranch", head_sha AS "headSha", head_message AS "headMessage",
          head_author AS "headAuthor", attempt, clone_id::text AS "cloneId", settled_at AS "settledAt", stage,
          (SELECT c.requested_by FROM clone_requests c WHERE c.repo_id = r.id AND c.clone_id = r.clone_id) AS "requestedBy",
          reclaimable
        FROM repositories r WHERE id = ${id}`
      return row
    }),
  )

/** This month's `code_storage_usage` row, if any. */
export const usageRow = (runtime: Runtime) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const [row] = yield* sql<{ readonly read: string; readonly imported: string; readonly alerted: number }>`
        SELECT bytes_read::text AS read, bytes_imported::text AS imported, alerted_pct AS alerted
        FROM code_storage_usage WHERE month = (date_trunc('month', now() AT TIME ZONE 'UTC'))::date`
      return row === undefined
        ? undefined
        : { read: Number(row.read), imported: Number(row.imported), alerted: row.alerted }
    }),
  )

/** `recipient`'s feed row for `subject`, if any: what the toast and the feed list show. */
export const notificationRow = (runtime: Runtime, recipient: string, subject: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const [row] = yield* sql<{
        readonly kind: string
        readonly state: string
        readonly mine: boolean
        readonly title: string | null
        readonly ref: string | null
        readonly href: string
        readonly version: number
        readonly dismissedVersion: number
      }>`
        SELECT kind, state, mine, title, ref, href, version, dismissed_version AS "dismissedVersion"
        FROM notifications WHERE recipient = ${recipient} AND subject = ${subject}`
      return row
    }),
  )
