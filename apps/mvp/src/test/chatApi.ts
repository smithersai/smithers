import { PINS_TABLE } from "../features/pins/contract"
import * as ViewRealm from "../../worker/ViewRealm.ts"
import * as Pg from "@effect/sql-pg"
import { ImmutableCache } from "@smthrs/artifacts"
import { PostgresDatabase } from "@smthrs/database"
import { ShapeSource } from "@smthrs/effect-electric"
import { Outbox } from "@smthrs/effect-tanstack-db"
import { FlowRuntime } from "@smthrs/flow"
import { Journal as FlowJournal } from "@smthrs/flows"
import { Model, ModelError, type ModelEvent, type ModelRequest } from "@smthrs/model"
import { HostModel } from "@smthrs/model-host"
import { BrowserEngine, BrowserRuntime, StoragePersistence, TabChannel, WebLock } from "@smthrs/platform-browser"
import { BrowserCollectionCoordinator, createBrowserWASQLitePersistence } from "@tanstack/browser-db-sqlite-persistence"
import { startOfflineExecutor } from "@tanstack/offline-transactions"
import {
  Cause,
  ConfigProvider,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  ManagedRuntime,
  Metric,
  Option,
  Queue,
  Redacted,
  Schedule,
  Schema,
  Scope,
  Stream,
  Tracer
} from "effect"
import { Flow, Interpreter, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { FetchHttpClient, type HttpClient, HttpEffect, HttpServerRequest } from "effect/http"
import * as Socket from "effect/socket/Socket"
import { SqlClient } from "effect/sql"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import * as TestDatabase from "../../db/TestDatabase.ts"
import * as Actor from "../../worker/Actor.ts"
import * as BranchApi from "../../worker/branch/BranchApi.ts"
import { Forge } from "../../worker/branch/Forge.ts"
import { Directory } from "../../worker/branch/People.ts"
import { Rooms } from "../../worker/branch/Rooms.ts"
import { TerminalSockets } from "../../worker/branch/Sandboxes.ts"
import * as Chat from "../../worker/Chat.ts"
import * as Flows from "../../worker/Flows.ts"
import * as Pause from "../../worker/flows/Pause.ts"
import * as GitHubApi from "../../worker/github/Api.ts"
import { repositoryOf } from "../../worker/github/Config.ts"
import {
  APP_ID,
  appKey,
  SCRIPTED_API,
  type ScriptedGitHub,
  scriptedGitHub
} from "../../worker/github/test/scriptedGitHub.ts"
import * as DocsApi from "../../worker/docs/Api.ts"
import * as DocsSource from "../../worker/docs/Source.ts"
import * as DomainsApi from "../../worker/domains/Api.ts"
import * as DomainsConfig from "../../worker/domains/Config.ts"
import * as DomainFlows from "../../worker/domains/DomainFlows.ts"
import { DomainProvider } from "../../worker/domains/Provider.ts"
import * as HomeApi from "../../worker/home/Api.ts"
import type { CuratedFile } from "../../worker/home/Curated.ts"
import * as RemoteRuns from "../../worker/RemoteRuns.ts"
import * as RepoApi from "../../worker/RepoApi.ts"
import * as RunCredentials from "../../worker/RunCredentials.ts"
import * as PersonalApi from "../../worker/personal/Api.ts"
import * as BugsApi from "../../worker/bugs/Api.ts"
import { BUG_REPORTS_TABLE } from "../features/bugs/contract"
import * as ModelFlows from "../../worker/personal/ModelFlows.ts"
import { PersonalModels } from "../../worker/personal/Models.ts"
import {
  ANTHROPIC_ORIGIN,
  OPENAI_ORIGIN,
  type Reply as ProviderReply,
  scriptedProvider,
  type Seen as ProviderSeen,
} from "../../worker/personal/test/provider.ts"
import * as SecretsApi from "../../worker/secrets/Api.ts"
import { SecretKeys } from "../../worker/secrets/Keys.ts"
import * as SecretFlows from "../../worker/secrets/SecretFlows.ts"
import * as SignIn from "../../worker/SignIn.ts"
import * as StackApi from "../../worker/stack/Api.ts"
import * as Stack from "../../worker/stack/Stack.ts"
import {
  codeStorageGit,
  type GitHost,
  gitHost,
  rooms,
  type Sockets,
  terminalSockets,
  type TestRooms
} from "../../worker/test/branch.ts"
import { build as buildEngine } from "../../worker/test/flowHost.ts"
import { credentialsFor } from "../../worker/test/harness.ts"
import { outsideWeb, type Page } from "../../worker/test/pages.ts"
import { appLayer, type AppOptions, type Host, realServices } from "../boot"
import { NOTIFICATIONS_TABLE } from "../features/attention/contract"
import { bindSessionConnectivity } from "../features/auth/auth"
import { SESSION_ROUTE } from "../features/auth/contract"
import { SHARES_TABLE } from "../features/branch/contract"
import { MESSAGES_TABLE, QUESTIONS_ROUTE, TELEMETRY_ROUTE } from "../features/chat/contract"
import type { TextsClient } from "../features/coedit/api"
import { TEXT_UPDATES_TABLE } from "../features/coedit/contract"
import { CONVERSATION_PEOPLE_TABLE } from "../features/conversations/contract"
import { DOMAINS_TABLE } from "../features/domains/contract"
import { FLOW_DRAFTS_TABLE, FLOWS_TABLE } from "../features/flows-ui/contract"
import type { IssuesClient } from "../features/issues/api"
import {
  COMMENTS_TABLE,
  ITEMS_TABLE,
  SYNC_TABLE,
  TRIAGE_SETTINGS_TABLE,
  WRITES_TABLE
} from "../features/issues/contract"
import type { PullsClient } from "../features/pulls/api"
import { PULL_COMMITS_TABLE, PULLS_TABLE, REVIEWS_TABLE } from "../features/pulls/contract"
import { todoExecutionId } from "../features/pulls/contract"
import type { SecretsClient } from "../features/secrets/api"
import type { PersonalModelClient } from "../features/personal-model/api"
import { PERSONAL_MODELS_TABLE } from "../features/personal-model/contract"
import { SECRETS_TABLE } from "../features/secrets/contract"
import { REPOS_ROUTE, repoId, REPOSITORIES_SHAPE_ROUTE, REPOSITORIES_TABLE } from "../features/repo/contract"
import { ALERT_CHANNELS_TABLE, ALERT_DELIVERIES_TABLE, SANDBOX_LIMITS_TABLE, SPEND_ALERTS_TABLE } from "../features/spend/contract"
import { RUNS_TABLE } from "../features/status/contract"
import { TERMINALS_TABLE } from "../features/terminal/contract"
import type { ThemeMode } from "../features/theme/contract"
import type { StackClient } from "../features/todos/api"
import { TODO_REQUESTS_TABLE, TODOS_TABLE } from "../features/todos/contract"
import * as RepoRoles from "../../worker/github/RepoRoles.ts"
import { BranchRoles } from "../../worker/branch/Access.ts"
import * as RepoRuns from "../../worker/RepoRuns.ts"
import { VIEWS_TABLE } from "../features/views/contract"
import { clientFlows } from "../flows/declarations"
import { workerRegistrations } from "../flows/registrations"
import type { Endpoint } from "../flows/tabPort"
import { faultyServices } from "./faults"
import { tempDirectory } from "./tempDirectory"

/** One presentation realm for every test app in a file: QuickJS compiles once. */
const nodeRealm = ViewRealm.once(ViewRealm.loadNode)

// ChatApi's real handler (worker/Chat.ts, and RepoApi for repositories, as worker/ChatApi.ts routes them), as the
// browser reaches it, over the compose Postgres and Electric (`pnpm db:up`). Only the model is scripted: a test writes
// each answer, which the device's agent (`chat/Answer`, run by a device opened with `answers`) reads as its cell. Every
// request is signed in as a Member unless the ChatApi is opened signed out.
//
// Each instance gets its own schema (db/TestDatabase.ts), migrated by db/migrations and dropped when its scope closes,
// so tests never touch the dev conversation. ChatApi's SQL reaches it through the connection's search_path; its shape
// requests reach it because the fetch ChatApi calls Electric with names the schema in `table`, the one place the
// schema shows.
//
// The browser reaches ChatApi through `fetch`, which hands each request to the handler in this process. Faults are
// never injected here: a test of an unhappy path gives the browser faulty services instead (src/test/faults.ts).

/**
 * What a test writes into the answer to one question, as the model's reply to the agent: one cell that ends the run
 * with `ctx.done("<text>")`, the text streamed as it is said.
 */
export interface Reply {
  /** Streams `text` into the answer: the first time, the cell's opening and `ctx.done("` before it. */
  readonly say: (text: string) => void
  /** Closes the literal and the cell, reports usage and stops. */
  readonly done: () => void
  /** Ends the stream with a model error the agent doesn't retry: the answer settles failed, `model_error`. */
  readonly fail: (error?: ModelError.ModelError) => void
  /** Answers with one whole cell of `source`, such as a flow call, then reports usage and stops. */
  readonly cell: (source: string) => void
}

/** Where a test ChatApi answers: the browser's origin in these tests. */
export const CHATAPI_ORIGIN = "http://chatapi.test"

/** A signed-in person with the Member role: who every request to a test ChatApi is, unless it is opened signed out. */
export const member: Actor.Actor = { subject: { kind: "person", id: "person-member" }, role: "member" }

/** The repository a test ChatApi's git loop syncs and writes to (`GITHUB_REPOSITORY`). */
export const TEST_REPOSITORY = "octo/hello"

/**
 * How a test ChatApi is opened: who every request is signed in as, `member` unless set, or nobody (`null`); and the
 * origin it answers on, `CHATAPI_ORIGIN` unless set. A test whose tab must reach a real local server at the app's
 * origin, such as a terminal's socket, sets that server's.
 */
export interface ChatApiOptions {
  readonly actor?: Actor.Actor | null
  /** The curated homes ChatApi answers (worker/home/Curated.ts): the real ones unless set. */
  readonly homes?: ReadonlyArray<CuratedFile>
  /**
   * The branches' forge: GitHub, read with no credential, unless `code-storage`: Code Storage scripted over the same git
   * host (worker/test/branch.ts `codeStorageGit`), which can make a new branch. A service injects forge faults.
   */
  readonly forge?: "github" | "code-storage" | Forge["Service"]
  readonly origin?: string
  /**
   * Other people a test's devices may be, by name: a request carrying `x-test-person: <name>` is signed in as them
   * (`asPerson`), so one ChatApi serves two people's devices.
   */
  readonly people?: Readonly<Record<string, Actor.Actor>>
  /**
   * The outside web ChatApi checks pages against (worker/test/pages.ts): these pages answer, and any other outside
   * `https:` page is unreachable, so no test reaches the internet. None unless set.
   */
  readonly pages?: Readonly<Record<string, Page>>
  /**
   * What a person's own model's provider answers each call (worker/personal/test/provider.ts): the OpenAI-compatible
   * one at `OPENAI_ORIGIN` and the Anthropic-compatible one at `ANTHROPIC_ORIGIN`, scripted at the network. `ok` unless
   * set; a function sees how many calls came before, and is read at each call.
   */
  readonly provider?: ProviderReply | ((index: number) => ProviderReply)
}

/** The header a test device's requests name their person with (`ChatApiOptions.people`). */
const PERSON_HEADER = "x-test-person"

/** A run that starts one job, `probe/Pause`, as a repository's run starts its jobs (docs/features/actions.md). */
const Nested = Flow.make("test/Nested", {
  description: "Starts probe/Pause as its job.",
  modelInvocable: false,
  payload: Pause.Pause.payloadSchema.fields,
  success: Schema.String,
  error: Sleep.SleepRequestInvalid,
  body: Node.capture({}, (payload) => Pause.Pause.child(payload)),
})

/** A remote flow a route started: the git loop's routes start them, and no remote host runs here. */
export interface Started {
  readonly flow: string
  readonly executionId: string
  readonly payload: unknown
}

/** The tables whose shapes the test's Electric reads from the ChatApi's own schema. */
const SCHEMA_TABLES: ReadonlySet<string> = new Set([
  DOMAINS_TABLE,
  MESSAGES_TABLE,
  PINS_TABLE,
  TEXT_UPDATES_TABLE,
  REPOSITORIES_TABLE,
  VIEWS_TABLE,
  RUNS_TABLE,
  NOTIFICATIONS_TABLE,
  ITEMS_TABLE,
  COMMENTS_TABLE,
  WRITES_TABLE,
  SYNC_TABLE,
  TRIAGE_SETTINGS_TABLE,
  FLOWS_TABLE,
  FLOW_DRAFTS_TABLE,
  TERMINALS_TABLE,
  SHARES_TABLE,
  CONVERSATION_PEOPLE_TABLE,
  SPEND_ALERTS_TABLE,
  ALERT_CHANNELS_TABLE,
  ALERT_DELIVERIES_TABLE,
  SANDBOX_LIMITS_TABLE,
  TODOS_TABLE,
  TODO_REQUESTS_TABLE,
  PULLS_TABLE,
  PULL_COMMITS_TABLE,
  REVIEWS_TABLE,
  SECRETS_TABLE,
  PERSONAL_MODELS_TABLE,
  BUG_REPORTS_TABLE
])

/** SECRETS_KEY in a test ChatApi: secrets are on. */
export const TEST_SECRETS_KEY = Redacted.make("0123456789abcdef".repeat(4))

/** A Postgres schema for one device's engine store, and where the device keeps the engine's leaders. */
export interface EngineStore {
  readonly url: string
  readonly schema: string
  /** Keeps a leader so it is interrupted, at the latest, when the ChatApi closes. */
  readonly keep: (leader: Fiber.Fiber<never, unknown>) => void
}

/** A fresh ES256 key, as Code Storage's Keys page hands one out: a PKCS#8 PEM. */
const codeStorageKey = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
  return `-----BEGIN PRIVATE KEY-----\n${
    btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n")
  }\n-----END PRIVATE KEY-----\n`
}

