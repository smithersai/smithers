// ChatApi's program (worker/ChatApi.ts): everything ChatApi serves and hosts. worker/ChatApi.ts loads this module when
// the Worker first builds its program, not when Cloudflare starts the Worker, so its modules are evaluated then and
// count against the first request's CPU instead of the Worker's startup limit (docs/infrastructure.md#limits).
import { HostModel } from "@smthrs/model-host"
import { Logger } from "@smthrs/observability"
import { EdgeCache } from "@smthrs/platform-cloudflare"
import { RuntimeContext } from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { Cause, Effect, Layer, Option, Predicate, Redacted } from "effect"
import { FetchHttpClient, HttpServerRequest } from "effect/http"
import * as Database from "../db/Database.ts"
import * as Electric from "../infra/Electric.ts"
import * as SecretsInfra from "../infra/Secrets.ts"
import * as SignInSecret from "../infra/SignIn.ts"
import { AUTH_ROUTE } from "../src/features/auth/contract.ts"
import { REPOS_ROUTE, REPOSITORIES_SHAPE_ROUTE } from "../src/features/repo/contract.ts"
import * as Conversations from "./branch/Conversations.ts"
import * as BranchApi from "./branch/BranchApi.ts"
import { Forge } from "./branch/Forge.ts"
import { Directory } from "./branch/People.ts"
import { TerminalSockets } from "./branch/Sandboxes.ts"
import * as BranchRooms from "./BranchRooms.ts"
import * as BranchSandboxes from "./BranchSandboxes.ts"
import * as BugsApi from "./bugs/Api.ts"
import * as Chat from "./Chat.ts"
import * as ViewRealm from "./ViewRealm.ts"
import { codeOf } from "./ErrorCode.ts"
import * as ExecutionHost from "./ExecutionHost.ts"
import * as Executions from "./Executions.ts"
import * as Placement from "./Placement.ts"
import * as Flows from "./Flows.ts"
import { RecheckRole, recheckExecutionId } from "./flows/RecheckRole.ts"
import * as Dispatch from "./ci/Dispatch.ts"
import * as RepoFlow from "./ci/RepoFlow.ts"
import { CiJob } from "@smthrs/sandbox"
import * as GitHubApi from "./github/Api.ts"
import * as DocsApi from "./docs/Api.ts"
import * as DocsSource from "./docs/Source.ts"
import * as HomeApi from "./home/Api.ts"
import * as GitHubConfig from "./github/Config.ts"
import { DEFAULT_CHAT_MODEL } from "./ModelRoles.ts"
import * as RepoApi from "./RepoApi.ts"
import * as RemoteRuns from "./RemoteRuns.ts"
import * as RepoConfig from "./RepoConfig.ts"
import * as DomainsApi from "./domains/Api.ts"
import * as DomainsConfig from "./domains/Config.ts"
import { DomainProvider } from "./domains/Provider.ts"
import * as PersonalApi from "./personal/Api.ts"
import { PersonalModels } from "./personal/Models.ts"
import * as SecretsApi from "./secrets/Api.ts"
import { SecretKeys } from "./secrets/Keys.ts"
import * as SignIn from "./SignIn.ts"
import * as RepoRoles from "./github/RepoRoles.ts"
import { BranchRoles } from "./branch/Access.ts"
import * as StackApi from "./stack/Api.ts"
import * as Stack from "./stack/Stack.ts"
import * as TodoRuns from "./stack/TodoRuns.ts"
import * as Todo from "./flows/Todo.ts"
import * as Throttle from "./Throttle.ts"

/**
 * Postgres, through Hyperdrive. Its origin is `DATABASE_URL`; under `alchemy dev` the binding passes straight
 * through to the same database (the compose Postgres by default). Hyperdrive's query cache is off: an answer's
 * history must see the latest writes.
 */
const ChatDatabase = Effect.gen(function* () {
  const { origin, sslmode } = Database.hyperdrive(yield* Database.url)
  return yield* Cloudflare.Hyperdrive.Connection("ChatDatabase", {
    origin,
    caching: { disabled: true },
    dev: { ...origin, sslmode },
  })
})

