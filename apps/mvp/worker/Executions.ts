import * as Cloudflare from "@alchemy.run/cloudflare"
import { Logger } from "@smthrs/observability"
import { EdgeCache, type ExecutionObject } from "@smthrs/platform-cloudflare"
import { RuntimeContext } from "alchemy"
import { Cause, Effect, Layer, Option, Predicate, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import type { SqlClient } from "effect/sql"
import * as Database from "../db/Database.ts"
import { applyExecutionId } from "../src/features/issues/contract.ts"
import { todoExecutionId } from "../src/features/pulls/contract.ts"
import { repoId } from "../src/features/repo/contract.ts"
import { commandMaxSeconds } from "../src/features/sandbox/config.ts"
import { keepExecutionId } from "../src/features/sandbox/contract.ts"
import * as AgentSandbox from "./AgentSandbox.ts"
import * as AlertChannels from "./AlertChannels.ts"
import * as Conversations from "./branch/Conversations.ts"
import { Forge } from "./branch/Forge.ts"
import * as GitHubCreation from "./branch/GitHubCreation.ts"
import * as JobMachines from "./branch/JobMachines.ts"
import * as BranchSandboxes from "./BranchSandboxes.ts"
import * as Cron from "./ci/Cron.ts"
import * as RepoFlow from "#vibelang/emitted/worker/ci/RepoFlow"
import * as DomainsConfig from "#vibelang/emitted/worker/domains/Config"
import { DomainProvider } from "#vibelang/emitted/worker/domains/Provider"
import { recorded } from "./DurableObjectFailure.ts"
import { codeOf } from "#vibelang/emitted/worker/ErrorCode"
import * as ExecutionHost from "./ExecutionHost.ts"
import * as Flows from "#vibelang/emitted/worker/Flows"
import * as DatabaseLoad from "./flows/DatabaseLoad.ts"
import * as Expire from "./flows/Expire.ts"
import * as FleetAlert from "./flows/FleetAlert.ts"
import { recheckExecutionId, RecheckRole } from "./flows/RecheckRole.ts"
import * as RedactFeed from "./flows/RedactFeed.ts"
import * as SandboxCommand from "./flows/SandboxCommand.ts"
import * as SandboxKeep from "#vibelang/emitted/worker/flows/SandboxKeep"
import * as SandboxSpend from "./flows/SandboxSpend.ts"
import * as Todo from "./flows/Todo.ts"
import * as TodoAgent from "./flows/TodoAgent.ts"
import * as TodoBaseClosed from "./flows/TodoBaseClosed.ts"
import * as TodoMachine from "./flows/TodoMachine.ts"
import { pullClosed } from "./flows/TodoWait.ts"
import * as GitHubApply from "#vibelang/emitted/worker/github/Apply"
import * as GitHubHost from "./github/Host.ts"
import * as HyperdrivePool from "./HyperdrivePool.ts"
import * as ModelEndpoint from "./ModelEndpoint.ts"
import * as ModelFlows from "./personal/ModelFlows.ts"
import { PersonalModels } from "./personal/Models.ts"
import * as Placement from "./Placement.ts"
import * as RepoConfig from "./RepoConfig.ts"
import * as RepoRuns from "./RepoRuns.ts"
import * as Fleet from "./runners/Fleet.ts"
import * as Overflow from "./runners/Overflow.ts"
import { SecretKeys } from "./secrets/Keys.ts"
import * as SessionStore from "./SessionStore.ts"
import * as SignIn from "./SignIn.ts"
import * as TodoRuns from "./stack/TodoRuns.ts"

// The Durable Object that runs remote flows on Cloudflare (docs/features/remote-flows.md): one object per execution,
// named by its execution id, hosted by ChatApi. Alchemy runs its handlers; they delegate to worker/ExecutionHost.ts,
// which the workerd test drives the same way.

/**
 * What a caller sees: `start` records an intent and wakes the object; `wake` makes its execution due again, for
 * another object whose drive left it due; `alarm` is Cloudflare's wake-up; `cancel` stops its run.
 */
export interface FlowExecutionShape {
  readonly start: (
    intent: ExecutionObject.Intent
  ) => Effect.Effect<void, ExecutionObject.IntentConflict, RuntimeContext>
  readonly repositoryRun: () => Effect.Effect<RepoRuns.Admitted | null, never, RuntimeContext>
  readonly signal: (deferredName: string) => Effect.Effect<void, never, RuntimeContext>
  /** Records a person's answer for the open attempt of a human task its run is parked on: whether the run took it. */
  readonly answer: (task: string, value: typeof Schema.Json.Type) => Effect.Effect<boolean, never, RuntimeContext>
  readonly wake: () => Effect.Effect<boolean, never, RuntimeContext>
  readonly cancel: () => Effect.Effect<void, import("@smthrs/flow").FlowRuntime.CancelRequestFailed, RuntimeContext>
  readonly alarm: () => Effect.Effect<void, never, RuntimeContext>
  /** Drive an admitted execution immediately through the same durable host as its alarm. */
  readonly advance: () => Effect.Effect<void, never, RuntimeContext>
}

/** The `FlowExecution` Durable Object namespace. A caller reaches one execution with `getByName(executionId)`. */
export class FlowExecution extends Cloudflare.DurableObject<FlowExecution, FlowExecutionShape>()("FlowExecution") {}

/** What `starter` reaches an execution's object through: the namespace, from ChatApi or from another execution. */
export interface Objects {
  readonly getByName: (executionId: string) => {
    readonly start: FlowExecutionShape["start"]
  }
}

/**
 * Where a request's or an alarm's code starts a remote flow (worker/Flows.ts): its own Durable Object, named by the
 * execution id, with the runtime of the request or alarm that builds it. The same intent again is a no-op; another
 * payload under the id is `StartConflict`; any other failure, the payload's encoding or the object's RPC, is
 * `StartUnavailable` with its code.
 */
export const starter = (objects: Objects) =>
  Effect.gen(function*() {
    const runtime = yield* RuntimeContext
    return Flows.FlowStarter.of({
      // The caller built `payload` as this flow's own schema types it; `Flow.Any` can't say so in its type.
      start: (flow, { executionId, payload }) =>
        ExecutionHost.intent(flow, { executionId, payload: payload as never }).pipe(
          Effect.flatMap((intent) => objects.getByName(executionId).start(intent)),
          Effect.provideService(RuntimeContext, runtime),
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause)
            return Effect.fail(
              Predicate.isTagged(error, "@smthrs/platform-cloudflare/IntentConflict")
                ? new Flows.StartConflict()
                : new Flows.StartUnavailable({ errorCode: codeOf(error) })
            )
          })
        )
    })
  })