/** Content-free evidence for an answer that did not settle in a test. */
export interface AnswerDiagnostics {
  readonly answer: { readonly status: string; readonly failure: string | null } | null
  readonly report: { readonly status: string; readonly waiting: string | null } | null
  readonly engines: ReadonlyArray<{
    readonly status: string
    readonly attempts: ReadonlyArray<{ readonly state: string; readonly count: number }>
    readonly records: ReadonlyArray<{ readonly type: string; readonly count: number }>
  }>
}

export class TestChatApi extends Context.Service<
  TestChatApi,
  {
    readonly origin: string
    /** The browser's way to ChatApi: each request handed to the handler in this process. */
    readonly fetch: typeof globalThis.fetch
    /**
     * The scripted answer to the first model request whose prompt includes `question` (the `nth`, from 0, when set),
     * once the agent asks the model through ChatApi's model endpoint. The agent's prompt wraps the question with the
     * conversation before it.
     */
    readonly answerTo: (question: string, nth?: number) => Effect.Effect<Reply>
    /** How many model requests the agent made whose prompt includes `question`. */
    readonly modelRequests: (question: string) => number
    /** Reads status and journal stage counts only: no payloads, result text or credentials. */
    readonly answerDiagnostics: (answerId: string) => Effect.Effect<AnswerDiagnostics>
    /** The status of every answer to `POST /api/questions` the browser got, in order. */
    readonly questionStatuses: () => ReadonlyArray<number>
    /** Asks as another device would, through ChatApi. */
    readonly askElsewhere: (text: string) => Effect.Effect<{ readonly questionId: string; readonly answerId: string }>
    /** The rows in Postgres, in order. */
    readonly rows: Effect.Effect<
      ReadonlyArray<{ readonly id: string; readonly text: string; readonly position: number }>
    >
    /** Every OTLP request the browser sent: its path and JSON body. */
    readonly telemetry: Array<{ readonly path: string; readonly body: string }>
    /** Every span ChatApi recorded. */
    readonly spans: Array<Tracer.NativeSpan>
    /** Every call a person's own model's scripted provider got (`ChatApiOptions.provider`), in order. */
    readonly providerCalls: ReadonlyArray<ProviderSeen>
    /** The page reload the app asks for: it counts, and reloads nothing. */
    readonly reload: () => void
    readonly reloads: () => number
    /**
     * A fresh schema on the compose Postgres for a device's engine store (in place of SQLite on OPFS). Each one, and
     * every leader kept on it, goes when this ChatApi closes.
     */
    readonly engineStore: () => EngineStore
    /** Bug reports' routes (worker/bugs/Api.ts): every `ops/BugReport` they started, recorded and never run. */
    readonly bugs: { readonly starts: ReadonlyArray<Started> }
    /**
     * The git loop (worker/github/Api.ts) for `TEST_REPOSITORY`, with a GitHub App configured: every remote flow its
     * routes started (`starts`), and its Postgres, where a test writes what a remote flow would (`run`).
     */
    readonly github: {
      readonly starts: ReadonlyArray<Started>
      readonly run: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.Effect<A>
      /** GitHub as the routes' own reads meet it (the compare route's): `TEST_REPOSITORY`, the App installed. */
      readonly scripted: ScriptedGitHub
    }
    /**
     * The branch workspace's routes (worker/branch/BranchApi.ts), as ChatApi routes them: the forge is GitHub, read with
     * no credential (`Forge.gitHub`), and GitHub is the scripted git host `github` (worker/test/branch.ts). No remote host
     * runs here, so each `terminal/Open` a route starts is recorded in `starts`, never run, and a test settles the
     * terminal's row itself, as the remote flow does, through `run`. The branches' machines are a test
     * `TerminalSockets` (`sockets`), and their rooms a test `Rooms` (`rooms`), standing in for the Cloudflare Durable
     * Object bindings. A branch is shared by login (their login, else their id) with the actor and anyone in `people`,
     * and with whoever signed in to the schema's `people`. `refuseStarts(n)` makes the next `n` starts fail as unavailable, as a Durable Object ChatApi can't reach
     * does.
     */
    readonly branches: {
      readonly forge: ReturnType<typeof codeStorageGit>
      readonly github: GitHost
      readonly starts: ReadonlyArray<Started>
      readonly sockets: Sockets
      readonly rooms: TestRooms
      readonly refuseStarts: (count: number) => void
      readonly run: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.Effect<A>
    }
    /**
     * Runs on Cloudflare, as ChatApi serves them (worker/RemoteRuns.ts): an engine on a schema of its own, built on first
     * use, that runs `probe/Pause` as the Durable Object would, with no host that runs TODOs. `todoRun` commits a TODO as
     * a host that runs TODOs does and answers its run's id, `todo:<attempt id>`, which nothing runs yet; `start` runs
     * `probe/Pause` under that id until this ChatApi closes.
     */
    readonly remote: {
      readonly todoRun: (title: string) => Effect.Effect<string>
      /** A repository's run of `flow` recorded on `TEST_REPOSITORY`, as a trigger records one: its execution id. */
      readonly repoRun: (flow: string) => Effect.Effect<string>
      /** The run's status in the engine. */
      readonly status: (runId: string) => Effect.Effect<string | undefined>
      readonly progress: (runId: string) => Effect.Effect<number>
      /** Controlled live-action gate and feed receipts, using the real engine and database. */
      readonly ready: (runId: string) => Effect.Effect<void>
      readonly release: (runId: string) => Effect.Effect<void>
      readonly settled: (runId: string) => Effect.Effect<void>
      readonly revision: (runId: string) => Effect.Effect<number>
      readonly prepareProgress: (runId: string) => Effect.Effect<number>
      /** With `nested`, a run that starts `probe/Pause` as its job (`test/Nested`), as a repository's run starts jobs. */
      readonly start: (
        runId: string,
        payload: { readonly label: string; readonly pauseMs: number; readonly hold?: boolean; readonly nested?: boolean },
      ) => Effect.Effect<void>
    }
  }
