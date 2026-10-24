import * as Pg from "@effect/sql-pg"
import { PostgresDatabase } from "@smthrs/database"
import { DurableDeferred, type Flow, FlowRuntime } from "@smthrs/flow"
import type { Channels } from "@smthrs/notifications"
import { CloudflareRuntime, ExecutionObject } from "@smthrs/platform-cloudflare"
import { CiJob } from "@smthrs/sandbox"
import type { QuickJSVariant } from "@smthrs/harness"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import * as Dispatch from "./ci/Dispatch.ts"
import * as RepoFlow from "./ci/RepoFlow.ts"
import * as Checks from "./flows/Checks.ts"
import * as DatabaseLoad from "./flows/DatabaseLoad.ts"
import * as CiJobMachine from "./flows/CiJobMachine.ts"
import * as Expire from "./flows/Expire.ts"
import * as Pause from "./flows/Pause.ts"
import * as RecheckRole from "./flows/RecheckRole.ts"
import * as RepoClone from "./flows/RepoClone.ts"
import * as RevokeGitHubToken from "./flows/RevokeGitHubToken.ts"
import * as SandboxCall from "./flows/SandboxCall.ts"
import * as SandboxCommand from "./flows/SandboxCommand.ts"
import * as SandboxKeep from "./flows/SandboxKeep.ts"
import * as DomainFlows from "./domains/DomainFlows.ts"
import type { DomainProvider } from "./domains/Provider.ts"
import * as SecretFlows from "./secrets/SecretFlows.ts"
import * as ModelFlows from "./personal/ModelFlows.ts"
import * as SpendAlert from "./flows/SpendAlert.ts"
import * as TerminalOpen from "./flows/TerminalOpen.ts"
import type { Machines } from "./branch/Machines.ts"
import type { Sandboxes } from "./branch/Sandboxes.ts"
import * as Todo from "./flows/Todo.ts"
import * as TodoBaseClosed from "./flows/TodoBaseClosed.ts"
import * as TodoDrop from "./flows/TodoDrop.ts"
import type { Implement } from "./flows/TodoAgent.ts"
import * as GitHubHost from "./github/Host.ts"
import type * as Triage from "./github/Triage.ts"

// What a remote flow execution runs on Cloudflare (docs/features/remote-flows.md): `@smthrs/platform-cloudflare`'s
// per-execution Durable Object functions over the engine's Postgres schema. worker/Executions.ts hands it the Durable
// Object's storage and id under Alchemy; the workerd test hands it a plain Durable Object's. The flows themselves
// (worker/flows/) never see Cloudflare.

/** The Postgres schema the flow engine keeps its journal, runs and timers in, beside the app's tables. */
export const ENGINE_SCHEMA = "smithers_flows"

/**
 * The flows a remote execution may run, and the registration that implements their steps. The registration may need
 * the engine's `FlowRuntime`, which the runtime provides.
 */
export interface Flows<ROut, E, R> {
  readonly flows: ReadonlyArray<Flow.Any>
  readonly registration: Layer.Layer<ROut, E, R | FlowRuntime.FlowRuntime>
}

/**
 * The deployed remote flows: `probe/Pause`, whose steps log, `chat/Expire` over `app`: the app's own tables (not
 * the engine's schema) and how old a streaming answer gets before it settles (docs/features/agent.md#settling), and
 * `ops/SpendAlert` and `ops/DatabaseLoad` over the app's tables, sending through `channels`, the deployment's email and
 * Telegram providers (none by default; docs/features/spend-alerts.md#channels, docs/features/database-alerts.md).
 */
export const remote = <E, R>(app: Expire.Services<E, R>, channels?: Layer.Layer<Channels.Channels>) => ({
  flows: [Pause.Pause, Expire.Expire, SpendAlert.SpendAlert, DatabaseLoad.DatabaseLoad],
  registration: Layer.mergeAll(
    Pause.registration(Pause.logged),
    Expire.registration(app),
    SpendAlert.registration(app.database, channels),
    DatabaseLoad.registration(app.database, channels),
  ),
})