/**
 * ChatApi's program. Who is asking comes from sign-in (`worker/SignIn.ts`); `fallback` is who is signed in while the
 * GitHub App isn't configured: nobody in production (below), a local developer under `alchemy dev`
 * (`worker/DevChatApi.ts`). The model endpoint refuses a call with no actor. `localHttp`, which only `alchemy dev` sets,
 * keeps links to `http:` pages on `localhost` (`WEB_PAGES_LOCAL_HTTP`'s default, worker/Views.ts). `spendAlerts`,
 * which only `alchemy dev` sets, to `false`, is `MODEL_SPEND_ALERTS`' default: a deploy alerts on any model spend
 * unless its environment says otherwise (docs/features/spend-alerts.md). `dev`, which only `alchemy dev` sets, lets an
 * alert provider pointed at a local fake send without its key (docs/features/spend-alerts.md#channels). `hostedModel`,
 * which only `alchemy dev` sets, to `true`, is `HOSTED_MODEL_ENABLED`'s default: a deploy answers only with people's
 * own models unless its environment or an Admin turns the deployment's model on (decision 0099).
 */
export interface ProgramOptions {
  readonly fallback?: SignIn.Signed
  readonly teammates?: Readonly<Record<string, SignIn.Signed>>
  readonly localHttp?: boolean
  readonly spendAlerts?: boolean
  readonly dev?: boolean
  readonly hostedModel?: boolean
}

export const program = (options: ProgramOptions = {}) =>
  Effect.gen(function* () {
    const repoFlows = yield* Dispatch.enabled
    const repositories = yield* Dispatch.repositories
    const homeRepository = yield* Conversations.configuredHomeRepositoryNames
    return yield* configuredProgram(options, { repoFlows, repositories, homeRepository })
  })