>()("@smthrs/mvp/test/TestChatApi") {
  /** ChatApi on a scratch schema, every request signed in as `options.actor`: `member` unless set. */
  static readonly layerWith = (options: ChatApiOptions) =>
    Layer.effect(
      TestChatApi,
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const { name: schema, database } = yield* TestDatabase.Scratch
        const actor = options.actor === undefined ? member : options.actor
        const people = options.people ?? {}
        // A request carrying a run credential is that run's, as sign-in reads it (worker/RunCredentials.ts); any other
        // is its device's person.
        const credentials = credentialsFor(actor === null ? [] : [actor, ...Object.values(people)])
        const sessions = actor === null
          ? Layer.merge(Actor.signedOut, credentials)
          : RunCredentials.sessionsWith(
            Effect.map(HttpServerRequest.HttpServerRequest, (request) => {
              const named = request.headers[PERSON_HEADER]
              return Option.some(named !== undefined && Object.hasOwn(people, named) ? people[named]! : actor)
            })
          ).pipe(Layer.provideMerge(credentials))

        // Device engine stores: dropped when this ChatApi closes, after their leaders stop and every connection a
        // leader left open (named for its store) is ended, so the drop never waits on a write.
        const server = (yield* Effect.orDie(TestDatabase.serverUrl)).toString()
        const stores: Array<string> = []
        const leaders: Array<Fiber.Fiber<never, unknown>> = []
        yield* Effect.addFinalizer(() =>
          Fiber.interruptAll(leaders).pipe(
            Effect.andThen(
              Effect.forEach(
                stores,
                (store) =>
                  sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = ${store}`.pipe(
                    Effect.andThen(sql`DROP SCHEMA IF EXISTS ${sql(store)} CASCADE`)
                  ),
                { discard: true }
              )
            ),
            Effect.orDie
          )
        )

        // The model: one queue of events per request, written by the test through `answerTo`.
        const requests: Array<{
          readonly question: string
          readonly events: Queue.Queue<ModelEvent.ModelEvent, Model.ModelFailure | Cause.Done>
        }> = []
        // The agent's task: the last part of its system prompt, the question wrapped with the conversation before it.
        const questionOf = (request: ModelRequest.ModelRequest) => request.system.at(-1)?.text ?? ""
        const model = Model.make({
          stream: (request) =>
            Stream.unwrap(
              Effect.map(Queue.unbounded<ModelEvent.ModelEvent, Model.ModelFailure | Cause.Done>(), (events) => {
                requests.push({ question: questionOf(request), events })
                return Stream.fromQueue(events)
              })
            )
        })

        const spans: Array<Tracer.NativeSpan> = []
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options)
            spans.push(span)
            return span
          }
        })
        const config = ConfigProvider.fromUnknown({
          ...(yield* TestDatabase.fixtureConfig),
          // The deployment's own model answers here, as under `alchemy dev` (decision 0099), so the scripted model does.
          HOSTED_MODEL_ENABLED: "true",
          ALERT_APP_URL: "http://chat.test/app",
          ...(options.forge === "code-storage"
            ? { CODE_STORAGE_ORG: "acme", CODE_STORAGE_KEY: yield* Effect.promise(codeStorageKey) }
            : {})
        })
        // Generated views render in the realm Node compiles (worker/ViewRealm.ts).
        const chat = yield* Chat.make(database, { realm: nodeRealm }).pipe(
          Effect.provide(
            Layer.succeed(
              HostModel,
              HostModel.of({
                modelId: "test-model",
                model,
                // Answering doesn't seal its model calls as durable steps yet, so nothing prepares a request.
                route: { prepare: () => Effect.die(new Error("the scripted model has no route")) }
              })
            )
          ),
          Effect.provideService(ConfigProvider.ConfigProvider, config)
        )

        // Repositories, as ChatApi routes them to RepoApi (worker/ChatApi.ts): this deployment has no Code Storage
        // organization, so a clone answers 503 `not_configured`; the `repositories` shape syncs from this schema.
        // What GitHub says of a repository is kept in this schema's `repo_about`: none kept, as a new Worker's cache.
        yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DELETE FROM repo_about`).pipe(Effect.provide(database))
        const repos = yield* RepoApi.make(database, { codeStorage: Option.none() }).pipe(
          // Its read token comes from `config`; with no `GITHUB_TOKEN` and no App it is none, and nothing is fetched.
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(ConfigProvider.ConfigProvider, config)
        )
        const repoCache = yield* Layer.build(ImmutableCache.layerMemory())
        // Pages' answers, kept for as long as this ChatApi lives (worker/WebPreview.ts).
        const webCache = ImmutableCache.make(ImmutableCache.makeMemoryWebCache(), { backend: "memory" })

        // The git loop, as ChatApi routes it (worker/ChatApi.ts), with a GitHub App configured: no remote host runs
        // here, so a write's `github/Write`, a stale read's `github/Reconcile` and Run triage again's `triage/Run` are
        // recorded in `starts`, never run. A test writes their rows itself, through `github.run`. The routes' own reads
        // (a comparison's files) reach the scripted GitHub as the App.
        const repository = repositoryOf(TEST_REPOSITORY)
        const scripted = scriptedGitHub(repository.owner, repository.name)
        const app = Option.some({
          appId: APP_ID,
          privateKey: yield* Effect.promise(harnessAppKey),
          webhookSecret: Option.none(),
          repository,
          apiBaseUrl: SCRIPTED_API,
        })
        // Who has which role where (decision 0079): the session's on the test repository, the deployment's own.
        const roles = yield* RepoRoles.make(database, { repository, app, http: scripted.http })
        const github = yield* GitHubApi.make(database, { repository, app, roles, http: scripted.http }).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, config),
        )
        // The stack's routes, as ChatApi routes them (worker/ChatApi.ts): no host runs a TODO, so every TODO stays Queued.
        const stack = yield* StackApi.make(database, roles).pipe(Effect.provideService(ConfigProvider.ConfigProvider, config))
        // A repository's home, as ChatApi routes it (worker/ChatApi.ts): the curated homes a test gives, else the real ones.
        const home = HomeApi.make({ roles, ...(options.homes === undefined ? {} : { files: options.homes }) })
        // A repository's docs, as ChatApi routes them (worker/ChatApi.ts): the index its home names, or the curated home
        // a test gives, read from the scripted outside web, the home from what GitHub says of it (RepoApi's about read).
        // A `docs` view reads its page through the same source.
        const docsSettings = yield* DocsSource.settings.pipe(
          Effect.provide(FetchHttpClient.layer), Effect.provideService(ConfigProvider.ConfigProvider, config),
        )
        const docs = DocsApi.make()
        const docsSource = DocsSource.layer(docsSettings, {
          about: repos.about,
          ...(options.homes === undefined ? {} : { homes: options.homes }),
        }).pipe(
          Layer.provide(Layer.merge(FetchHttpClient.layer, Layer.succeedContext(repoCache))),
        )
        const starts: Array<Started> = []
        const recording = Flows.FlowStarter.of({
          start: (flow, { executionId, payload }) =>
            Effect.sync(() => void starts.push({ flow: flow._tag, executionId, payload }))
        })

        // The branch workspace, as ChatApi routes it (worker/ChatApi.ts): branches read from the scripted GitHub, each
        // `terminal/Open` recorded and never run, and a test `TerminalSockets` for the branches' machines.
        const branchGitHub = gitHost()
        const branchForge = codeStorageGit(branchGitHub)
        const branchApi = yield* BranchApi.make(database).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, branchForge.fetch),
          Effect.provideService(ConfigProvider.ConfigProvider, config),
        )
        const sockets = terminalSockets()
        const branchRooms = rooms()
        const directory = Directory.layer(
          database,
          [options.actor ?? member, ...Object.values(options.people ?? {})].flatMap((actor) =>
            actor === null ? [] : [{ id: actor.subject.id, login: actor.login ?? actor.subject.id }]
          )
        )
        const branchStarts: Array<Started> = []
        let refusing = 0
        const branchStarter = Flows.FlowStarter.of({
          start: (flow, { executionId, payload }) =>
            Effect.suspend(() => {
              if (refusing > 0) {
                refusing -= 1
                return Effect.fail(new Flows.StartUnavailable({ errorCode: "no_remote_host" }))
              }
              branchStarts.push({ flow: flow._tag, executionId, payload })
              return Effect.void
            })
        })

        // Electric, as ChatApi calls it: the table in this schema. The forge's reads go to the scripted GitHub, and a page
        // ChatApi checks before it is framed to the scripted outside web.
        const closing = new AbortController()
        const outside = outsideWeb(options.pages ?? {})
        const emptyResolver: typeof globalThis.fetch = async () => Response.json({ Status: 0, Answer: [] })
        const electric: typeof globalThis.fetch = (input, init) => {
          const upstream = new URL(input instanceof Request ? input.url : String(input))
          if (upstream.hostname === "github.com") return branchGitHub.fetch(input, init)
          if (upstream.hostname.endsWith(".code.storage")) return branchForge.fetch(input, init)
          // The `dns` domain provider's resolver: it knows no record, so every domain stays pending.
          if (upstream.hostname === "cloudflare-dns.com") return emptyResolver(input, init)
          // A person's own model's provider.
          if (upstream.origin === OPENAI_ORIGIN || upstream.origin === ANTHROPIC_ORIGIN) return provider.fetch(input, init)
          if (upstream.protocol === "https:") return outside(input, init)
          const table = upstream.searchParams.get("table")
          if (table !== null && SCHEMA_TABLES.has(table)) upstream.searchParams.set("table", `${schema}.${table}`)
          return globalThis.fetch(upstream, {
            ...init,
            signal: init?.signal ? AbortSignal.any([init.signal, closing.signal]) : closing.signal
          })
        }

        // Runs on Cloudflare (worker/RemoteRuns.ts): an engine on a schema named now and made on first use, read by the
        // routes as ChatApi reads the deployed one, read-only. Dropped with the device stores when this ChatApi closes,
        // after the engine's connections.
        const remoteSchema = `flows_${crypto.randomUUID().replaceAll("-", "")}`
        stores.push(remoteSchema)
        const layerScope = yield* Effect.scope
        const remoteGates = new Map<
          string,
          { label: string; ready: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
        >()
        const remoteFibers = new Map<string, Fiber.Fiber<void>>()
        const remoteEngine = yield* Effect.cached(
          buildEngine(Interpreter.layer(Nested, { callbackIdentity: "stable" }).pipe(Layer.provideMerge(Pause.registration((label) => Effect.gen(function* () {
            const gate = [...remoteGates.values()].find((gate) => gate.label === label)
            if (gate !== undefined) {
              yield* Deferred.succeed(gate.ready, undefined)
              yield* Deferred.await(gate.release)
            }
            return label
          })))), { schema: remoteSchema }).pipe(
            Scope.provide(layerScope),
            Effect.orDie
          )
        )
        const remoteWriter = PostgresDatabase.layer({
          url: server,
          driver: Pg,
          schema: remoteSchema,
          postgres: { maxConnections: 1, applicationName: remoteSchema }
        })
        const remoteRuns = yield* RemoteRuns.make(database, {
          database: PostgresDatabase.layer({
            url: server,
            driver: Pg,
            schema: remoteSchema,
            readOnly: true,
            postgres: { maxConnections: 2, applicationName: remoteSchema }
          }),
          writer: remoteWriter,
          schema: remoteSchema,
          flows: [Pause.Pause],
          // What the run's Durable Object does (`ExecutionObject.make`'s `cancel`): the engine's own interrupt of the run.
          stop: (runId) =>
            Effect.gen(function* () {
              const { context } = yield* remoteEngine
              yield* Context.get(context, FlowRuntime.FlowRuntime).interrupt(Pause.Pause, runId).pipe(Effect.provide(context))
            }),
        }, roles).pipe(Effect.provideService(ConfigProvider.ConfigProvider, config))

        // Custom domains, as ChatApi routes them (worker/domains/Api.ts), with `domain/Verify` and `domain/Remove` run
        // for real on an engine of their own, started and not awaited as the Cloudflare host does, and the real `dns`
        // provider over a resolver that knows no record: every domain stays pending, its certificate the host's.
        const domainsSchema = `flows_${crypto.randomUUID().replaceAll("-", "")}`
        stores.push(domainsSchema)
        const domainProvider = yield* DomainsConfig.provider({ dev: true }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
          Effect.orDie,
        )
        const domainEngine = yield* Effect.cached(
          buildEngine(DomainFlows.registration(database, Layer.succeed(DomainProvider, domainProvider)), {
            schema: domainsSchema,
          }).pipe(Scope.provide(layerScope), Effect.orDie),
        )
        const domainStarter = Flows.FlowStarter.of({
          start: (flow, { executionId, payload }) =>
            Effect.flatMap(domainEngine, (engine) =>
              Effect.asVoid(
                Effect.forkIn(
                  (Context.get(engine.context, FlowRuntime.FlowRuntime).execute(flow as never, {
                    executionId,
                    payload: payload as never,
                  }) as Effect.Effect<unknown, unknown>).pipe(Effect.provide(engine.context), Effect.ignore),
                  layerScope,
                ),
              )
            ),
        })
        const domains = yield* DomainsApi.make({ id: repoId(repository.owner, repository.name) }, database).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, config),
        )

        // Repository secrets, as ChatApi routes them (worker/ChatApi.ts), on under TEST_SECRETS_KEY for TEST_REPOSITORY:
        // `secret/Put` and `secret/Delete` run for real on a Node host's engine of their own, built on first use, so a
        // write's row is in Postgres when its request answers, and Electric brings it to the device.
        const secretsApi = yield* SecretsApi.make(repository).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, config),
        )
        const secretEngine = yield* Effect.cached(
          buildEngine(SecretFlows.registration(database), { maxConnections: 2 }).pipe(Scope.provide(layerScope), Effect.orDie),
        )
        const secretStarter = Flows.FlowStarter.of({
          start: (flow, { executionId, payload }) =>
            Effect.gen(function* () {
              const { context } = yield* secretEngine
              const flows = Context.get(context, FlowRuntime.FlowRuntime)
              yield* Effect.ignore(
                (flows.execute(flow as never, { executionId, payload: payload as never }) as Effect.Effect<unknown, unknown>)
                  .pipe(Effect.provide(context)),
              )
            }),
        })

        // A person's own model (worker/personal/Api.ts), on under TEST_SECRETS_KEY: `model/Put` and `model/Delete` run for
        // real on a Node host's engine of their own, built on first use, so a write's row is in Postgres when its request
        // answers, and Electric brings it to the device. The model endpoint opens a person's saved model per request
        // through the same `PersonalModels`; its provider is the scripted one at the network (`options.provider`).
        const personalApi = yield* PersonalApi.make(database).pipe(Effect.provideService(ConfigProvider.ConfigProvider, config))
        const personalModels = PersonalModels.layer(database).pipe(Layer.provide(SecretKeys.layer(TEST_SECRETS_KEY)))
        // Bug reports (worker/bugs/Api.ts): filed into Postgres for real and synced back through Electric; the Admins'
        // `ops/BugReport` start is recorded, never run (worker/flows/BugReport.test.ts runs it).
        const bugsApi = yield* BugsApi.make(database).pipe(Effect.provideService(ConfigProvider.ConfigProvider, config))
        const bugStarts: Array<Started> = []
        const bugStarter = Flows.FlowStarter.of({
          start: (flow, { executionId, payload }) =>
            Effect.sync(() => void bugStarts.push({ flow: flow._tag, executionId, payload })),
        })
        const modelEngine = yield* Effect.cached(
          buildEngine(ModelFlows.registration(database), { maxConnections: 2 }).pipe(Scope.provide(layerScope), Effect.orDie),
        )
        const modelStarter = Flows.FlowStarter.of({
          start: (flow, { executionId, payload }) =>
            Effect.gen(function* () {
              const { context } = yield* modelEngine
              const flows = Context.get(context, FlowRuntime.FlowRuntime)
              yield* Effect.ignore(
                (flows.execute(flow as never, { executionId, payload: payload as never }) as Effect.Effect<unknown, unknown>)
                  .pipe(Effect.provide(context)),
              )
            }),
        })
        const provider = scriptedProvider(options.provider ?? { text: "ok" }, () => {
          throw new Error("the scripted provider answers its own origins only")
        })

        // ChatApi acknowledges an ask only once its answer's expiry started, so the chat routes' host takes every start,
        // as a Durable Object would, and runs none: no answer here lives 25 minutes.
        const expiries = Flows.FlowStarter.of({ start: () => Effect.void })

        // Who a browser is signed in as (`GET /api/auth/session`), from sign-in's own route as `alchemy dev` serves it
        // without the GitHub App (worker/DevChatApi.ts): the request's person as the fallback, or signed out with no actor.
        // No role goes stale without the App, so no role check starts.
        const signInOf = (person: Actor.Actor | null, name?: string) =>
          SignIn.make(database, person === null ? {} : {
            // Session checks and person-authenticated routes read current authority. A snapshot here
            // would re-grant a demoted person's old role on refresh or reload.
            get fallback() {
              const current = (name === undefined ? undefined : people[name]) ?? person
              return { actor: current, login: current.login ?? current.subject.id }
            },
          }).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(ConfigProvider.ConfigProvider, config),
          )
        const signedIn = new Map([[undefined as string | undefined, yield* signInOf(actor)]])
        for (const [name, person] of Object.entries(people)) signedIn.set(name, yield* signInOf(person, name))
        const roleChecks = SignIn.RoleChecks.of({ start: () => Effect.void })

        const routed = Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
          const path = request.url.split("?")[0]!
          if (path === SESSION_ROUTE) {
            const named = request.headers[PERSON_HEADER]
            return signedIn.get(named !== undefined && Object.hasOwn(people, named) ? named : undefined)!.fetch.pipe(
              Effect.provideService(SignIn.RoleChecks, roleChecks),
              Effect.provideService(Flows.FlowStarter, expiries),
            )
          }
          if (BranchApi.handles(path)) {
            return branchApi.fetch.pipe(
              Effect.provideService(Flows.FlowStarter, branchStarter),
              Effect.provideService(TerminalSockets, sockets.service),
              Effect.provideService(Rooms, branchRooms.service),
              Effect.provide(directory),
              Effect.provide(typeof options.forge === "object"
                ? Layer.succeed(Forge, options.forge)
                : options.forge === "code-storage" ? Forge.layerConfig : Forge.gitHub)
            )
          }
          if (DomainsApi.handles(path)) {
            return domains.fetch.pipe(
              Effect.provideService(Flows.FlowStarter, domainStarter),
              Effect.provideService(DomainProvider, domainProvider),
            )
          }
          if (GitHubApi.handles(path)) return github.fetch.pipe(Effect.provideService(Flows.FlowStarter, recording))
          if (StackApi.handles(path)) return stack.fetch
          if (SecretsApi.handles(path)) {
            return secretsApi.fetch.pipe(
              Effect.provideService(Flows.FlowStarter, secretStarter),
              Effect.provide(SecretKeys.layer(TEST_SECRETS_KEY)),
            )
          }
          if (PersonalApi.handles(path)) {
            return personalApi.fetch.pipe(
              Effect.provideService(Flows.FlowStarter, modelStarter),
              Effect.provide(SecretKeys.layer(TEST_SECRETS_KEY)),
              Effect.provide(personalModels),
            )
          }
          if (BugsApi.handles(path)) {
            return bugsApi.fetch.pipe(Effect.provideService(Flows.FlowStarter, bugStarter), Effect.provide(FetchHttpClient.layer))
          }
          if (RemoteRuns.handles(path)) return remoteRuns.fetch
          if (HomeApi.handles(path)) return home.fetch
          if (DocsApi.handles(path)) return docs.fetch.pipe(Effect.provide(docsSource))
          return path === REPOS_ROUTE || path.startsWith(`${REPOS_ROUTE}/`) || path === REPOSITORIES_SHAPE_ROUTE
            ? Effect.provideContext(repos.fetch, repoCache)
            : chat.fetch.pipe(
              Effect.provideService(Flows.FlowStarter, expiries),
              Effect.provide(personalModels),
              Effect.provide(docsSource),
              Effect.provideService(ImmutableCache.ImmutableCache, webCache),
              Effect.provide(credentials)
            )
        })

        const application = routed.pipe(
          // No remote host runs here: every other remote start (a clone) is refused as unavailable.
          Effect.provideService(
            Flows.FlowStarter,
            Flows.FlowStarter.of({
              start: () => Effect.fail(new Flows.StartUnavailable({ errorCode: "no_remote_host" }))
            })
          ),
          Effect.provide(sessions),
          // Who has which role on a branch's repository, as ChatApi provides it (decision 0079).
          Effect.provide(BranchRoles.layer(roles)),
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, electric),
          Effect.provideService(Tracer.Tracer, tracer),
          Effect.provideService(ConfigProvider.ConfigProvider, config)
        )
        // Close admission and drain handlers before dropping their schemas. Abort also closes streamed bodies.
        const active = new Set<Promise<void>>()
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            closing.abort()
            await Promise.all(active)
          })
        )
        const handler = (request: Request): Promise<Response> => {
          if (closing.signal.aborted) return Promise.resolve(new Response(null, { status: 503 }))
          const scoped = new Request(request, { signal: AbortSignal.any([request.signal, closing.signal]) })
          let finished!: () => void
          const done = new Promise<void>((resolve) => {
            finished = resolve
          })
          active.add(done)
          return HttpEffect.toWebHandler(Effect.gen(function*() {
            // Register first so this receipt follows every request resource, including an unread response body.
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                active.delete(done)
                finished()
              })
            )
            return yield* application
          }))(scoped)
        }

        let reloads = 0
        const telemetry: Array<{ path: string; body: string }> = []
        const origin = options.origin ?? CHATAPI_ORIGIN
        const postQuestion = (body: unknown) =>
          handler(
            new Request(`${origin}${QUESTIONS_ROUTE}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body)
            })
          )
        const statuses: Array<number> = []
        // Every other request and its status, for a test that fails waiting: `GET /api/answers/<id> 200`.
        const seen: Array<string> = []
        const fetch: typeof globalThis.fetch = async (input, init) => {
          const request = new Request(input, init)
          const { pathname } = new URL(request.url)
          if (pathname.startsWith(`${TELEMETRY_ROUTE}/`)) {
            telemetry.push({ path: pathname, body: await request.clone().text() })
          }
          const response = await handler(request)
          if (pathname === QUESTIONS_ROUTE) statuses.push(response.status)
          if (!pathname.startsWith(`${TELEMETRY_ROUTE}/`)) seen.push(`${request.method} ${pathname} ${response.status}`)
          return response
        }

        const answerTo = (question: string, nth = 0) =>
          Effect.sync(() =>
            Option.fromUndefinedOr(requests.filter((request) => request.question.includes(question))[nth])
          ).pipe(
            Effect.flatMap(Option.match({ onNone: () => Effect.fail("not asked yet"), onSome: Effect.succeed })),
            // Up to 20 s: the agent asks once its engine leads and its turn comes, later on a loaded machine.
            Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 2_000 }),
            Effect.catch(() =>
              Effect.die(
                new Error(
                  `The model was never asked this question; ${requests.length} model requests. ` +
                    `Requests: ${seen.filter((line) => !line.startsWith("GET /api/shapes/")).join(", ")}`
                )
              )
            ),
            Effect.map(({ events }): Reply => {
              let opened = false
              const delta = (text: string) => void Queue.offerUnsafe(events, { type: "text-delta", id: "t", text })
              // The cell's opening, once: the agent reads the answer from the literal its reply passes to `ctx.done`.
              const open = () => {
                if (!opened) delta("```cell\nctx.done(\"")
                opened = true
              }
              return {
                say: (text) => {
                  open()
                  delta(JSON.stringify(text).slice(1, -1))
                },
                done: () => {
                  open()
                  delta("\")\n```")
                  Queue.offerUnsafe(events, { type: "usage", inputTokens: 10, outputTokens: 20 })
                  Queue.offerUnsafe(events, { type: "settle", stopReason: "stop" })
                  Queue.endUnsafe(events)
                },
                cell: (source) => {
                  delta("```cell\n" + source + "\n```")
                  Queue.offerUnsafe(events, { type: "usage", inputTokens: 10, outputTokens: 20 })
                  Queue.offerUnsafe(events, { type: "settle", stopReason: "stop" })
                  Queue.endUnsafe(events)
                },
                // A refusal, which the agent's model step doesn't retry.
                fail: (error = new ModelError.ModelError({ code: "content_policy", message: "scripted failure" })) =>
                  void Queue.failCauseUnsafe(
                    events,
                    Cause.fail(error)
                  )
              }
            })
          )

        const service = TestChatApi.of({
          origin,
          fetch,
          answerTo,
          modelRequests: (question) => requests.filter((request) => request.question.includes(question)).length,
          answerDiagnostics: (answerId) =>
            Effect.gen(function*() {
              const [answer] = yield* sql<{ readonly status: string; readonly failure: string | null }>`
              SELECT status, failure FROM messages WHERE id = ${answerId}`
              const [report] = yield* sql<{ readonly status: string; readonly waiting: string | null }>`
              SELECT status, waiting FROM runs WHERE id = ${answerId}`
              const engines: Array<AnswerDiagnostics["engines"][number]> = []
              for (const store of stores) {
                const [run] = yield* sql<{ readonly status: string }>`
                SELECT status FROM ${sql(`${store}.flows_runs`)} WHERE run_id = ${answerId}`
                if (run === undefined) continue
                const attempts = yield* sql<{ readonly state: string; readonly count: number }>`
                SELECT state, count(*)::int AS count FROM ${sql(`${store}.flows_attempts`)}
                WHERE run_id = ${answerId} GROUP BY state ORDER BY state`
                const records = yield* sql<{ readonly type: string; readonly count: number }>`
                SELECT event_type AS type, count(*)::int AS count FROM ${sql(`${store}.flows_journal_events`)}
                WHERE run_id = ${answerId} GROUP BY event_type ORDER BY event_type`
                engines.push({ status: run.status, attempts, records })
              }
              return { answer: answer ?? null, report: report ?? null, engines }
            }).pipe(Effect.orDie),
          questionStatuses: () => [...statuses],
          askElsewhere: (text) =>
            Effect.promise(async () => {
              const ids = { questionId: crypto.randomUUID(), answerId: crypto.randomUUID() }
              const response = await postQuestion({ id: ids.questionId, answerId: ids.answerId, text })
              if (response.status !== 202) throw new Error(`ChatApi answered ${response.status}`)
              return ids
            }),
          rows: sql<{ id: string; text: string; position: bigint }>`
            select id, text, position from ${sql(`${schema}.${MESSAGES_TABLE}`)} order by position`.pipe(
            Effect.map((rows) => rows.map((row) => ({ ...row, position: Number(row.position) }))),
            Effect.orDie
          ),
          telemetry,
          spans,
          providerCalls: provider.seen,
          reload: () => {
            reloads += 1
          },
          reloads: () => reloads,
          engineStore: () => {
            const store = `flows_${crypto.randomUUID().replaceAll("-", "")}`
            stores.push(store)
            return { url: server, schema: store, keep: (leader) => void leaders.push(leader) }
          },
          bugs: { starts: bugStarts },
          github: {
            starts,
            run: (effect) => effect.pipe(Effect.provide(database), Effect.orDie),
            scripted
          },
          branches: {
            forge: branchForge,
            github: branchGitHub,
            starts: branchStarts,
            sockets,
            rooms: branchRooms,
            refuseStarts: (count) => {
              refusing = count
            },
            run: (effect) => effect.pipe(Effect.provide(database), Effect.orDie)
          },
          remote: {
            ready: (runId) => Deferred.await(remoteGates.get(runId)!.ready),
            release: (runId) => Deferred.succeed(remoteGates.get(runId)!.release, undefined).pipe(Effect.asVoid),
            settled: (runId) => Fiber.join(remoteFibers.get(runId)!),
            revision: (runId) =>
              Effect.gen(function*() {
                yield* remoteEngine
                return yield* sql<{ revision: string }>`
                SELECT revision FROM ${sql(remoteSchema)}.flows_run_changes WHERE run_id = ${runId}`.pipe(
                  Effect.map((rows) => Number(rows[0]!.revision)),
                  Effect.orDie
                )
              }),
            prepareProgress: (runId) =>
              Effect.gen(function*() {
                yield* remoteEngine
                const engineSql = yield* SqlClient.SqlClient
                // Run the write with the engine's search_path: its triggers resolve their own tables there.
                // Let the tab consume this eligibility change before requiring a new journal-driven revision.
                yield* engineSql`UPDATE flows_runs SET progress_at_ms = 1 WHERE run_id = ${runId}`
                return yield* engineSql<
                  { revision: string }
                >`SELECT revision FROM flows_run_changes WHERE run_id = ${runId}`.pipe(
                  Effect.map((rows) => Number(rows[0]!.revision))
                )
              }).pipe(Effect.provide(remoteWriter), Effect.orDie),
            progress: (runId) =>
              Effect.gen(function*() {
                const { context } = yield* remoteEngine
                const journal = Context.get(context, FlowJournal.Journal.Journal)
                yield* journal.emitLossy(
                  new FlowJournal.JournalEvent.Input({
                    runId: FlowJournal.JournalEvent.RunId.make(runId),
                    sourceId: FlowJournal.JournalEvent.SourceId.make("agent/trail"),
                    eventType: "agent.turn",
                    payload: {}
                  })
                )
                yield* journal.flush
                return yield* sql<{ progress_at_ms: number }>`SELECT progress_at_ms
                FROM ${sql(remoteSchema)}.flows_runs WHERE run_id = ${runId}`.pipe(
                  Effect.map((rows) => Number(rows[0]!.progress_at_ms))
                )
              }).pipe(Effect.orDie),
            todoRun: (title) =>
              Effect.gen(function*() {
                yield* remoteEngine
                const applied = yield* Stack.apply({
                  opId: crypto.randomUUID(),
                  repoId: `github/${TEST_REPOSITORY}`,
                  actor: { id: (actor ?? member).subject.id, login: (actor ?? member).login ?? "maya" },
                  via: "person",
                  op: { kind: "commit", title, prompt: title, acceptance: [] }
                }, { runs: true }).pipe(Effect.provide(database), Effect.orDie)
                return applied.kind === "applied" ? todoExecutionId(applied.receipt.starts[0]!.attemptId) : ""
              }),
            repoRun: (flow) =>
              Effect.gen(function* () {
                yield* remoteEngine
                const execution = `${flow}:${crypto.randomUUID()}`
                yield* RepoRuns.record({
                  execution,
                  repoId: `github/${TEST_REPOSITORY}`,
                  flow,
                  sha: "d".repeat(40),
                  ref: "main",
                  event: "push",
                  launchedBy: "github",
                }).pipe(Effect.provide(database), Effect.orDie)
                return execution
              }),
            status: (runId) =>
              sql<{ status: string }>`SELECT status FROM ${sql(remoteSchema)}.flows_runs WHERE run_id = ${runId}`.pipe(
                Effect.map((rows) => rows[0]?.status),
                Effect.orDie,
              ),
            start: (runId, payload) =>
              Effect.gen(function*() {
                const { context } = yield* remoteEngine
                const flows = Context.get(context, FlowRuntime.FlowRuntime)
                const flow = payload.nested === true ? Nested : Pause.Pause
                if (payload.hold) {
                  const gate = {
                    label: `${payload.label}:after`,
                    ready: yield* Deferred.make<void>(),
                    release: yield* Deferred.make<void>()
                  }
                  remoteGates.set(runId, gate)
                  yield* Scope.addFinalizer(layerScope, Deferred.succeed(gate.release, undefined))
                }
                const fiber = yield* Effect.forkIn(
                  Effect.ignore(flows.execute(flow, {
                    executionId: runId, payload: { label: payload.label, pauseMs: payload.pauseMs },
                  }).pipe(Effect.provide(context))),
                  layerScope,
                )
                remoteFibers.set(runId, fiber)
              })
          }
        })
        return service
      })
    )

  /** ChatApi on a scratch schema, every request signed in as a Member. */
  static readonly layer = TestChatApi.layerWith({})
}