/**
 * The deployed remote flows when sign-in is configured: `remote`, plus `auth/RecheckRole` and
 * `auth/RevokeGitHubToken` over the app's tables and sign-in's services (docs/features/sign-in.md#role-checks,
 * #signing-out).
 */
export const remoteWithSignIn = <E, R>(
  app: Expire.Services<E, R>,
  services: RecheckRole.Services,
  channels?: Layer.Layer<Channels.Channels>,
) => {
  const base = remote(app, channels)
  return {
    flows: [...base.flows, RecheckRole.RecheckRole, RevokeGitHubToken.RevokeGitHubToken],
    registration: Layer.mergeAll(
      base.registration,
      RecheckRole.registration(app.database, services),
      RevokeGitHubToken.registration(app.database, services),
    ),
  }
}

/**
 * `flows`, plus `repo/Clone` over `services` (the app's tables, Code Storage and GitHub) when this deployment has a
 * Code Storage organization (docs/features/repo.md#the-clone).
 */
export const withRepoClone = <ROut, E, R, CE, CR>(flows: Flows<ROut, E, R>, services: RepoClone.Services<CE, CR>) => ({
  flows: [...flows.flows, RepoClone.Clone],
  registration: Layer.merge(flows.registration, RepoClone.registration(services)),
})

/**
 * `flows`, plus the git loop's `github/Apply`, `github/Reconcile`, `github/Write` and `triage/Run` when this deployment
 * has the GitHub App (docs/features/issues.md#remote-flows). `services` is built when each execution's registration is:
 * the host may read what it needs to start a session's role check from the execution's own context then.
 */
export const withGitHub = <ROut, E, R, GE, GR, SE, SR>(
  flows: Flows<ROut, E, R>,
  services: Effect.Effect<Triage.Services<GE, GR>, SE, SR>,
) => ({
  flows: [...flows.flows, ...GitHubHost.flows],
  registration: Layer.merge(flows.registration, Layer.unwrap(Effect.map(services, GitHubHost.registration))),
})

/**
 * `flows`, plus the coding factory's `todo` run and a pull request head's `checks/Run` (decision 0016, the factory
 * simplified; docs/features/todos.md#the-run) over `services`, the branches' machines (`machines`) and the agent's
 * `implement` (worker/flows/TodoAgent.ts `registration`), when this deployment has the GitHub App. A head's check scripts
 * run for up to `commandSeconds` (`SANDBOX_COMMAND_MAX_SECONDS`; `COMMAND_LIMIT_SECONDS` unless given), their step waiting
 * on each for up to `stepWaitSeconds` (`SANDBOX_COMMAND_STEP_WAIT_SECONDS`). `services` is built
 * when each execution's registration is, as `withGitHub`'s is. The agent's commands run as `sandbox/Command` jobs,
 * which `withSandboxTools` registers, so `flows` comes from it.
 */
export const withTodos = <ROut, E, R, SE, SR, DE, DR, ME, MR, IE, IR>(
  flows: Flows<ROut, E, R>,
  services: Effect.Effect<Todo.Services<DE, DR> & Checks.Services<DE, DR>, SE, SR>,
  machines: Layer.Layer<Machines, ME, MR>,
  implement: Layer.Layer<Layer.Success<typeof Implement.layer>, IE, IR>,
  commandSeconds?: number,
  stepWaitSeconds?: number,
) => ({
  flows: [...flows.flows, Todo.Todo, TodoDrop.Drop, TodoBaseClosed.Invalidate, Checks.ChecksRun],
  registration: Layer.mergeAll(
    flows.registration,
    Layer.unwrap(Effect.map(services, (built) =>
      Layer.mergeAll(
        Todo.registration(built, implement),
        TodoDrop.registration(built),
        TodoBaseClosed.registration(built),
        Checks.registration(built, commandSeconds, stepWaitSeconds),
      )
        .pipe(Layer.provide(machines))
    )),
  ),
})

/**
 * `flows`, plus `terminal/Open` over the app's tables and the branches' machines (`sandboxes`: on Cloudflare, the
 * `SandboxObject` namespace, worker/BranchSandboxes.ts), docs/features/branch-workspace.md#opening-a-terminal.
 */