/** What `answerer` reaches an execution's object through: the namespace, from ChatApi. */
export interface Answerers {
  readonly getByName: (executionId: string) => {
    readonly answer: FlowExecutionShape["answer"]
  }
}

/**
 * Where a person's answer reaches a remote run parked on a human task (worker/Flows.ts `TaskAnswers`): the execution's
 * own Durable Object, with the runtime of the request that builds it. A failed RPC is `AnswerUnavailable` with its code.
 */
export const answerer = (objects: Answerers) =>
  Effect.gen(function*() {
    const runtime = yield* RuntimeContext
    return Flows.TaskAnswers.of({
      answer: (executionId, task, value) =>
        objects.getByName(executionId).answer(task, value).pipe(
          Effect.provideService(RuntimeContext, runtime),
          Effect.catchCause((cause) => Effect.fail(new Flows.AnswerUnavailable({ errorCode: codeOf(Cause.squash(cause)) })))
        )
    })
  })

/**
 * The object's implementation over `connection`, the Hyperdrive config the engine reaches Postgres through. Its id is
 * the engine's host id, the same for every incarnation of the object, so a new incarnation takes over its run at once.
 * `dev` (`alchemy dev` only) lets an alert provider pointed at a local fake send without its key
 * (worker/AlertChannels.ts `channelsConfig`). Each alarm, once done, starts its window's `ops/DatabaseLoad` and
 * `ops/SandboxSpend` (docs/features/sandbox-budgets.md)
 * (docs/features/database-alerts.md): the window this isolate last started is built with the layer, once per isolate,
 * not with each object.
 */