/**
 * `api` as person `name` of `ChatApiOptions.people` reaches it: the same ChatApi, its `fetch` signing every request in
 * as them. A device opened on it is theirs, its engine's requests included.
 */
export const asPerson = (api: TestChatApi["Service"], name: string): TestChatApi["Service"] => ({
  ...api,
  fetch: (input, init) => {
    const request = new Request(input, init)
    request.headers.set(PERSON_HEADER, name)
    return api.fetch(request)
  }
})

// Each tab counts into its own registry, so one test's metrics never leak into another's.
const ownMetrics = () => Layer.succeed(Metric.MetricRegistry, new Map())

/**
 * What `nodeDevice` adds to a `Host`: what its device stored, what its theme painted, what it copied, and where its tabs
 * went.
 */
export interface NodeDevice extends Host {
  /** How many rows the device's SQLite file holds for `collection`. */
  readonly stored: (collection: string) => number
  /** The rows actually committed to SQLite, for a reload test's persistence barrier. */
  readonly storedRows: (collection: string) => ReadonlyArray<unknown>
  /** Every mode the theme painted on this device's page, in order. */
  readonly painted: ReadonlyArray<ThemeMode | undefined>
  /** Every text written to this device's clipboard, in order. */
  readonly copied: ReadonlyArray<string>
  /** Every path this device's tabs navigated to, in order. */
  readonly navigated: ReadonlyArray<string>
  /**
   * The device as one busy tab of it sees it: that tab's coordinator hands the device store each transaction it
   * committed `busy.ms` late (read at each one), as a tab whose main thread is busy does, and counts those not handed
   * over yet in `busy.inFlight`.
   */
  readonly busyTab: (busy: Busy) => NodeDevice
}