export const withTerminals = <ROut, E, R, DE, DR, SE, SR>(
  flows: Flows<ROut, E, R>,
  database: Layer.Layer<SqlClient.SqlClient, DE, DR>,
  sandboxes: Layer.Layer<Sandboxes, SE, SR>,
) => ({
  flows: [...flows.flows, TerminalOpen.TerminalOpen],
  registration: Layer.merge(flows.registration, TerminalOpen.registration(database).pipe(Layer.provide(sandboxes))),
})

/**
 * `flows`, plus the sandbox tools' `sandbox/Call`, the machines' `sandbox/Keep` and the commands' `sandbox/Command` job
 * (its three declarations) over the app's tables and the branches' machines (`machines`: on Cloudflare, the
 * `SandboxObject` namespace, worker/BranchSandboxes.ts), docs/features/sandbox-tools.md. The `todo` run's agent
 * (`withTodos`) runs its commands as the same job, so a host with TODOs composes this too.
 */
export const withSandboxTools = <ROut, E, R, DE, DR, ME, MR>(
  flows: Flows<ROut, E, R>,
  database: Layer.Layer<SqlClient.SqlClient, DE, DR>,
  machines: Layer.Layer<Machines, ME, MR>,
  idleMs?: number,
) => ({
  flows: [...flows.flows, SandboxCall.SandboxCall, SandboxKeep.Keep, ...SandboxCommand.Command.flows],
  registration: Layer.mergeAll(
    flows.registration,
    SandboxCall.registration(database).pipe(Layer.provide(machines)),
    SandboxKeep.registration(database, idleMs).pipe(Layer.provide(machines)),
    SandboxCommand.registration.pipe(Layer.provide(machines)),
  ),
})

/**
 * `flows`, plus `@smthrs/sandbox`'s `ci/job`: one CI job on its own machine (`machines`: on Cloudflare, the
 * `SandboxObject` namespace, worker/BranchSandboxes.ts), docs/features/ci.md#jobs.
 */
export const withCiJobs = <ROut, E, R, ME, MR>(
  flows: Flows<ROut, E, R>,
  machines: Layer.Layer<Machines, ME, MR>,
) => ({
  flows: [...flows.flows, CiJob.CiJob],
  registration: Layer.mergeAll(
    flows.registration,
    CiJobMachine.registration(machines),
  ),
})

/**
 * `flows`, plus a repository's own flows, `repo/Run` and its `repo/Jobs` child, over `services` (Postgres and GitHub as
 * the App) and the realm's QuickJS build (`variant`), docs/features/ci.md#repository-flows. Their jobs are `ci/job`s
 * (`withCiJobs`).
 */
export const withRepoFlows = <ROut, E, R, SE, SR, DE, DR, VE, VR>(
  flows: Flows<ROut, E, R>,
  services: Effect.Effect<RepoFlow.Services<DE, DR>, SE, SR>,
  variant: Layer.Layer<QuickJSVariant.Variant, VE, VR>,
) => ({
  flows: [...flows.flows, RepoFlow.Run, RepoFlow.Jobs],
  registration: Layer.mergeAll(
    flows.registration,
    Layer.unwrap(Effect.map(services, (built) => RepoFlow.registration(built, variant))),
  ),
})

/**
 * `flows`, plus `triggers/Dispatch`: a push's or a pull request's matching repository flows, started over `services`
 * (Postgres, GitHub as the App, and where a run starts), docs/features/ci.md#triggers.
 */
export const withTriggers = <ROut, E, R, SE, SR, DE, DR>(
  flows: Flows<ROut, E, R>,
  services: Effect.Effect<Dispatch.Services<DE, DR>, SE, SR>,
) => ({
  flows: [...flows.flows, Dispatch.Dispatch],
  registration: Layer.mergeAll(flows.registration, Layer.unwrap(Effect.map(services, Dispatch.registration))),
})

