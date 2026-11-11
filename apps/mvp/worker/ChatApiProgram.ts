import { GitHub } from "@smthrs/integrations"
import * as AuthBroker from "./AuthBroker.vibe"
import * as GitHubConnection from "./GitHubConnection.vibe"
import * as GitHubConnectionsPage from "./GitHubConnectionsPage.vibe"
import * as PublicReads from "./PublicReads.vibe"
import { withRequestRay } from "./RequestRay.ts"
// ChatApi's program (worker/ChatApi.ts): everything ChatApi serves and hosts. worker/ChatApi.ts loads this module when
// the Worker first builds its program, not when Cloudflare starts the Worker, so its modules are evaluated then and
// count against the first request's CPU instead of the Worker's startup limit (docs/infrastructure.md#limits).
import * as Cloudflare from "@alchemy.run/cloudflare"
import { HostModel } from "@smthrs/model-host"
import { Logger } from "@smthrs/observability"
import { EdgeCache } from "@smthrs/platform-cloudflare"
import { CiJob } from "@smthrs/sandbox"
import { RuntimeContext } from "alchemy"
import * as Output from "alchemy/Output"
import { Cause, Effect, Layer, Option, Predicate, Redacted } from "effect"
import { FetchHttpClient, HttpClient, HttpServerRequest } from "effect/http"
import { HttpServerResponse } from "effect/http"
import type { SqlClient } from "effect/sql"
import * as Database from "../db/Database.ts"
import * as Electric from "../infra/Electric.ts"
import * as ElectricUpstream from "../infra/ElectricUpstream.ts"
import * as SecretsInfra from "../infra/Secrets.ts"
import * as SignInSecret from "../infra/SignIn.ts"
import { AUTH_ROUTE } from "../src/features/auth/contract.ts"
import { REPOS_ROUTE, REPOSITORIES_SHAPE_ROUTE } from "../src/features/repo/contract.ts"
import * as AgentSandbox from "./AgentSandbox.ts"
import * as Asks from "./Asks.ts"
import { BranchRoles } from "./branch/Access.ts"
import * as BranchApi from "./branch/BranchApi.ts"
import * as Conversations from "./branch/Conversations.ts"
import { Forge } from "./branch/Forge.ts"
import * as JobMachines from "./branch/JobMachines.ts"
import { Directory } from "./branch/People.ts"
import { TerminalSockets } from "./branch/Sandboxes.ts"
import * as BranchRooms from "./BranchRooms.ts"
import * as BranchSandboxes from "./BranchSandboxes.ts"
import * as BugsApi from "./bugs/Api.ts"
import * as Chat from "./Chat.ts"
import * as Dispatch from "./ci/Dispatch.ts"
import * as RepoFlow from "./ci/RepoFlow.ts"
import * as RunsApi from "./ci/RunsApi.ts"
import * as DatabaseRoutes from "./DatabaseRoutes.ts"
import * as DocsApi from "./docs/Api.ts"
import * as DocsSource from "./docs/Source.ts"
import * as DomainsApi from "./domains/Api.ts"
import * as DomainsConfig from "./domains/Config.ts"
import { DomainProvider } from "./domains/Provider.ts"
import { codeOf } from "./ErrorCode.ts"
import * as ExecutionHost from "./ExecutionHost.ts"
import * as Executions from "./Executions.ts"
import * as FeedsApi from "./feeds/Api.ts"
import * as Flows from "./Flows.ts"
import { recheckExecutionId, RecheckRole } from "./flows/RecheckRole.ts"
import * as RedactFeed from "./flows/RedactFeed.ts"
import * as Todo from "./flows/Todo.ts"
import * as TodoSession from "./flows/TodoSession.ts"
import * as GitHubApi from "./github/Api.ts"
import * as GitHubConfig from "./github/Config.ts"
import * as FirstPaint from "./github/FirstPaint.ts"
import * as RepoRoles from "./github/RepoRoles.ts"
import * as HomeApi from "./home/Api.ts"
import { DEFAULT_CHAT_MODEL } from "./ModelRoles.ts"
import * as PersonalApi from "./personal/Api.ts"
import { PersonalModels } from "./personal/Models.ts"
import * as Placement from "./Placement.ts"
import * as RemoteRuns from "./RemoteRuns.ts"
import * as RepoApi from "./RepoApi.ts"
import * as RepoConfig from "./RepoConfig.ts"
import * as RequestBackground from "./RequestBackground.ts"
import * as RunContent from "./RunContent.ts"
import * as RunnerAdmin from "./runners/Admin.ts"
import * as RunnersApi from "./runners/Api.ts"
import * as RunnerAudit from "./runners/Audit.ts"
import * as FleetApi from "./runners/FleetApi.ts"
import * as GitCredential from "./runners/GitCredential.ts"
import * as SecretsApi from "./secrets/Api.ts"
import { SecretKeys } from "./secrets/Keys.ts"
import * as SignIn from "./SignIn.ts"
import * as SocketAccess from "./SocketAccess.ts"
import * as SocketChecks from "./SocketChecks.ts"
import * as StackApi from "./stack/Api.ts"
import * as IssueRead from "./stack/IssueRead.ts"
import * as Stack from "./stack/Stack.ts"
import * as TodoRuns from "./stack/TodoRuns.ts"
import * as Throttle from "./Throttle.ts"
import * as ViewRealm from "./ViewRealm.ts"