interface ProgramOptions {
  readonly dev?: boolean
  readonly spendAlerts?: boolean
  /** `HOSTED_MODEL_ENABLED`'s default: on only under `alchemy dev` (decision 0099). */
  readonly hostedModel?: boolean
  readonly repositories: ReadonlySet<string>
  readonly homeRepository: { readonly owner: string; readonly name: string }
  /** `REPO_FLOWS`: whether repositories' flows run, their schedules' ticks included (docs/features/ci.md#schedules). */
  readonly repoFlows?: boolean
}

export const live = <E, R>(
  connection: Effect.Effect<Cloudflare.Hyperdrive.Connection, E, R>,
  options: ProgramOptions
) =>
  Layer.unwrap(Effect.map(
    Effect.all([DatabaseLoad.sampler, SandboxSpend.sampler, FleetAlert.sampler, RedactFeed.launcher, Cron.ticker]),
    // Each alarm starts its window's database sample, then its window's sandbox spend (docs/features/sandbox-budgets.md),
    // then its window's look at the runners (docs/features/fleet.md#alerts), then each confirmed feed barrier's pass not
    // yet completed (docs/features/notifications.md#rows-written-before), and, with repositories' flows on, the
    // minute's schedules tick (docs/features/ci.md#schedules).
    ([sampleLoad, sampleSpend, sampleRunners, redactFeed, tick]) =>
      object(
        connection,
        options,
        Effect.andThen(Effect.andThen(sampleLoad, sampleSpend), sampleRunners),
        redactFeed,
        options.repoFlows === true ? tick : Effect.void
      )
  ))