/** How late a busy tab hands the device store what it committed, and how many it holds now. */
export interface Busy {
  ms: number
  inFlight: number
}

// TanStack DB's coordinator between a device's tabs, handing the device store what this tab committed `busy.ms` late.
class LateCoordinator extends BrowserCollectionCoordinator {
  readonly busy: Busy
  constructor(dbName: string, busy: Busy) {
    super({ dbName })
    this.busy = busy
  }
  override async requestApplyCommittedTx(...args: Parameters<BrowserCollectionCoordinator["requestApplyCommittedTx"]>) {
    this.busy.inFlight++
    try {
      if (this.busy.ms > 0) await new Promise((resume) => setTimeout(resume, this.busy.ms))
      return await super.requestApplyCommittedTx(...args)
    } finally {
      this.busy.inFlight--
    }
  }
}

/** A device's own overrides of the host, and `agent`: the ChatApi whose questions its engine answers. */
export type DeviceOptions = Partial<Host> & {
  /**
   * Runs the device's engine as the browser does: each tab's worker a leader in waiting over every client flow, the
   * agent among them, reaching ChatApi `agent` through its `fetch`. Without it, no tab's worker ever leads, so nothing
   * this device dispatches runs.
   */
  readonly agent?: TestChatApi["Service"]
  /** The device's SQLite file, such as one an older build's store was written to; a new one unless set. */
  readonly file?: string
  /** The device's outbox storage, such as one holding an older build's writes; empty unless set. */
  readonly outboxEntries?: Map<string, string>
}