/**
 * Postgres, through Hyperdrive. Its origin is `DATABASE_URL`; under `alchemy dev` the binding passes straight
 * through to the same database (the compose Postgres by default). Hyperdrive's query cache is off: an answer's
 * history must see the latest writes.
 */
const connection = (name: "ChatDatabase" | "EngineDatabase") =>
  Effect.gen(function*() {
    const { origin, sslmode } = Database.hyperdrive(yield* Database.url)
    return yield* Cloudflare.Hyperdrive.Connection(name, {
      origin,
      caching: { disabled: true },
      dev: { ...origin, sslmode }
    })
  })

/** The request path's config: ChatApi's requests read sessions, roles, repositories and shape access through it. */
const ChatDatabase = connection("ChatDatabase")

/**
 * The durable engine's config: every `FlowExecution` alarm and call, about 95% of the queries, so an engine burst
 * queues behind its own origin connections and never the request path's (infra/Connections.ts `CONNECTION_BUDGET`,
 * decision 0150).
 */
const EngineDatabase = connection("EngineDatabase")

/** The configs by pool: each consumer's is `DatabaseRoutes.route(pools, consumer)` (worker/DatabaseRoutes.ts). */
const pools = { request: ChatDatabase, engine: EngineDatabase } as const

/**
 * ChatApi's program. Who is asking comes from sign-in (`worker/SignIn.ts`); `fallback` is who is signed in while the
 * GitHub App isn't configured: nobody in production (below), a local developer under `alchemy dev`
 * (`worker/DevChatApi.ts`). The model endpoint refuses a call with no actor. `localHttp`, which only `alchemy dev` sets,
 * keeps links to `http:` pages on `localhost` (`WEB_PAGES_LOCAL_HTTP`'s default, worker/Views.ts). `spendAlerts`,
 * which only `alchemy dev` sets, to `false`, is `MODEL_SPEND_ALERTS`' default: a deploy alerts on any model spend
 * unless its environment says otherwise (docs/features/spend-alerts.md). `dev`, which only `alchemy dev` sets, lets an
 * alert provider pointed at a local fake send without its key (docs/features/spend-alerts.md#channels). `hostedModel`,
 * which only `alchemy dev` sets, to `true`, is `HOSTED_MODEL_ENABLED`'s default: a deploy answers only with people's
 * own models unless its environment or an Admin turns the deployment's model on (decision 0099). `localRoles`, which only
 * `alchemy dev` sets, are its people's roles on other repositories while the App isn't configured
 * (`RepoRoles.LocalRoles`). `feedKey`, which only `alchemy dev` sets, is a feed key accepted for every repository while
 * `FEED_KEYS` is unset (worker/feeds/dev.ts, docs/features/feeds.md#development). `askToken`, which only `alchemy dev`
 * sets, is a machine token that may ask a person on every repository (worker/AsksDev.ts,
 * docs/features/agent-status.md#development).
 */
export interface ProgramOptions {
  readonly fallback?: SignIn.Signed
  readonly teammates?: Readonly<Record<string, SignIn.Signed>>
  readonly newcomer?: (name: string) => SignIn.Signed | undefined
  readonly localRoles?: RepoRoles.LocalRoles
  readonly localHttp?: boolean
  readonly spendAlerts?: boolean
  readonly dev?: boolean
  readonly hostedModel?: boolean
  /** `Chat.make`'s: the summaries' daily cap when `TIMELINE_SUMMARY_DAILY_CAP` is unset. Only `alchemy dev` sets it. */
  readonly summaryDailyCap?: number
  readonly feedKey?: string
  readonly askToken?: string
  /**
   * Local development's synced repository and its one open issue (`GitHubApi.Options.localSynced`). Only `alchemy dev`
   * sets it, and it counts only in local development: a signed-in `fallback` and no GitHub App.
   */
  readonly localSynced?: GitHubApi.LocalSynced
  /**
   * A test deployment's own route, answered before ChatApi's (e2e/gates/Harness.ts): given the flow executions' namespace
   * and the app's database, it answers a request or passes it on. No deploy of ChatApi itself sets it.
   */
  readonly door?: (
    services: Door
  ) => Effect.Effect<
    Option.Option<HttpServerResponse.HttpServerResponse>,
    never,
    HttpServerRequest.HttpServerRequest | RuntimeContext
  >
}

/** What a test deployment's `door` reaches: the flow executions' objects and the app's database. */
export interface Door {
  readonly executions: Executions.Objects
  readonly database: Layer.Layer<SqlClient.SqlClient, unknown, RuntimeContext>
}