/**
 * `flows`, plus `secret/Put` and `secret/Delete` over the app's tables: an Admin's writes of a repository's sealed
 * secrets (docs/features/secrets.md#writing).
 */
export const withSecrets = <ROut, E, R, DE, DR>(
  flows: Flows<ROut, E, R>,
  database: Layer.Layer<SqlClient.SqlClient, DE, DR>,
) => ({
  flows: [...flows.flows, SecretFlows.Put, SecretFlows.Delete],
  registration: Layer.merge(flows.registration, SecretFlows.registration(database)),
})

/**
 * `flows`, plus `model/Put` and `model/Delete` over the app's tables: a person's own model, its key sealed before it
 * reaches either (docs/features/personal-model.md#saving).
 */
export const withPersonalModels = <ROut, E, R, DE, DR>(
  flows: Flows<ROut, E, R>,
  database: Layer.Layer<SqlClient.SqlClient, DE, DR>,
) => ({
  flows: [...flows.flows, ModelFlows.Put, ModelFlows.Delete],
  registration: Layer.merge(flows.registration, ModelFlows.registration(database)),
})

/**
 * `flows`, plus `domain/Verify` and `domain/Remove` over the app's tables, reaching `provider`: a Maintainer's custom
 * domains (docs/features/domains.md#flows).
 */
export const withDomains = <ROut, E, R, DE, DR>(
  flows: Flows<ROut, E, R>,
  database: Layer.Layer<SqlClient.SqlClient, DE, DR>,
  provider: Layer.Layer<DomainProvider>,
) => ({
  flows: [...flows.flows, DomainFlows.Verify, DomainFlows.Remove],
  registration: Layer.merge(flows.registration, DomainFlows.registration(database, provider)),
})

/**
 * The slice of a Durable Object's storage the handlers use; `R` is what its methods require (Alchemy's
 * `RuntimeContext`, or nothing for a plain object's).
 */
export type Storage<R = never> = ExecutionObject.Storage<R>

/**
 * What a caller hands `start`: the flow by tag, the execution id (which also names the Durable Object) and the
 * payload, encoded with the flow's own codec (`ExecutionObject.intent`).
 */
export const intent = ExecutionObject.intent

/** How long a settled execution's Durable Object keeps its state before its alarm forgets it. */
export const settledRetentionMs = ExecutionObject.settledRetentionMs

/**
 * `EXECUTION_DRIVE_BUDGET_SECONDS` (600 unless set), in milliseconds: how long one alarm's drive keeps starting steps
 * before it yields and the alarm goes on at once, under Cloudflare's 15-minute alarm limit
 * (`ExecutionObject.driveBudget`).
 */
export const driveBudget = ExecutionObject.driveBudget

/**
 * Records `intent` on one execution's Durable Object `storage` and wakes it at once (`ExecutionObject.start`): the
 * same intent again changes nothing, and another under the same execution id fails with `IntentConflict`.
 */
export const recordStart = <RS>(storage: ExecutionObject.Storage<RS>, intent: ExecutionObject.Intent) =>
  ExecutionObject.start(storage, intent, Effect.void)

/**
 * The engine's `SqlClient` on the Postgres at `url`, in `schema` (`ENGINE_SCHEMA` when deployed). Every statement
 * sets the schema inside its own transaction, so it holds behind Hyperdrive's transaction pooling.
 */
export const database = (url: string, schema: string): Layer.Layer<SqlClient.SqlClient> =>
  PostgresDatabase.layer({ url, driver: Pg, schema })

/**
 * A reader of the engine's `schema` on the Postgres at `url`, for a route that shows a run (worker/RemoteRuns.ts): it
 * never creates the schema or takes the engine's writer lock, and every transaction is `READ ONLY`.
 */
export const readDatabase = (url: string, schema: string): Layer.Layer<SqlClient.SqlClient> =>
  PostgresDatabase.layer({ url, driver: Pg, schema, readOnly: true })