/**
 * An engine worker whose module fails to load: it reports an error it didn't catch, once its tab listens, so the tab
 * has no engine, for good. The shape the tab's engine expects: a Worker's.
 */
export const failingWorker = (): BrowserEngine.WorkerLike & Endpoint =>
  ({
    postMessage: () => {},
    addEventListener: (type: string, listener: (event: ErrorEvent) => void) =>
      void (type === "error" && queueMicrotask(() => listener({} as ErrorEvent))),
    removeEventListener: () => {},
    terminate: () => {}
  }) as never

/** An engine worker that never leads: what a tab dispatches waits until its scope closes. */
export const idleWorker = (): BrowserEngine.WorkerLike & Endpoint => ({
  terminate: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  postMessage: () => {}
})

/**
 * Starts a tab's engine worker in Node, as src/flows/engine.worker.ts does in a browser: `BrowserRuntime.serve` over
 * every client flow, leading once it holds the engine's Web Lock, its store on the device's Postgres schema in place
 * of SQLite on OPFS, and its HTTP through ChatApi's `fetch`. The worker is a `MessageChannel`: the leader reaches its
 * tab through one port (`TabPort`), and the tab answers on the other. Terminating it stops its leader.
 */
const leaderWorker = (api: TestChatApi["Service"], name: string, store: EngineStore) => () => {
  const channel = new MessageChannel()
  channel.port1.start()
  channel.port2.start()
  const http = Layer.provide(FetchHttpClient.layer, Layer.succeed(FetchHttpClient.Fetch, api.fetch))
  const engine = BrowserRuntime.layer(
    // The flows' own schemas render their runs' values for the run page (decision 0014 §3), as the worker's do.
    { name, flows: clientFlows },
    workerRegistrations(channel.port1, { origin: api.origin, name, partsEvery: "20 millis" }).pipe(Layer.provide(http))
  ).pipe(
    Layer.provide(
      PostgresDatabase.layer({
        url: store.url,
        driver: Pg,
        schema: store.schema,
        postgres: { applicationName: store.schema }
      })
    )
  )
  const leader = Effect.runFork(
    BrowserRuntime.serve({ name, flows: clientFlows }, engine).pipe(
      Effect.provide(Layer.mergeAll(WebLock.layer, TabChannel.layer)),
      // The engine's own log lines stay out of the test's output.
      Effect.provideService(Logger.CurrentLoggers, new Set())
    )
  )
  store.keep(leader)
  return {
    postMessage: (message: unknown) => channel.port2.postMessage(message),
    addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      if (type === "message") channel.port2.addEventListener("message", listener)
    },
    removeEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      if (type === "message") channel.port2.removeEventListener("message", listener)
    },
    terminate: () => {
      Effect.runFork(Fiber.interrupt(leader))
      channel.port1.close()
      channel.port2.close()
    }
  } as BrowserEngine.WorkerLike & Endpoint
}