/** All deployment choices below are already captured before Alchemy builds the handlers. */
const configuredProgram = (options: ProgramOptions, { repoFlows, repositories, homeRepository }: {
  readonly repoFlows: boolean
  readonly repositories: ReadonlySet<string>
  readonly homeRepository: { readonly owner: string; readonly name: string }
}) =>
  Effect.gen(function* () {
    yield* Electric.bind
    yield* SignInSecret.bind
    yield* SecretsInfra.bind
    const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(ChatDatabase)
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
    })
    // A person's own model (docs/features/personal-model.md): saving, removing and testing it, and its shape.
    const personalApi = yield* PersonalApi.make(database)
    // Bug reports (docs/features/bugs.md): filing one, the Admins' read and the reports' shape.
    const bugsApi = yield* BugsApi.make(database)
    const signIn = yield* SignIn.make(database, options).pipe(Effect.provide(FetchHttpClient.layer))
    // Repositories (docs/features/repo.md): cloning into Code Storage, the `repositories` shape, reads at a commit,
    // cached in this Worker's Cache API, and what GitHub says of a repository, kept in Postgres for every data center.
    const codeStorage = yield* RepoConfig.codeStorage.pipe(Effect.provide(FetchHttpClient.layer))
    const repos = yield* RepoApi.make(database, { codeStorage })
    // The branch workspace (docs/features/branch-workspace.md): tracking a branch, its terminals, and the branches'
    // machines, `SandboxObject`s ChatApi hosts (worker/BranchSandboxes.ts).
    const branchApi = yield* BranchApi.make(database).pipe(Effect.provide(FetchHttpClient.layer))
    const secretsApi = yield* SecretsApi.make(yield* GitHubConfig.repository)
    // Custom domains (docs/features/domains.md): a Maintainer's, through the deployment's provider; off without one.
    const domainsApi = yield* DomainsApi.make(yield* GitHubConfig.repository, database)
    const domainProvider = yield* DomainsConfig.provider(options).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.orDie,
    )
    const sandboxObjects = (yield* BranchSandboxes.SandboxObject) as Cloudflare.DurableObject<
      BranchSandboxes.SandboxObjectShape
    >
    // Each branch's room, `RoomObject`s ChatApi hosts (worker/BranchRooms.ts), and the people a branch can be shared
    // with: everyone who signed in, and local development's own people (docs/features/branch-workspace.md#sharing).
    const roomObjects = (yield* BranchRooms.RoomObject) as Cloudflare.DurableObject<BranchRooms.RoomObjectShape>
    const directory = Directory.layer(
      database,
      [options.fallback, ...Object.values(options.teammates ?? {})].flatMap((person) =>
        person === undefined ? [] : [{ id: person.actor.subject.id, login: person.login }]
      ),
    )
    const forge = Layer.succeed(Forge, yield* Effect.service(Forge).pipe(
      Effect.provide(Forge.layerConfig), Effect.provide(FetchHttpClient.layer),
    ))
    // Who has which role on which repository (decision 0079): the session's on the deployment's own, GitHub's, read
    // with the App, on any other it may act on. Local development without the App keeps the developer's everywhere.
    const repository = yield* GitHubConfig.repository
    const app = yield* GitHubConfig.configured
    const allowed = yield* RepoRoles.allowed
    const roles = yield* RepoRoles.make(database, {
      repository,
      app,
      allowed,
      local: options.fallback !== undefined && Option.isNone(app),
    })
    // The git loop (docs/features/issues.md): GitHub's webhook, the writes route and the issues' shapes, for every
    // repository the deployment acts on (decision 0079, slice 1b).
    const github = yield* GitHubApi.make(database, { repository, app, roles, repoFlows, allowed })
    // TODOs and the stack (docs/features/todos.md): the one route that changes a stack, through its one writer, and the
    // TODOs' shapes.
    const stack = yield* StackApi.make(database, roles)
    // A TODO's run, watched from its page (ruling TODO-3, docs/features/runs.md#a-run-on-cloudflare), and a repository's
    // (docs/features/actions.md): the engine's own read of it, from the engine's schema, and its row of the engine's
    // change feed through Electric. A Member steers a TODO's agent by admitting a message to the run's queue in the same
    // schema (docs/features/runs.md#steering), and stops a repository's run on its Durable Object.
    const remoteRuns = yield* RemoteRuns.make(database, {
      database: Layer.unwrap(
        Effect.map(
          hyperdrive.connectionString,
          (url) => ExecutionHost.readDatabase(Redacted.value(url), ExecutionHost.ENGINE_SCHEMA),
        ),
      ),
      writer: Layer.unwrap(
        Effect.map(
          hyperdrive.connectionString,
          (url) => ExecutionHost.database(Redacted.value(url), ExecutionHost.ENGINE_SCHEMA),
        ),
      ),
      schema: ExecutionHost.ENGINE_SCHEMA,
      flows: [Todo.Todo, RepoFlow.Run, RepoFlow.Jobs, CiJob.CiJob],
      // A repository's run stops on the Durable Object that holds it (docs/features/actions.md#acts).
      stop: (runId) => executions.getByName(runId).cancel(),
    }, roles)
    const githubApp = yield* GitHubConfig.configured
    const runTodos = yield* Todo.enabled
    // A repository's home (docs/features/home.md): who the asker is on it, by their role there (decision 0079), and
    // Smithers' curated home for it.
    const home = HomeApi.make({ roles, mayRead: github.mayRead })
    const repoCache = EdgeCache.layer({ name: "repo" }).pipe(Layer.orDie)
    const webCache = EdgeCache.layer({ name: "web" }).pipe(Layer.orDie)
    // A repository's docs (docs/features/docs.md): the index its home names, from what GitHub says of it (RepoApi's
    // about read), and its pages, read through the Worker's fetch and kept in the repositories' cache. The docs routes
    // and the views route (a `docs` view) read them.
    const docs = DocsApi.make()
    const docsSettings = yield* DocsSource.settings.pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie)
    const docsSource = DocsSource.layer(docsSettings, { about: repos.about }).pipe(
      Layer.provide(Layer.merge(FetchHttpClient.layer, repoCache)),
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
      simple: { limit: 3000, period: 60 },
    })
    const telemetryLimit = yield* Cloudflare.RateLimit("TELEMETRY_LIMIT", {
      namespaceId: 71002,
      simple: { limit: 3000, period: 60 },
    })

    /**
     * Starts `auth/RecheckRole` on its own Durable Object, one execution per session and the check it replaces, so one
     * check of a session runs at a time; it never waits.
     */
    const roleChecks = Effect.gen(function* () {
      const runtime = yield* RuntimeContext
      return SignIn.RoleChecks.of({
        start: (sessionId, generation) => {
          const executionId = recheckExecutionId(sessionId, generation)
          return ExecutionHost.intent(RecheckRole, { executionId, payload: { sessionId } }).pipe(
            Effect.flatMap((intent) => executions.getByName(executionId).start(intent)),
            Effect.provideService(RuntimeContext, runtime),
            Effect.catchCause((cause) =>
              Effect.logWarning("auth.role_check").pipe(
                Effect.annotateLogs({ sessionId, outcome: "not_started", errorCode: codeOf(Cause.squash(cause)) }),
              )
            ),
          )
        },
      })
    })

    /** Where ChatApi's routes start a remote flow (worker/Flows.ts): its own Durable Object, named by the execution id. */
    const flowStarter = Executions.starter(executions)

    return {
      fetch: Effect.gen(function* () {
        // A branch's box reaches its forge through this Worker's own entrypoint, with props naming its object
        // (worker/BranchSandboxes.ts): handed straight back to that object, never routed as a person's request.
        const box = BranchSandboxes.boxOf((yield* Cloudflare.WorkerExecutionContext).raw.props)
        if (box !== undefined) return yield* BranchSandboxes.answerBox(sandboxObjects, box)
        const request = yield* HttpServerRequest.HttpServerRequest
        const runtime = yield* RuntimeContext
        const limited = yield* Throttle.make({
          shape: { limit: (key) => shapeLimit.limit(key).pipe(Effect.provideService(RuntimeContext, runtime)) },
          telemetry: { limit: (key) => telemetryLimit.limit(key).pipe(Effect.provideService(RuntimeContext, runtime)) },
        })(request)
        if (Option.isSome(limited)) return limited.value
        const checks = Layer.succeed(SignIn.RoleChecks, yield* roleChecks)
        // Who is asking, and their role on a branch's repository for every branch check (decision 0079).
        const signedIn = Layer.mergeAll(checks, signIn.sessions.pipe(Layer.provide(checks)), BranchRoles.layer(roles))
        const starter = yield* flowStarter
        if (request.url.startsWith(`${AUTH_ROUTE}/`)) {
          // Signing out starts `auth/RevokeGitHubToken` through `starter` and answers once the start is recorded.
          return yield* signIn.fetch.pipe(Effect.provideService(Flows.FlowStarter, starter), Effect.provide(signedIn))
        }
        const path = request.url.split("?")[0]!
        if (BranchApi.handles(path)) {
          const sockets = Layer.effect(TerminalSockets, BranchSandboxes.terminalSocketsOver(sandboxObjects))
          const rooms = BranchRooms.roomsLayer(roomObjects)
          return yield* branchApi.fetch.pipe(
            Effect.provideService(Flows.FlowStarter, starter),
            Effect.provide(signedIn),
            Effect.provide(Layer.mergeAll(forge, sockets, rooms, directory, FetchHttpClient.layer)),
          )
        }
        // Before the repository routes: a write is `/api/repos/<owner>/<name>/writes`.
        if (SecretsApi.handles(path)) {
          return yield* secretsApi.fetch.pipe(
            Effect.provideService(Flows.FlowStarter, starter),
            Effect.provideService(SecretKeys, secretKeys),
            Effect.provide(signedIn),
          )
        }
        if (PersonalApi.handles(path)) {
          return yield* personalApi.fetch.pipe(
            Effect.provideService(Flows.FlowStarter, starter),
            Effect.provideService(SecretKeys, secretKeys),
            Effect.provide(personalModels),
            Effect.provide(signedIn),
            Effect.provide(FetchHttpClient.layer),
          )
        }
        if (BugsApi.handles(path)) {
          return yield* bugsApi.fetch.pipe(
            Effect.provideService(Flows.FlowStarter, starter),
            Effect.provide(signedIn),
            Effect.provide(FetchHttpClient.layer),
          )
        }
        if (DomainsApi.handles(path)) {
          return yield* domainsApi.fetch.pipe(
            Effect.provideService(Flows.FlowStarter, starter),
            Effect.provideService(DomainProvider, domainProvider),
            Effect.provide(signedIn),
          )
        }
        if (GitHubApi.handles(path)) {
          return yield* github.fetch.pipe(Effect.provideService(Flows.FlowStarter, starter), Effect.provide(signedIn))
        }
        // Before the repository routes too: a change is `/api/repos/<owner>/<name>/stack`. With the GitHub App and
        // `TODO_RUNS` on, this host runs TODOs: each attempt the writer starts runs `todo` on its own Durable Object
        // (decision 0016).
        if (StackApi.handles(path)) {
          const requestRuntime = yield* RuntimeContext
          return yield* (Option.isSome(githubApp) && runTodos
            ? stack.fetch.pipe(Effect.provideService(Stack.TodoRuns, TodoRuns.make(starter, (executionId) => executions.getByName(executionId).cancel().pipe(
              Effect.provideService(RuntimeContext, requestRuntime),
            ), (attemptId) => TodoRuns.isStopped(Layer.unwrap(Effect.map(hyperdrive.connectionString,
              (url) => ExecutionHost.readDatabase(Redacted.value(url), ExecutionHost.ENGINE_SCHEMA))))(attemptId).pipe(Effect.provideService(RuntimeContext, requestRuntime)))))
            : stack.fetch).pipe(Effect.provide(signedIn))
        }
        if (RemoteRuns.handles(path)) return yield* remoteRuns.fetch.pipe(Effect.provide(signedIn))
        // And a home, `/api/repos/<owner>/<name>/home` (docs/features/home.md): who the asker is and the curated home.
        if (HomeApi.handles(path)) return yield* home.fetch.pipe(Effect.provide(signedIn))
        // And docs, `/api/repos/<owner>/<name>/docs[/page]`: open to everyone, like the about read.
        if (DocsApi.handles(path)) return yield* docs.fetch.pipe(Effect.provide(docsSource))
        if (path === REPOS_ROUTE || path.startsWith(`${REPOS_ROUTE}/`) || path === REPOSITORIES_SHAPE_ROUTE) {
          return yield* repos.fetch.pipe(
            Effect.provideService(Flows.FlowStarter, starter),
            Effect.provide(signedIn),
            Effect.provide(repoCache),
          )
        }
        // Pages checked before they are framed are requested through the Worker's fetch, which reaches public addresses
        // only, and their answers kept in this Worker's Cache API (worker/WebPreview.ts).
        return yield* chat.fetch.pipe(
          Effect.provideService(Flows.FlowStarter, starter),
          // The model endpoint answers a person who saved a model of their own with it.
          Effect.provide(personalModels),
          Effect.provide(signedIn),
          Effect.provide(docsSource),
          Effect.provide(Layer.merge(FetchHttpClient.layer, webCache)),
        )
      }).pipe(Effect.provideService(Conversations.homeRepositoryNames, homeRepository), Effect.provide(logs)),
    }
  }).pipe(
    Effect.provide(Executions.live(ChatDatabase, {
      repositories,
      homeRepository,
      ...(options.dev === true ? { dev: true } : {}),
      ...(options.spendAlerts === undefined ? {} : { spendAlerts: options.spendAlerts }),
      ...(options.hostedModel === undefined ? {} : { hostedModel: options.hostedModel }),
    })),
    Effect.provide(BranchSandboxes.live(ChatDatabase)),
    Effect.provide(BranchRooms.live),
    Effect.provide(
      Layer.mergeAll(
        HostModel.layerConfig("CHAT_MODEL", DEFAULT_CHAT_MODEL),
        Cloudflare.Hyperdrive.ConnectBinding,
        Cloudflare.RateLimitBinding,
        Cloudflare.Telemetry({ persist: true }),
      ),
    ),
  )