/** One object, whose alarms start the window's `ops/DatabaseLoad` through `sampleLoad`. */
const object = <E, R>(
  connection: Effect.Effect<Cloudflare.Hyperdrive.Connection, E, R>,
  options: ProgramOptions,
  sampleLoad: Effect.Effect<void, never, Flows.FlowStarter>,
  redactFeed: Effect.Effect<void, never, Flows.FlowStarter | SqlClient.SqlClient>,
  tick: Effect.Effect<void, never, Flows.FlowStarter>
) =>
  FlowExecution.make(
    Effect.gen(function*() {
      const state = yield* Cloudflare.DurableObjectState
      // This class's own namespace: the router reaches any other execution's object through it, creating each one where
      // the deployment places them (`FLOW_EXECUTION_LOCATION`, worker/Placement.ts).
      const executions = Placement.placed(
        (yield* Cloudflare.DurableObject) as Cloudflare.DurableObject<FlowExecutionShape>,
        yield* Placement.location.pipe(Effect.orDie)
      )
      const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(connection)
      const database = Layer.unwrap(
        Effect.map(
          hyperdrive.connectionString,
          (url) => ExecutionHost.database(Redacted.value(url), ExecutionHost.ENGINE_SCHEMA)
        )
      )
      // Sign-in's role checks (`auth/RecheckRole`) run here too when sign-in is configured. They write the app's own
      // tables, so they reach Postgres through the app's client, not the engine's schema.
      const signIn = yield* SignIn.configured().pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie)
      const roleFreshMs = yield* SessionStore.roleFreshMs.pipe(Effect.orDie)
      const appDatabase = Database.layer(hyperdrive.connectionString)
      // The schedules' trigger store, in its own schema on the same Postgres (docs/features/ci.md#schedules).
      const triggerStore = Cron.storeOn(Layer.unwrap(Effect.map(
        hyperdrive.connectionString,
        (url) => ExecutionHost.database(Redacted.value(url), Cron.TRIGGERS_SCHEMA)
      )))
      // `chat/Expire` settles answers their devices left streaming (docs/features/agent.md#settling).
      const app = { database: appDatabase, expiry: yield* Expire.expiry.pipe(Effect.orDie) }
      // How long one alarm's drive keeps starting steps, under Cloudflare's 15-minute alarm limit
      // (docs/features/remote-flows.md#how-an-execution-runs).
      const driveBudgetMs = yield* ExecutionHost.driveBudget.pipe(Effect.orDie)
      // The fleet's thresholds: stalls, waits, offline runners and run cost (docs/features/fleet.md#settings).
      const fleet = yield* Fleet.settings.pipe(Effect.orDie)
      // The longest command the TODO agent's run tool takes (docs/features/sandbox-tools.md#configuration).
      const commandSeconds = yield* commandMaxSeconds.pipe(Effect.orDie)
      // How long a step waits on its command itself before the command goes on as its job (docs/features/sandbox-tools.md).
      const stepWaitSeconds = yield* SandboxCommand.stepWaitSeconds.pipe(Effect.orDie)
      // `repo/Clone` runs here when this deployment has a Code Storage organization (docs/features/repo.md#the-clone).
      // Its Index reads the file list into the same immutable cache RepoApi reads from.
      const repoClone = yield* RepoConfig.cloneServices(
        appDatabase,
        EdgeCache.layer({ name: "repo" }).pipe(Layer.orDie)
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.orDie
      )
      // Resync moves a published branch's Smithers branch on the deployment's forge (docs/features/branch-publish.md#resync).
      const forge = Layer.succeed(
        Forge,
        yield* Effect.service(Forge).pipe(Effect.provide(Forge.layerConfig), Effect.provide(FetchHttpClient.layer))
      )
      // The git loop's flows (`github/Apply`, `github/Reconcile`, `github/Write`, `triage/Run`) run here when the GitHub
      // App is configured (docs/features/issues.md#remote-flows). Triage decides with the `judge` model role, admitted
      // and metered in process as the model endpoint's calls are (docs/features/issues.md#triage).
      const repositories = options.repositories
      const idleMs = (yield* SandboxKeep.idleSeconds.pipe(Effect.orDie)) * 1000
      const creationSettings = yield* GitHubCreation.settings.pipe(Effect.orDie)
      const github = yield* GitHubHost.ready(appDatabase).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie)
      // Each admitted call of a server seat starts its window's spend alert, as the endpoint's calls do: `spendAlerts`,
      // which only `alchemy dev` sets, to `false`, is `MODEL_SPEND_ALERTS`' default (docs/features/spend-alerts.md).
      // A person's own model answers their `todo` runs, its key opened under SECRETS_KEY for each call
      // (docs/features/personal-model.md#todo-runs).
      // What steps holding a person's credentials read: Config, here, as a step can't.
      const credentials = yield* ModelFlows.captureCredentials.pipe(Effect.orDie)
      const seats = yield* ModelEndpoint.local(appDatabase, {
        ...(options.spendAlerts === undefined ? {} : { alerts: options.spendAlerts }),
        ...(options.hostedModel === undefined ? {} : { hosted: options.hostedModel })
      }).pipe(
        Effect.provide(PersonalModels.layer(appDatabase).pipe(Layer.provide(SecretKeys.layerConfig))),
        Effect.orDie
      )
      // A run's person, and whether the deployment pays for the calls their own model doesn't answer: only its own
      // Members' (ruling AUTH-8).
      const ownedBy = (personId: string) =>
        Effect.map(
          SessionStore.deploymentMember(personId),
          (deploymentPays) => Option.some({ personId, deploymentPays })
        )
      // A `todo` run's committer.
      const todoOwner = (executionId: string) =>
        TodoMachine.ownerOf(executionId).pipe(
          Effect.flatMap(Option.match({ onNone: () => Effect.succeedNone, onSome: ownedBy })),
          Effect.provide(appDatabase)
        )
      // `ops/SpendAlert` sends by email and Telegram through the deployment's providers, from its secrets
      // (docs/features/spend-alerts.md#channels).
      const alertChannels = yield* AlertChannels.channelsConfig(options).pipe(Effect.orDie)
      // `ops/DatabaseLoad` reads Hyperdrive's pools too when the deployment has an analytics token (decision 0150).
      const pool = yield* HyperdrivePool.fromConfig.pipe(
        Effect.flatMap(Option.match({
          onNone: () => Effect.succeed(undefined),
          onSome: (poolOptions) => HyperdrivePool.make(poolOptions).pipe(Effect.provide(FetchHttpClient.layer))
        })),
        Effect.orDie
      )
      // `domain/Verify` and `domain/Remove` reach the deployment's domain provider (docs/features/domains.md).
      const domains = yield* DomainsConfig.provider(options).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie)
      // `terminal/Open` wakes a branch's machine, its `SandboxObject` (docs/features/branch-workspace.md#opening-a-terminal).
      const sandboxObjects = (yield* BranchSandboxes.SandboxObject) as Cloudflare.DurableObject<
        BranchSandboxes.SandboxObjectShape
      >
      // A `ci/job` naming a job machine runs on that machine's objects (docs/features/ci.md#machines): the gate's,
      // when the deployment declares it.
      const declaredMachines = yield* JobMachines.declared.pipe(Effect.orDie)
      const machineObjects = BranchSandboxes.namespaces(
        sandboxObjects,
        declaredMachines.includes(JobMachines.GATE)
          ? (yield* BranchSandboxes.GateObject) as Cloudflare.DurableObject<BranchSandboxes.SandboxObjectShape>
          : undefined
      )
      // Workers Logs keeps every JSON line, as it does ChatApi's.
      const logs = Logger.layerStructuredJson()
      // The object's id exists only at runtime: Alchemy evaluates this outer effect at plan time with a stand-in state.
      return Effect.sync(() => {
        // Where a server seat's call starts its window's spend alert, and an alarm its window's database sample: this
        // alarm's own runtime, on the started execution's object.
        const flowStarter = starter(executions)
        const hostFor = <ROut, FE, FR>(flows: ExecutionHost.Flows<ROut, FE, FR>) =>
          ExecutionHost.make(state.storage, {
            hostId: state.id.toString(),
            database,
            signingKeyIds: Option.match(signIn, {
              onNone: () => ["legacy"],
              onSome: (configured) => configured.keys.keyIds
            }),
            roleFreshMs,
            flows: {
              ...flows,
              registration: Layer.unwrap(Effect.map(flowStarter, (started) =>
                flows.registration.pipe(
                  Layer.provide(Layer.succeed(Flows.FlowStarter, started)),
                  Layer.provide(Layer.succeed(GitHubCreation.Settings, creationSettings)),
                  Layer.provide(Layer.succeed(Conversations.homeRepositoryNames, options.homeRepository))
                )))
            },
            driveBudgetMs,
            canStart: (intent) => TodoRuns.canStart(intent).pipe(Effect.provide(appDatabase), Effect.orDie),
            router: {
              // A feed redaction round's handoff is recorded on its barrier, where a claim wakes a stalled pass.
              start: RedactFeed.recordingHandoffs(
                (intent) => executions.getByName(intent.executionId).start(intent),
                appDatabase
              ),
              wake: (executionId) => Effect.asVoid(executions.getByName(executionId).wake())
            },
            // The schedules' tick needs `triggers/Tick` registered: only a host with the GitHub App has it.
            afterAlarm: Effect.flatMap(flowStarter, (started) =>
              Effect.andThen(
                Effect.andThen(sampleLoad, Option.isSome(github) ? tick : Effect.void),
                redactFeed.pipe(Effect.provide(appDatabase), Effect.orDie)
              ).pipe(
                Effect.provideService(Flows.FlowStarter, started)
              )),
            // A repository's run settles its row from the engine's status and its reported result (docs/features/actions.md), and a `todo` run
            // that ended in a defect fails its TODO `crashed` and starts the TODOs that frees (docs/features/todos.md).
            settled: (executionId) =>
              Effect.all([
                RepoRuns.settle(executionId, database, RepoFlow.reportedFailure(executionId, database)).pipe(
                  Effect.provide(appDatabase),
                  Effect.asVoid,
                  // The alarm that forgets the run a day later tries once more.
                  Effect.catchCause((cause) =>
                    Effect.logWarning("repo.run.settle").pipe(
                      Effect.annotateLogs({
                        runId: executionId,
                        outcome: "failed",
                        errorCode: codeOf(Cause.squash(cause))
                      })
                    )
                  )
                ),
                Effect.flatMap(
                  flowStarter,
                  (started) => TodoRuns.settleCrashed(executionId, database, FleetAlert.startWith(started))
                ).pipe(
                  Effect.provide(appDatabase),
                  Effect.flatMap((starts) =>
                    Effect.flatMap(flowStarter, (started) =>
                      Effect.forEach(starts, (start) =>
                        started.start(Todo.Todo, { executionId: todoExecutionId(start.attemptId), payload: start })
                          .pipe(
                            Effect.catchTag("@smthrs/mvp/flows/StartConflict", () =>
                              Effect.void)
                          ), { discard: true }))
                  ),
                  // The alarm that forgets the run a day later reports again: the writer answers the same report with
                  // the same starts (`repeated`), and starting one again changes nothing.
                  Effect.catchCause((cause) =>
                    Effect.logWarning("todo.crashed").pipe(
                      Effect.annotateLogs({
                        runId: executionId,
                        outcome: "failed",
                        errorCode: codeOf(Cause.squash(cause))
                      })
                    )
                  )
                )
              ], { discard: true })
          })
        // Each wake of a branch's machine starts that generation's `sandbox/Keep` on its own object, once
        // (docs/features/sandbox-tools.md#sleep-and-wake); a job machine's keep names it, so it asks that machine.
        const keep: BranchSandboxes.Keep = (branchId, generation, machine) => {
          const executionId = keepExecutionId(branchId, generation)
          const payload = machine === undefined ? { branchId, generation } : { branchId, generation, machine }
          return ExecutionHost.intent(SandboxKeep.Keep, { executionId, payload }).pipe(
            Effect.flatMap((intent) => executions.getByName(executionId).start(intent)),
            Effect.catchCause((cause) =>
              Effect.logWarning("sandbox.keep.start").pipe(
                Effect.annotateLogs({ branchId, generation, errorCode: codeOf(Cause.squash(cause)) })
              )
            )
          )
        }
        // `secret/Put` and `secret/Delete` write an Admin's sealed secrets (docs/features/secrets.md#writing), and
        // `model/Put` and `model/Delete` a person's own model (docs/features/personal-model.md#saving). The
        // Sandbox tools, custom domains, CI jobs, and an Admin's runner machines and external agents
        // (docs/features/agent-runners.md#admin) share the remote host.
        // The fleet's alerts (docs/features/fleet.md#alerts): an incident's `ops/FleetAlert` runs on its own object,
        // started through this alarm's runtime.
        const raiser = Effect.map(flowStarter, FleetAlert.startWith)
        // An agent's question to one person waits on its own object for their answer
        // (docs/features/agent-status.md#addressed-waits).
        const base = ExecutionHost.withAsks(ExecutionHost.withFeedRedaction(
          ExecutionHost.withFleet(
            ExecutionHost.withRunners(
              ExecutionHost.withCiJobs(
                ExecutionHost.withDomains(
                  ExecutionHost.withPersonalModels(
                    ExecutionHost.withSecrets(
                      ExecutionHost.withSandboxTools(
                        ExecutionHost.withTerminals(
                          Option.isSome(signIn)
                            ? ExecutionHost.remoteWithSignIn(app, signIn.value, alertChannels, pool)
                            : ExecutionHost.remote(app, alertChannels, pool),
                          appDatabase,
                          BranchSandboxes.sandboxesLayer(sandboxObjects, keep)
                        ),
                        appDatabase,
                        BranchSandboxes.machinesLayer(machineObjects, keep),
                        idleMs
                      ),
                      appDatabase
                    ),
                    appDatabase,
                    credentials
                  ),
                  appDatabase,
                  Layer.succeed(DomainProvider, domains)
                ),
                BranchSandboxes.machinesLayer(machineObjects, keep)
              ),
              appDatabase
            ),
            appDatabase,
            repoId(options.homeRepository.owner, options.homeRepository.name),
            fleet,
            raiser,
            alertChannels
          ),
          appDatabase
        ), appDatabase)
        // A person's write whose GitHub token is about to expire starts the session's `auth/RecheckRole` on its own
        // object, the one redeemer of the refresh token, with the execution's own runtime context. Triage and a head's
        // review run on the `judge` and `review` roles, admitted and metered as the endpoint's calls are: triage's on
        // the model of the person who enabled it, a review on its TODO owner's (ruling AUTH-8).
        const githubServices = <GE, GR>(ready: GitHubHost.Ready<GE, GR>) =>
          Effect.gen(function*() {
            const runtime = yield* RuntimeContext
            const started = yield* flowStarter
            const judge = (enabledBy: string) =>
              seats("judge", started, () => ownedBy(enabledBy).pipe(Effect.provide(appDatabase)))
            const services = GitHubHost.services(ready, {
              keys: Option.map(signIn, (configured) => configured.keys),
              refresh: (sessionId, generation) => {
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
            }, judge)
            return {
              ...services,
              // A head's review is its TODO owner's, on the `review` role (`hard` tier, decision 0107): their own model
              // reviews it when they saved one (decision 0099).
              reviewerFor: (ownerId: string) =>
                seats("review", started, () => ownedBy(ownerId).pipe(Effect.provide(appDatabase))),
              invalidateTodo: (stop: typeof TodoBaseClosed.Request.Type) =>
                ExecutionHost.intent(TodoBaseClosed.Invalidate, {
                  executionId: `todo-closed:${stop.attemptId}`,
                  payload: stop
                }).pipe(
                  Effect.flatMap((intent) => executions.getByName(intent.executionId).start(intent)),
                  Effect.provideService(RuntimeContext, runtime)
                ),
              startApply: (request: Parameters<NonNullable<GitHubApply.Services["startApply"]>>[0]) => {
                const executionId = applyExecutionId(request.deliveryId)
                return ExecutionHost.intent(GitHubApply.Apply, { executionId, payload: request }).pipe(
                  Effect.flatMap((intent) => executions.getByName(executionId).start(intent)),
                  Effect.provideService(RuntimeContext, runtime)
                )
              },
              signalTodo: (executionId: string, number: number) =>
                executions.getByName(executionId).signal(pullClosed(number).name).pipe(
                  Effect.provideService(RuntimeContext, runtime)
                )
            }
          })
        // The coding factory's `todo` run and a head's checks (docs/features/todos.md#the-run) need the App: they make
        // branches, commits and pull requests. They start what they start (the next TODO's run, a head's checks) on
        // their own objects, and the agent writes on the branches' machines.
        const machines = BranchSandboxes.machinesLayer(machineObjects, keep)
        const todoServices = <GE, GR>(ready: GitHubHost.Ready<GE, GR>) =>
          Effect.gen(function*() {
            const runtime = yield* RuntimeContext
            const built = yield* githubServices(ready)
            const raise = yield* raiser
            // A job that waited past its repository's overflow wakes that repository's overflow box (decision 0144),
            // through the sandbox admission, which keeps the awake cap; its wake starts its `sandbox/Keep`.
            const sandboxes = yield* BranchSandboxes.sandboxesOver(sandboxObjects, keep)
            return {
              ...built,
              credentials,
              fleet: { settings: fleet, raise },
              overflow: (due: Overflow.Due) => Effect.asVoid(sandboxes.wake(Overflow.boxBranch(due.repoId))),
              cancel: (executionId: string) =>
                executions.getByName(executionId).cancel().pipe(Effect.provideService(RuntimeContext, runtime)),
              start: Todo.admission((flow, options) =>
                ExecutionHost.intent(flow, { executionId: options.executionId, payload: options.payload as never })
                  .pipe(
                    Effect.flatMap((intent) => executions.getByName(options.executionId).start(intent)),
                    Effect.provideService(RuntimeContext, runtime)
                  )
              )
            }
          })
        const dispatchServices = <GE, GR>(ready: GitHubHost.Ready<GE, GR>) =>
          todoServices(ready).pipe(Effect.map((services) => ({ ...services, repositories })))
        const scheduleServices = <GE, GR>(ready: GitHubHost.Ready<GE, GR>) =>
          dispatchServices(ready).pipe(Effect.map((services) => ({ ...services, store: triggerStore })))
        const withGitHub = <ROut, FE, FR>(flows: ExecutionHost.Flows<ROut, FE, FR>) =>
          Option.isSome(github)
            ? hostFor(
              // A repository's own flows (docs/features/ci.md#repository-flows) read their flow.ts and report their
              // status as the App, and plan in the QuickJS build the agent's cells run on. GitHub's pushes and pull
              // requests start them through `triggers/Dispatch`, on each run's own object, and their schedules through
              // `triggers/Tick` (docs/features/ci.md#schedules).
              ExecutionHost.withSchedules(ExecutionHost.withTriggers(
                ExecutionHost.withRepoFlows(
                  ExecutionHost.withTodos(
                    // Publish and Update branch (docs/features/branch-publish.md) read a branch's working copy on its
                    // machine and write GitHub as the person who pressed; Resync moves the working copy to GitHub's head.
                    ExecutionHost.withBranchPublish(
                      ExecutionHost.withGitHub(flows, githubServices(github.value)),
                      githubServices(github.value),
                      machines,
                      forge
                    ),
                    todoServices(github.value),
                    machines,
                    // The `todo` run's agent writes with the `coding` role, admitted and metered as the endpoint's calls are.
                    Layer.unwrap(Effect.map(flowStarter, (started) =>
                      TodoAgent.registration(
                        seats("coding", started, todoOwner),
                        appDatabase,
                        AgentSandbox.layer,
                        commandSeconds,
                        stepWaitSeconds
                      ))),
                    commandSeconds,
                    stepWaitSeconds
                  ),
                  Effect.map(githubServices(github.value), (services) => ({ ...services, machines: declaredMachines })),
                  AgentSandbox.variant
                ),
                dispatchServices(github.value)
              ), scheduleServices(github.value))
            )
            : hostFor(flows)
        const host = Option.isSome(repoClone)
          ? withGitHub(ExecutionHost.withRepoClone(base, repoClone.value))
          : withGitHub(base)
        return {
          start: (intent: ExecutionObject.Intent) => host.start(intent).pipe(Effect.provide(logs)),
          signal: (deferredName: string) => host.signal(deferredName).pipe(Effect.provide(logs)),
          answer: (task: string, value: typeof Schema.Json.Type) => host.answer(task, value).pipe(Effect.provide(logs)),
          wake: () => host.wake().pipe(Effect.provide(logs)),
          repositoryRun: () => host.repositoryRun.pipe(Effect.map(Option.getOrNull), Effect.provide(logs)),
          cancel: () => host.cancel().pipe(Effect.provide(logs)),
          // A failure still throws, so Cloudflare retries the alarm, and is recorded by its flags and category first
          // (worker/DurableObjectFailure.ts): an instance Cloudflare replaced mid-alarm fails its I/O.
          advance: () => host.alarm().pipe(Effect.asVoid, recorded("FlowExecution", "advance"), Effect.provide(logs)),
          alarm: () => host.alarm().pipe(Effect.asVoid, recorded("FlowExecution", "alarm"), Effect.provide(logs))
        }
      })
    })
  )