/**
 * A device in Node, as main.tsx's host is a browser's: its store is a SQLite file through TanStack DB's own browser
 * persistence (node:sqlite in place of OPFS), its outbox's storage a map in memory (in place of IndexedDB), led
 * through @smthrs/platform-browser's Web Lock service over Node's own Web Locks, and always online. Its theme paints
 * into `painted`, and the system is light; its clipboard keeps what is copied in `copied`, and its tabs' navigations go to `navigated`. Its engine has a name of its own; its tabs' workers never lead unless the
 * device runs its `agent`. A tab opened again on the same device is a reload: it restores what the last one stored.
 * Each device has its own locks, as each browser has its own Web Locks.
 */
export const nodeDevice = ({ agent, file, outboxEntries, ...overrides }: DeviceOptions = {}): NodeDevice => {
  const path = file ?? join(tempDirectory("mvp-device-"), "device.sqlite")
  const entries = outboxEntries ?? new Map<string, string>()
  const storage = {
    get: async (key: string) => entries.get(key) ?? null,
    set: async (key: string, value: string) => void entries.set(key, value),
    delete: async (key: string) => void entries.delete(key),
    keys: async () => [...entries.keys()],
    clear: async () => entries.clear()
  }
  const device = `mvp-device-${crypto.randomUUID()}`
  const locks = navigator.locks
  const painted: Array<ThemeMode | undefined> = []
  const copied: Array<string> = []
  const navigated: Array<string> = []
  const engineName = `${device}-engine`
  const editorTabId = crypto.randomUUID()
  const turn = deviceTurn()
  const host: Omit<NodeDevice, "busyTab"> = {
    editorTabId,
    editorTabPersistent: true,
    // As main.tsx's: one database per device, shared by its tabs through TanStack DB's coordinator, which Node runs on
    // its own Web Locks and BroadcastChannel.
    persistence: {
      open: () => sqliteFile(path, turn),
      make: (database, coordinator) =>
        createBrowserWASQLitePersistence({ database, ...(coordinator ? { coordinator } : {}) }),
      coordinator: () => new BrowserCollectionCoordinator({ dbName: device })
    },
    outbox: {
      start: startOfflineExecutor,
      storage,
      get online() {
        return Outbox.Online.always()
      }
    },
    // One browser's Web Locks: this device's lock names, apart from every other device's in this process.
    lock: WebLock.make({ request: (name, options, callback) => locks.request(`${device}/${name}`, options, callback) }),
    isOnline: () => true,
    storage: StoragePersistence.make({ persist: () => Promise.resolve(true) }),
    theme: {
      paint: (mode) => void painted.push(mode),
      mirror: () => {},
      system: () => "light",
      painted: () => painted.at(-1)
    },
    clipboard: async (text) => void copied.push(text),
    navigate: (path) => void navigated.push(path),
    // No router runs here: a test that opens a branch offline gives its own (`TabOptions.reopenRoute`).
    reopenRoute: () => {},
    // No person's click or key reaches a test device, so no tab opens from one; a test of the gesture gives its own.
    web: { policy: { localHttp: false, appOrigin: CHATAPI_ORIGIN }, openTab: () => false },
    engineWorker: agent === undefined ? idleWorker : leaderWorker(agent, engineName, agent.engineStore()),
    engineName,
    // Sign-out's wipe: the device's SQLite file goes, and its outbox empties. The browser's reloads and deletes its
    // databases at the next boot; a tab here keeps any connection it holds open, so `stored` reads the new, empty file.
    wipe: async () => {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${path}${suffix}`, { force: true })
      entries.clear()
    },
    ...overrides,
    stored: (collection) => storedRows(path, collection),
    storedRows: (collection) => storedValues(path, collection),
    painted,
    copied,
    navigated
  }
  const busyTab = (busy: Busy): NodeDevice => ({
    ...made,
    persistence: { ...made.persistence, coordinator: () => new LateCoordinator(device, busy) }
  })
  const made: NodeDevice = { ...host, busyTab }
  return made
}

/**
 * How many rows the device's SQLite file holds for `collection`, read on a connection of its own. A synced row is
 * stored a moment after it shows, so a test that reloads waits for this first.
 */
const storedRows = (path: string, collection: string): number => {
  const database = new DatabaseSync(path)
  try {
    const registered = database
      .prepare("select name from sqlite_master where type = 'table' and name = 'collection_registry'")
      .get()
    if (registered === undefined) return 0
    const row = database.prepare("select table_name from collection_registry where collection_id = ?").get(
      collection
    ) as
      | { table_name: string }
      | undefined
    if (row === undefined) return 0
    return Number((database.prepare(`select count(*) as n from "${row.table_name}"`).get() as { n: number }).n)
  } finally {
    database.close()
  }
}

/** Real SQLite values, read through a second connection after a write is durable. */
const storedValues = (path: string, collection: string): ReadonlyArray<unknown> => {
  const database = new DatabaseSync(path)
  try {
    const row = database.prepare("select table_name from collection_registry where collection_id = ?").get(collection) as
      | { table_name: string }
      | undefined
    if (row === undefined) return []
    return (database.prepare(`select value from "${row.table_name}"`).all() as Array<{ value: string }>).map((value) => JSON.parse(value.value))
  } finally {
    database.close()
  }
}

/**
 * One device's turn at its SQLite file, as a browser's tabs take turns at `SharedSqlite`'s leader: one statement at a
 * time, and a transaction a tab opens is the tab's alone until a statement ends it; another tab's statement waits. Without
 * it, two tabs' transactions on one file can deadlock, and SQLite answers one `database is locked` at once.
 */
const deviceTurn = () => {
  let holder: object | undefined
  let waiting: Array<() => void> = []
  return {
    take: async (tab: object) => {
      while (holder !== undefined && holder !== tab) await new Promise<void>((resume) => waiting.push(resume))
      holder = tab
    },
    give: (tab: object) => {
      if (holder !== tab) return
      holder = undefined
      const resumed = waiting
      waiting = []
      for (const resume of resumed) resume()
    }
  }
}

/**
 * A SQLite file in Node, as TanStack DB's browser persistence reads a database: each tab opens its own connection, and
 * takes the device's `turn` for each statement, holding it while its transaction is open.
 */
const sqliteFile = (path: string, turn: ReturnType<typeof deviceTurn>) => {
  const database = new DatabaseSync(path, { timeout: 5_000 })
  const tab = {}
  return {
    execute: async <T>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<T>> => {
      await turn.take(tab)
      try {
        const statement = database.prepare(sql)
        if (statement.columns().length > 0) return statement.all(...(params as Array<SQLInputValue>)) as Array<T>
        statement.run(...(params as Array<SQLInputValue>))
        return []
      } finally {
        if (!database.isTransaction) turn.give(tab)
      }
    },
    close: () => {
      database.close()
      turn.give(tab)
    }
  }
}

/**
 * A tab's deadlines, sync policy, page size and device (`AppOptions`). Without `host`, a device of its own, which runs
 * its agent (`nodeDevice`'s `agent`), as a browser's leading engine worker does, unless `answers` is `false`: then its
 * engine never leads, so a question it sends waits for a run to be recorded and nothing after it is sent.
 */
export type TabOptions = Partial<Omit<AppOptions, "origin" | "reload" | "fetch">> & {
  readonly shapeFailures?: number
  readonly answers?: boolean
  /** View-only fixtures start sign-in here; boot-program fixtures bind it on their actual event target instead. */
  readonly sessionLifecycle?: boolean
  /** The WebSocket a tab's rooms dial, in place of the global one: a room host on loopback (src/test/rooms.ts). */
  readonly webSocket?: Socket.WebSocketConstructor["Service"]
  /** The default device's `reopenRoute`: what opening the tab's route again does; nothing unless set. */
  readonly reopenRoute?: () => void
  /**
   * A client in place of the real one, for an unhappy path: a faulty `IssuesClient`, `StackClient`, `TextsClient`,
   * `PullsClient`, `SecretsClient`, `PersonalModelClient` or a ShapeSource reference (test.faults-by-injection).
   */
  readonly replace?:
    | Layer.Layer<IssuesClient, never, HttpClient.HttpClient>
    | Layer.Layer<SecretsClient, never, HttpClient.HttpClient>
    | Layer.Layer<PersonalModelClient, never, HttpClient.HttpClient>
    | Layer.Layer<PullsClient, never, HttpClient.HttpClient>
    | Layer.Layer<StackClient, never, HttpClient.HttpClient>
    | Layer.Layer<TextsClient, never, HttpClient.HttpClient>
    | Layer.Layer<never, never, HttpClient.HttpClient>
}

/** The scripted GitHub App's key: one per test file, since making an RSA key takes a while. */
let appKeyMade: Promise<Redacted.Redacted<string>> | undefined
const harnessAppKey = () => (appKeyMade ??= appKey())

/** Switches a faulty tab throws on its shape source before it syncs. */
export type StartFaults = (switches: ShapeSource.Switches) => Effect.Effect<void>

const app = (
  api: TestChatApi["Service"],
  {
    answers,
    host,
    reopenRoute,
    replace: _replace,
    webSocket: _webSocket,
    sessionLifecycle: _sessionLifecycle,
    shapeFailures: _shapeFailures,
    ...options
  }: TabOptions
): AppOptions => ({
  ...options,
  origin: api.origin,
  fetch: api.fetch,
  reload: api.reload,
  host: host ??
    nodeDevice({ ...(answers === false ? {} : { agent: api }), ...(reopenRoute === undefined ? {} : { reopenRoute }) })
})

// Real browser tabs have separate JavaScript module state. Node fixtures need an explicit realm for
// Electric's URL-keyed replay caches, while requests, navigation and workers retain the same real origin.
const isolateShapes = Layer.effect(ShapeSource.ShapeSource, Effect.map(ShapeSource.ShapeSource, (source) => ({
  ...source,
  cacheNamespace: crypto.randomUUID(),
})))

/** The browser app on `api` (`appLayer`, as main.tsx's `start` builds it), with the real services. */
export const tabLayer = (api: TestChatApi["Service"], options: TabOptions = {}) => {
  const tab = app(api, options)
  const layer = appLayer(tab, isolateShapes.pipe(Layer.provideMerge(Layer.merge(realServices(tab), options.replace ?? Layer.empty))))
  const started = options.sessionLifecycle === false
    ? layer
    : Layer.effectDiscard(bindSessionConnectivity(new EventTarget())).pipe(Layer.provideMerge(layer))
  return options.webSocket === undefined
    ? started
    : started.pipe(Layer.provide(Layer.succeed(Socket.WebSocketConstructor, options.webSocket)))
}

/** The browser app on `api` with the faulty services and their switches (src/test/faults.ts). */
export const faultyTabLayer = (api: TestChatApi["Service"], options: TabOptions = {}, start?: StartFaults) => {
  const tab = app(api, options)
  const layer = appLayer(tab, isolateShapes.pipe(Layer.provideMerge(faultyServices(tab, start, options.shapeFailures))))
  const started = options.sessionLifecycle === false
    ? layer
    : Layer.effectDiscard(bindSessionConnectivity(new EventTarget())).pipe(Layer.provideMerge(layer))
  return options.webSocket === undefined
    ? started
    : started.pipe(Layer.provide(Layer.succeed(Socket.WebSocketConstructor, options.webSocket)))
}

const withChatApi = <A, E>(tab: (api: TestChatApi["Service"]) => Layer.Layer<A, E>, chatApi: ChatApiOptions) =>
  Layer.unwrap(Effect.map(TestChatApi, tab)).pipe(
    Layer.provideMerge(TestChatApi.layerWith(chatApi)),
    Layer.provideMerge(TestDatabase.layer("test_chat")),
    Layer.provideMerge(ownMetrics())
  )

/**
 * The browser app over a fresh ChatApi (`chatApi`: signed in as a Member unless set), on its own runtime. Dispose the
 * runtime to close everything; the browser's OTLP exporter flushes then.
 */
export const openTestApp = (options: TabOptions = {}, chatApi: ChatApiOptions = {}) =>
  ManagedRuntime.make(withChatApi((api) => tabLayer(api, options), chatApi))

/** The same with the faulty services, for a test of an unhappy path. */
export const openFaultyApp = (options: TabOptions = {}, start?: StartFaults, chatApi: ChatApiOptions = {}) =>
  ManagedRuntime.make(withChatApi((api) => faultyTabLayer(api, options, start), chatApi))

/** Another tab, or device, on the same ChatApi. Dispose it before the runtime that holds the ChatApi. */
export const openTab = (api: TestChatApi["Service"], options: TabOptions = {}) =>
  ManagedRuntime.make(tabLayer(api, options).pipe(Layer.provideMerge(ownMetrics())))

/** Another tab with the faulty services. */
export const openFaultyTab = (api: TestChatApi["Service"], options: TabOptions = {}, start?: StartFaults) =>
  ManagedRuntime.make(faultyTabLayer(api, options, start).pipe(Layer.provideMerge(ownMetrics())))