/**
 * The handlers of one execution's Durable Object over its `storage`:
 * - `start` records the intent and wakes the object at once (`ExecutionObject.start`); the same intent again is a
 *   no-op, and a different one fails with `IntentConflict`.
 * - `wake` moves the alarm to now when the object holds an intent (`ExecutionObject.wake`); another object's alarm
 *   calls it through its router when this execution became due.
 * - `alarm` builds the engine for that one execution, as `hostId`, over `database`, drives it until it settles, parks
 *   or spends `driveBudgetMs` ({@link driveBudget}), hands the executions it left for other objects to `router`, then
 *   arms the next wake (`ExecutionObject.alarm`). It never fails: a failure re-arms the alarm with backoff.
 *
 * `database` is a layer, so each alarm opens its own connection and closes it when the alarm ends. `router` reaches
 * other objects of the same class by execution id. `afterAlarm` runs once each alarm is done, whatever it did, and
 * fails nothing: on Cloudflare it starts the window's `ops/DatabaseLoad` (`DatabaseLoad.sampler`). `settled` runs with
 * the execution id after each alarm that finds the run settled, and the one that forgets it, and fails nothing: on
 * Cloudflare it settles a repository run's row (worker/RepoRuns.ts `settle`).
 */
export const make = <RS, RD, ROut, E, R, RE, RR, RA = never, RT = never>(
  storage: ExecutionObject.Storage<RS>,
  options: {
    readonly hostId: string
    readonly database: Layer.Layer<SqlClient.SqlClient, never, RD>
    readonly flows: Flows<ROut, E, R>
    readonly router: ExecutionObject.Router<RE, RR>
    readonly afterAlarm?: Effect.Effect<void, never, RA>
    readonly settled?: (executionId: string) => Effect.Effect<void, never, RT>
    readonly driveBudgetMs?: number | undefined
    readonly canStart?: ((intent: ExecutionObject.Intent) => Effect.Effect<boolean, never, RD>) | undefined
  },
) => {
  const { flows, registration } = options.flows
  const object = ExecutionObject.make(storage, {
    flows,
    runtime: (intent) =>
      CloudflareRuntime.layer(
        { hostId: options.hostId, executionId: intent.executionId, flow: intent.flow },
        registration,
      ).pipe(Layer.provide(options.database)),
    router: options.router,
    canStart: options.canStart,
    driveBudgetMs: options.driveBudgetMs,
    afterAlarm: options.afterAlarm,
  })
  /** The stored intent's execution id. */
  const executionId = Effect.map(
    storage.get<string>(ExecutionObject.intentKey),
    (raw) => Option.flatMap(Option.fromNullishOr(raw), (text) => Option.map(decodeIntent(text), (intent) => intent.executionId)),
  )
  return {
    ...object,
    /** Persist before waking: a delivery racing the park, or repeated after a crash, is not lost. */
    signal: (deferredName: string) => Effect.scoped(Effect.gen(function* () {
      const raw = yield* storage.get<string>(ExecutionObject.intentKey)
      if (raw === undefined) return
      const intent = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ExecutionObject.Intent))(raw)
      const deferred = DurableDeferred.make(deferredName, { success: Schema.Json })
      yield* Effect.flatMap(FlowRuntime.FlowRuntime, (engine) => engine.deferredDone(deferred, {
        flowName: intent.flow, executionId: intent.executionId, deferredName, exit: Exit.succeed(null),
      })).pipe(Effect.provide(CloudflareRuntime.layer(
        { hostId: options.hostId, executionId: intent.executionId, flow: intent.flow }, registration,
      ).pipe(Layer.provide(options.database))))
      yield* ExecutionObject.wake(storage)
    })).pipe(Effect.orDie),

    alarm: () =>
      Effect.gen(function* () {
        const settled = options.settled
        // Read before the alarm: the alarm that forgets the run deletes its intent.
        const id = settled === undefined ? Option.none<string>() : yield* executionId
        const outcome = yield* object.alarm()
        if (settled !== undefined && Option.isSome(id) && (outcome._tag === "Settled" || outcome._tag === "Forgotten")) {
          yield* settled(id.value)
        }
        return outcome
      }),
  }
}

const decodeIntent = Schema.decodeUnknownOption(Schema.fromJsonString(ExecutionObject.Intent))