export const program = (options: ProgramOptions = {}) =>
  Effect.gen(function*() {
    const repoFlows = yield* Dispatch.enabled
    const repositories = yield* Dispatch.repositories
    const homeRepository = yield* Conversations.configuredHomeRepositoryNames
    // The job machines the deployment declared beside the default one (docs/features/ci.md#machines).
    const machines = yield* JobMachines.declared.pipe(Effect.orDie)
    return yield* configuredProgram(options, { repoFlows, repositories, homeRepository, machines })
  })

/** All deployment choices below are already captured before Alchemy builds the handlers. */
/** How the socket hosts' rechecks read roles in local development, as `RepoRoles` does here (worker/SocketChecks.ts). */
const socketChecks = (options: ProgramOptions): SocketChecks.Options => ({
  local: options.fallback !== undefined,
  ...(options.localRoles === undefined ? {} : { localRoles: options.localRoles })
})

const configuredProgram = (options: ProgramOptions, { repoFlows, repositories, homeRepository, machines }: {
  readonly repoFlows: boolean
  readonly repositories: ReadonlySet<string>
  readonly homeRepository: { readonly owner: string; readonly name: string }
  readonly machines: ReadonlyArray<string>
}) =>
  Effect.gen(function*() {
    yield* Electric.bind
    yield* SignInSecret.bind
    yield* SecretsInfra.bind
    // The configs `ops/DatabaseLoad` watches for saturated pools (worker/HyperdrivePool.ts, decision 0150).
    const configs = Output.all((yield* ChatDatabase).hyperdriveId, (yield* EngineDatabase).hyperdriveId)
    yield* Output.named(Output.map(configs, (ids) => ids.join(",")), "HYPERDRIVE_CONFIG_IDS")
    // Captured here: a socket's admission reads it for each request (worker/SocketAccess.ts).
    const roleFreshMs = yield* SocketAccess.configuredRoleFreshMs.pipe(Effect.orDie)
    const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(DatabaseRoutes.route(pools, "requests"))
    const database = Database.layer(hyperdrive.connectionString)
    // Repository secrets (docs/features/secrets.md): write-only values sealed under SECRETS_KEY, off without it. A
    // person's own model's key is sealed under it too (docs/features/personal-model.md).
    const secretKeys = yield* Effect.service(SecretKeys).pipe(Effect.provide(SecretKeys.layerConfig), Effect.orDie)
    const personalModels = PersonalModels.layer(database).pipe(Layer.provide(Layer.succeed(SecretKeys, secretKeys)))
    const chat = yield* Chat.make(database, {
      // Generated views render in the realm on the QuickJS build the bundle compiled (worker/ViewRealm.ts).
      realm: ViewRealm.load,
      ...(options.localHttp === undefined ? {} : { localHttp: options.localHttp }),
      ...(options.spendAlerts === undefined ? {} : { spendAlerts: options.spendAlerts }),
      ...(options.hostedModel === undefined ? {} : { hostedModel: options.hostedModel }),
      ...(options.summaryDailyCap === undefined ? {} : { summaryDailyCap: options.summaryDailyCap })
    })
    // A person's own model (docs/features/personal-model.md): saving, removing and testing it, and its shape.
    const personalApi = yield* PersonalApi.make(database)
    // Bug reports (docs/features/bugs.md): filing one, the Admins' read and the reports' shape.
    const bugsApi = yield* BugsApi.make(database)
    const brokerObjects = yield* AuthBroker.HostedAuthBroker
    const connectionObjects = yield* GitHubConnection.GitHubConnection
    // Read once: the delegation route checks a call's signature against these sites before it addresses an object.
    const connectionSetup = yield* GitHubConnection.configured().pipe(Effect.orDie)
    // Signed-out reads for hosted sites through the App (decision 0165, public reads): stateless, before any object.
    const publicReadHttp = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer))
    const publicReadSetup = yield* PublicReads.configured().pipe(Effect.provideService(HttpClient.HttpClient, publicReadHttp), Effect.orDie)
    const signIn = yield* SignIn.make(database, options).pipe(Effect.provide(FetchHttpClient.layer))
    // Repositories (docs/features/repo.md): cloning into Code Storage, the `repositories` shape, reads at a commit,
    // cached in this Worker's Cache API, and what GitHub says of a repository, kept in Postgres for every data center.
    const codeStorage = yield* RepoConfig.codeStorage.pipe(Effect.provide(FetchHttpClient.layer))
    const repos = yield* RepoApi.make(database, { codeStorage })
    // The branch workspace (docs/features/branch-workspace.md): tracking a branch, its terminals, and the branches'
    // machines, `SandboxObject`s ChatApi hosts (worker/BranchSandboxes.ts).
    const branchApi = yield* BranchApi.make(database).pipe(Effect.provide(FetchHttpClient.layer))
    const secretsApi = yield* SecretsApi.make(yield* GitHubConfig.repository)
    // A writer of the engine's schema (worker/ExecutionHost.ts `database`), which takes the engine's writer lock: steers
    // are admitted to and delivered from a run's queue in its journal.
    const engineWriter = Layer.unwrap(
      Effect.map(
        hyperdrive.connectionString,
        (url) => ExecutionHost.database(Redacted.value(url), ExecutionHost.ENGINE_SCHEMA)
      )
    )
    // External agents on runner machines (docs/features/agent-runners.md): the runners' own routes, which their token
    // authenticates, and an Admin's writes of a repository's runners and agents.
    // A claim tells a TODO's attempt it no longer waits for a runner (decision 0135), and a heartbeat carries the
    // messages Members sent the TODO's agent (docs/features/agent-runners.md#steering).
    const runnersApi = RunnersApi.make(database, {
      onClaimed: (task) =>
        task.context?.attemptId === undefined
          ? Effect.void
          : TodoSession.claimed(task.context.attemptId).pipe(Effect.provide(database)),
      // A TODO's agent writes its transcript to the TODO's run (decision 0141).
      runOf: TodoSession.runOf,
      steering: TodoSession.steering(engineWriter),
      // A private repository's mirror fetches with the App's read-only token for that repository (decision 0148). Off
      // until the review of its fixes passes: without it the route answers 404 and the runner fetches as before.
      ...(RunnersApi.GIT_CREDENTIAL_ON
        ? { gitCredential: GitCredential.make(yield* GitHubConfig.configured, database) }
        : {})
    })
    const runnerAdmin = yield* RunnerAdmin.make(database)
    // Every live runner and its repository's installation, for the deployment's Admins (decision 0148).
    const runnerAudit = RunnerAudit.make(database)
    // Custom domains (docs/features/domains.md): a Maintainer's, through the deployment's provider; off without one.
    const domainsApi = yield* DomainsApi.make(yield* GitHubConfig.repository, database)
    const domainProvider = yield* DomainsConfig.provider(options).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.orDie
    )
    const sandboxObjects = (yield* BranchSandboxes.SandboxObject) as Cloudflare.DurableObject<
      BranchSandboxes.SandboxObjectShape
    >
    // The gate machine's objects, `GateObject`s ChatApi hosts too, when the deployment declares it (GATE_IMAGE).
    const machineObjects = BranchSandboxes.namespaces(
      sandboxObjects,
      machines.includes(JobMachines.GATE)
        ? (yield* BranchSandboxes.GateObject) as Cloudflare.DurableObject<BranchSandboxes.SandboxObjectShape>
        : undefined
    )
    // Each branch's room, `RoomObject`s ChatApi hosts (worker/BranchRooms.ts), and the people a branch can be shared
    // with: everyone who signed in, and local development's own people (docs/features/branch-workspace.md#sharing).
    const roomObjects = (yield* BranchRooms.RoomObject) as Cloudflare.DurableObject<BranchRooms.RoomObjectShape>
    // Each run's transcript, `RunContent`s ChatApi hosts (worker/RunContent.ts, docs/features/agent-transcripts.md).
    const runContents = (yield* RunContent.RunContent) as Cloudflare.DurableObject<RunContent.RunContentShape>
    const localPeople = [options.fallback, ...Object.values(options.teammates ?? {})].flatMap((person) =>
      person === undefined ? [] : [person]
    )
    const directory = Directory.layer(
      database,
      localPeople.map((person) => ({ id: person.actor.subject.id, login: person.login }))
    )
    const forge = Layer.succeed(
      Forge,
      yield* Effect.service(Forge).pipe(
        Effect.provide(Forge.layerConfig),
        Effect.provide(FetchHttpClient.layer)
      )
    )
    // Who has which role on which repository (decision 0079): the session's on the deployment's own, GitHub's, read
    // with the App, on any other it may act on. Local development without the App keeps the developer's everywhere.
    const repository = yield* GitHubConfig.repository
    const app = yield* GitHubConfig.configured
    const allowed = yield* RepoRoles.allowed
    // Local development: `alchemy dev`'s signed-in developer and no App (worker/DevChatApi.ts). A deploy passes no options.
    const local = options.fallback !== undefined && Option.isNone(app)
    const roles = yield* RepoRoles.make(database, {
      repository,
      app,
      allowed,
      local,
      ...(options.localRoles === undefined ? {} : { localRoles: options.localRoles })
    })
    // Repository feeds (docs/features/feeds.md): an outside collector's documents under `FEED_KEYS`, the Maintainers'
    // answers, and the feeds' shape, by each person's role on the repository.
    const feedsApi = yield* FeedsApi.make(
      database,
      roles,
      options.feedKey === undefined ? {} : { developmentKey: options.feedKey }
    )
    // The git loop (docs/features/issues.md): GitHub's webhook, the writes route and the issues' shapes, for every
    // repository the deployment acts on (decision 0079, slice 1b).
    const github = yield* GitHubApi.make(database, {
      repository,
      app,
      roles,
      repoFlows,
      allowed,
      // Repository notifications reach local development's people, who have no session, by their fixed role.
      localPeople: localPeople.map((person) => ({ id: person.actor.subject.id, role: person.actor.role })),
      ...(local && options.localSynced !== undefined ? { localSynced: options.localSynced } : {})
    })
    // TODOs and the stack (docs/features/todos.md): the one route that changes a stack, through its one writer, and the
    // TODOs' shapes.
    const refreshIssue = Option.isSome(app) ? yield* IssueRead.make(app.value) : undefined
    const stack = yield* StackApi.make(database, roles, refreshIssue === undefined ? {} : { refreshIssue })
    // The fleet's shapes: a repository's agent runs and runner machines (docs/features/fleet.md#the-shapes).
    const fleet = yield* FleetApi.make(roles)
    // A TODO's run, watched from its page (ruling TODO-3, docs/features/runs.md#a-run-on-cloudflare), and a repository's
    // (docs/features/actions.md): the engine's own read of it, from the engine's schema, and its row of the engine's
    // change feed through Electric. A Member steers a TODO's agent by admitting a message to the run's queue in the same
    // schema (docs/features/runs.md#steering), and stops a repository's run on its Durable Object.
    const remoteRuns = yield* RemoteRuns.make(database, {
      database: Layer.unwrap(
        Effect.map(
          hyperdrive.connectionString,
          (url) => ExecutionHost.readDatabase(Redacted.value(url), ExecutionHost.ENGINE_SCHEMA)
        )
      ),
      writer: engineWriter,
      schema: ExecutionHost.ENGINE_SCHEMA,
      flows: [Todo.Todo, RepoFlow.Run, RepoFlow.Jobs, CiJob.CiJob, CiJob.Graph],
      // A repository's run stops on the Durable Object that holds it (docs/features/actions.md#acts).
      repositoryRun: (runId) => executions.getByName(runId).repositoryRun().pipe(Effect.map(Option.fromNullishOr)),
      stop: (runId) => executions.getByName(runId).cancel(),
      // A TODO run's transcript, on its own Durable Object (worker/RunContent.ts).
      transcript: (runId, admission) => RunContent.connect(runContents, runId, admission)
    }, roles)
    // A repository's flows run by hand, and its runs run again (docs/features/actions.md#running-a-flow-by-hand), on the
    // repositories REPO_FLOWS_REPOSITORIES allows, by the asker's role there, read as the App and in the QuickJS realm.
    const repoRunsApi = yield* RunsApi.make(database, {
      repositories,
      app,
      repoFlows,
      roles,
      engine: Layer.unwrap(
        Effect.map(
          hyperdrive.connectionString,
          (url) => ExecutionHost.readDatabase(Redacted.value(url), ExecutionHost.ENGINE_SCHEMA)
        )
      ),
      variant: AgentSandbox.variant
    })
    const githubApp = yield* GitHubConfig.configured
    const runTodos = yield* Todo.enabled
    // A repository's home (docs/features/home.md): who the asker is on it, by their role there (decision 0079), and
    // Smithers' curated home for it.
    const home = HomeApi.make({ roles, mayRead: github.mayRead, mayBrowse: github.mayBrowse, maySync: github.maySync })
    const repoCache = EdgeCache.layer({ name: "repo" }).pipe(Layer.orDie)
    const webCache = EdgeCache.layer({ name: "web" }).pipe(Layer.orDie)
    // A repository's docs (docs/features/docs.md): the index its home names, from what GitHub says of it (RepoApi's
    // about read), and its pages, read through the Worker's fetch and kept in the repositories' cache. The docs routes
    // and the views route (a `docs` view) read them.
    const docs = DocsApi.make()
    const docsSettings = yield* DocsSource.settings.pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie)
    const docsSource = DocsSource.layer(docsSettings, { about: repos.about }).pipe(
      Layer.provide(Layer.merge(FetchHttpClient.layer, repoCache))
    )
    const logs = Logger.layerStructuredJson()
    // ChatApi hosts the remote flow executions' Durable Object (worker/Executions.ts, docs/features/remote-flows.md), and
    // creates each one where the deployment places them (`FLOW_EXECUTION_LOCATION`, worker/Placement.ts).
    const executions = Placement.placed(yield* Executions.FlowExecution, yield* Placement.location.pipe(Effect.orDie))
    // The edge throttle on the open routes (worker/Throttle.ts): requests per network per minute, counted per Cloudflare
    // location. Neither number comes from a load test: a busy tab sends about 70 shape requests and 150 telemetry
    // exports a minute, so each lets about 20 busy tabs share a network (docs/features/chat.md#throttling).
    const shapeLimit = yield* Cloudflare.RateLimit("SHAPE_LIMIT", {
      namespaceId: 71001,
      simple: { limit: 3000, period: 60 }
    })
    const telemetryLimit = yield* Cloudflare.RateLimit("TELEMETRY_LIMIT", {
      namespaceId: 71002,
      simple: { limit: 3000, period: 60 }
    })
    // The hosted-site broker's routes (decision 0165): a sign-in or Connect is at most five requests, so this lets
    // about 60 a minute share a network.
    const brokerLimit = yield* Cloudflare.RateLimit("BROKER_LIMIT", {
      namespaceId: 71003,
      simple: { limit: 300, period: 60 }
    })

    /**
     * Starts `auth/RecheckRole` on its own Durable Object, one execution per session and the check it replaces, so one
     * check of a session runs at a time. Session resolution bounds the start acknowledgment; an expired request can
     * advance the same execution and fresh receipts never wait for completion.
     */
    const roleChecks = Effect.gen(function*() {
      const runtime = yield* RuntimeContext
      return SignIn.RoleChecks.of({
        wait: (sessionId, generation) =>
          executions.getByName(recheckExecutionId(sessionId, generation)).advance().pipe(
            Effect.provideService(RuntimeContext, runtime),
            Effect.catchCause((cause) =>
              Effect.logWarning("auth.role_check").pipe(
                Effect.annotateLogs({ sessionId, outcome: "wait_failed", errorCode: codeOf(Cause.squash(cause)) })
              )
            )
          ),
        start: (sessionId, generation) => {
          const executionId = recheckExecutionId(sessionId, generation)
          return ExecutionHost.intent(RecheckRole, { executionId, payload: { sessionId } }).pipe(
            Effect.flatMap((intent) => executions.getByName(executionId).start(intent)),
            Effect.provideService(RuntimeContext, runtime),
            Effect.catchCause((cause) =>
              Effect.logWarning("auth.role_check").pipe(
                Effect.annotateLogs({ sessionId, outcome: "not_started", errorCode: codeOf(Cause.squash(cause)) })
              )
            )
          )
        }
      })
    })

    /** Where ChatApi's routes start a remote flow (worker/Flows.ts): its own Durable Object, named by the execution id. */
    const flowStarter = Executions.starter(executions)
    /** Where a person's answer reaches a remote run parked on it (worker/Flows.ts `TaskAnswers`): its own object. */
    const taskAnswerer = Executions.answerer(executions)
    // An agent's questions to people (worker/Asks.ts), started on `FlowExecution` as `queue/ask`.
    const asks = Asks.make(database, options.askToken === undefined ? {} : { developmentToken: options.askToken })
    // A confirmed feed barrier's pass starts with the next request, whatever else runs
    // (docs/features/notifications.md#rows-written-before): at most one indexed read a minute per isolate.
    const launchFeedRedaction = yield* RedactFeed.launcher

    return {
      fetch: Effect.gen(function*() {
        // A branch's box reaches its forge through this Worker's own entrypoint, with props naming its object
        // (worker/BranchSandboxes.ts): handed straight back to that object, never routed as a person's request.
        const box = BranchSandboxes.boxOf((yield* Cloudflare.WorkerExecutionContext).raw.props)
        if (box !== undefined) return yield* BranchSandboxes.answerBox(machineObjects, box)
        if (options.door !== undefined) {
          const answered = yield* options.door({ executions, database })
          if (Option.isSome(answered)) return answered.value
        }
        const runtime = yield* RuntimeContext
        const brokerRequest = yield* HttpServerRequest.HttpServerRequest
        const throttle = Effect.flatMap(
          HttpServerRequest.HttpServerRequest,
          Throttle.make({
            shape: { limit: (key) => shapeLimit.limit(key).pipe(Effect.provideService(RuntimeContext, runtime)) },
            telemetry: {
              limit: (key) => telemetryLimit.limit(key).pipe(Effect.provideService(RuntimeContext, runtime))
            },
            broker: { limit: (key) => brokerLimit.limit(key).pipe(Effect.provideService(RuntimeContext, runtime)) }
          })
        )
        // Every hosted site's sign-in shares one object: a network past its allowance never reaches it.
        if (AuthBroker.handles(brokerRequest.url)) {
          const limited = yield* throttle
          if (Option.isSome(limited)) return limited.value
          return yield* brokerObjects.getByName("hosted").fetch(brokerRequest).pipe(Effect.provideService(RuntimeContext, runtime))
        }
        if (GitHub.Delegation.handles(brokerRequest.url)) return yield* GitHubConnection.route(connectionObjects, connectionSetup).pipe(Effect.provideService(RuntimeContext, runtime))
        if (GitHub.PublicRead.handles(brokerRequest.url)) return yield* PublicReads.route(publicReadSetup, publicReadHttp)
        const checks = Layer.succeed(SignIn.RoleChecks, yield* roleChecks)
        const starter = yield* flowStarter
        return yield* runnerAdmin.admit(
          signIn.admit(
            Effect.gen(function*() {
              const request = yield* HttpServerRequest.HttpServerRequest
              // Who is asking, and their role on a branch's repository for every branch check (decision 0079).
              const signedIn = Layer.mergeAll(
                checks,
                signIn.sessions.pipe(Layer.provide(checks)),
                BranchRoles.layer(roles)
              )
              // After the response, never before it: no request waits on a claim or a start (ctx.waitUntil).
              yield* RequestBackground.inBackground(
                launchFeedRedaction.pipe(
                  Effect.provideService(Flows.FlowStarter, starter),
                  Effect.provide(database),
                  Effect.ignore
                )
              )
              if (request.url.startsWith(`${AUTH_ROUTE}/`)) {
                // Signing out starts `auth/RevokeGitHubToken` through `starter` and answers once the start is recorded.
                return yield* signIn.fetch.pipe(
                  Effect.provideService(Flows.FlowStarter, starter),
                  Effect.provide(signedIn)
                )
              }
              const path = request.url.split("?")[0]!
              if (BranchApi.handles(path)) {
                const sockets = Layer.effect(TerminalSockets, BranchSandboxes.terminalSocketsOver(sandboxObjects))
                const rooms = BranchRooms.roomsLayer(roomObjects)
                return yield* branchApi.fetch.pipe(
                  Effect.provideService(Flows.FlowStarter, starter),
                  Effect.provide(signedIn),
                  Effect.provide(Layer.mergeAll(forge, sockets, rooms, directory, FetchHttpClient.layer))
                )
              }
              if (RunnersApi.handles(path)) {
                return yield* runnersApi.fetch.pipe(Effect.provide(RunContent.transcriptsLayer(runContents)))
              }
              if (FleetApi.handles(path)) return yield* fleet.fetch.pipe(Effect.provide(signedIn))
              if (RunnerAudit.handles(path)) return yield* runnerAudit.fetch.pipe(Effect.provide(signedIn))
              // Before the repository routes: `/api/repos/<owner>/<name>/runners/<name>`, `.../agents/<name>` and
              // `.../overflow/cloudflare`, which mints and seals the overflow runner's token.
              if (RunnerAdmin.handles(path)) {
                return yield* runnerAdmin.fetch.pipe(
                  Effect.provideService(Flows.FlowStarter, starter),
                  Effect.provideService(SecretKeys, secretKeys),
                  Effect.provide(signedIn)
                )
              }
              // Before the repository routes: a write is `/api/repos/<owner>/<name>/writes`.
              if (SecretsApi.handles(path)) {
                return yield* secretsApi.fetch.pipe(
                  Effect.provideService(Flows.FlowStarter, starter),
                  Effect.provideService(SecretKeys, secretKeys),
                  Effect.provide(signedIn)
                )
              }
              if (PersonalApi.handles(path)) {
                return yield* personalApi.fetch.pipe(
                  Effect.provideService(Flows.FlowStarter, starter),
                  Effect.provideService(SecretKeys, secretKeys),
                  Effect.provide(personalModels),
                  Effect.provide(signedIn),
                  Effect.provide(FetchHttpClient.layer)
                )
              }
              if (GitHubConnectionsPage.handles(path)) {
                return yield* GitHubConnectionsPage.serve(connectionObjects).pipe(
                  Effect.provide(database),
                  Effect.provideService(RuntimeContext, runtime),
                  Effect.provide(signedIn),
                  Effect.provide(FetchHttpClient.layer),
                  Effect.catchCause(() => Effect.succeed(HttpServerResponse.empty({ status: 503, headers: GitHub.Auth.Broker.HEADERS })))
                )
              }
              if (BugsApi.handles(path)) {
                return yield* bugsApi.fetch.pipe(
                  Effect.provideService(Flows.FlowStarter, starter),
                  Effect.provide(signedIn),
                  Effect.provide(FetchHttpClient.layer)
                )
              }
              // Before the repository routes: an agent's question to a person is `/api/repos/<owner>/<name>/asks`
              // (docs/features/agent-status.md#addressed-waits).
              if (Asks.handles(path)) {
                return yield* asks.fetch.pipe(Effect.provideService(Flows.FlowStarter, starter), Effect.provide(directory))
              }
              // Before the repository routes: a feed is `/api/repos/<owner>/<name>/feeds`.
              if (FeedsApi.handles(path)) return yield* feedsApi.fetch.pipe(Effect.provide(signedIn))
              if (DomainsApi.handles(path)) {
                return yield* domainsApi.fetch.pipe(
                  Effect.provideService(Flows.FlowStarter, starter),
                  Effect.provideService(DomainProvider, domainProvider),
                  Effect.provide(signedIn)
                )
              }
              if (GitHubApi.handles(path)) {
                return yield* github.fetch.pipe(
                  Effect.provideService(GitHubApi.EndGitHubConnection, (person) => connectionObjects.getByName(GitHubConnection.nameOf(person)).revokedAtGitHub(person).pipe(Effect.asVoid, Effect.provideService(RuntimeContext, runtime))),
                  Effect.provideService(FirstPaint.Behind, yield* RequestBackground.firstPaintBehind),
                  Effect.provideService(Flows.FlowStarter, starter),
                  Effect.provide(signedIn)
                )
              }
              // Before the repository routes too: a change is `/api/repos/<owner>/<name>/stack`. With the GitHub App and
              // `TODO_RUNS` on, this host runs TODOs: each attempt the writer starts runs `todo` on its own Durable Object
              // (decision 0016).
              if (StackApi.handles(path)) {
                const requestRuntime = yield* RuntimeContext
                return yield* (Option.isSome(githubApp) && runTodos
                  ? stack.fetch.pipe(Effect.provideService(
                    Stack.TodoRuns,
                    TodoRuns.make(starter, (executionId) =>
                      executions.getByName(executionId).cancel().pipe(
                        Effect.provideService(RuntimeContext, requestRuntime)
                      ), (attemptId) =>
                      TodoRuns.isStopped(
                        Layer.unwrap(
                          Effect.map(
                            hyperdrive.connectionString,
                            (url) => ExecutionHost.readDatabase(Redacted.value(url), ExecutionHost.ENGINE_SCHEMA)
                          )
                        )
                      )(attemptId).pipe(Effect.provideService(RuntimeContext, requestRuntime)))
                  ))
                  : stack.fetch).pipe(Effect.provide(signedIn))
              }
              if (RemoteRuns.handles(path)) return yield* remoteRuns.fetch.pipe(Effect.provide(signedIn))
              // Before the repository routes: `/api/repos/<owner>/<name>/flows[/<flow>]` and `.../runs`
              // (docs/features/actions.md#running-a-flow-by-hand).
              if (RunsApi.handles(path)) {
                return yield* repoRunsApi.fetch.pipe(
                  Effect.provideService(Flows.FlowStarter, starter),
                  Effect.provide(signedIn)
                )
              }
              // And a home, `/api/repos/<owner>/<name>/home` (docs/features/home.md): who the asker is and the curated home.
              if (HomeApi.handles(path)) return yield* home.fetch.pipe(Effect.provide(signedIn))
              // And docs, `/api/repos/<owner>/<name>/docs[/page]`: open to everyone, like the about read.
              if (DocsApi.handles(path)) return yield* docs.fetch.pipe(Effect.provide(docsSource))
              if (path === REPOS_ROUTE || path.startsWith(`${REPOS_ROUTE}/`) || path === REPOSITORIES_SHAPE_ROUTE) {
                return yield* repos.fetch.pipe(
                  Effect.provideService(Flows.FlowStarter, starter),
                  Effect.provide(signedIn),
                  Effect.provide(repoCache)
                )
              }
              // Pages checked before they are framed are requested through the Worker's fetch, which reaches public addresses
              // only, and their answers kept in this Worker's Cache API (worker/WebPreview.ts).
              return yield* chat.fetch.pipe(
                Effect.provideService(Flows.FlowStarter, starter),
                // An answer to a run addressed to the person reaches the run's own object (worker/Runs.ts).
                Effect.provideService(Flows.TaskAnswers, yield* taskAnswerer),
                // The model endpoint answers a person who saved a model of their own with it.
                Effect.provide(personalModels),
                Effect.provide(signedIn),
                Effect.provide(docsSource),
                Effect.provide(Layer.merge(FetchHttpClient.layer, webCache))
              )
            }),
            throttle
          ).pipe(Effect.provide(checks), Effect.provideService(Flows.FlowStarter, starter))
        )
      }).pipe(
        withRequestRay,
        Effect.provideService(Conversations.homeRepositoryNames, homeRepository),
        Effect.provideService(SocketAccess.roleFreshMs, roleFreshMs),
        // Every shape route calls Electric through the gateway's service binding in production (infra/ElectricUpstream.ts).
        Effect.provide(
          Layer.unwrap(Effect.map(Effect.service(Cloudflare.WorkerEnvironment), ElectricUpstream.upstream))
        ),
        Effect.provide(logs)
      )
    }
  }).pipe(
    Effect.provide(AuthBroker.live),
    Effect.provide(GitHubConnection.live),
    Effect.provide(Executions.live(DatabaseRoutes.route(pools, "FlowExecution"), {
      repositories,
      repoFlows,
      homeRepository,
      ...(options.dev === true ? { dev: true } : {}),
      ...(options.spendAlerts === undefined ? {} : { spendAlerts: options.spendAlerts }),
      ...(options.hostedModel === undefined ? {} : { hostedModel: options.hostedModel })
    })),
    Effect.provide(BranchSandboxes.live(
      DatabaseRoutes.route(pools, "SandboxObject"),
      socketChecks(options),
      DatabaseRoutes.route(pools, "SocketChecks"),
    )),
    Effect.provide(BranchSandboxes.gateLive(
      DatabaseRoutes.route(pools, "GateObject"),
      socketChecks(options),
      DatabaseRoutes.route(pools, "SocketChecks"),
    )),
    Effect.provide(BranchRooms.live(DatabaseRoutes.route(pools, "RoomObject"), socketChecks(options))),
    Effect.provide(RunContent.live(DatabaseRoutes.route(pools, "RunContent"), socketChecks(options))),
    Effect.provide(
      Layer.mergeAll(
        HostModel.layerConfig("CHAT_MODEL", DEFAULT_CHAT_MODEL),
        Cloudflare.Hyperdrive.ConnectBinding,
        // The gate's run artifacts (`CiArtifacts`), bound only with the gate machine.
        Cloudflare.R2.ReadWriteBucketBinding,
        Cloudflare.RateLimitBinding,
        Cloudflare.Telemetry({ persist: true }),
        AuthBroker.requestTelemetry
      )
    )
  )
