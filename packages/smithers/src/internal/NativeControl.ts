/** One private control/executor composition over existing native platform adapters.
 * @since 1.0.0
 */
import type * as NodeServices from "@effect/platform-node/NodeServices"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as AgentSession from "@smthrs/agent/AgentSession"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as StandardFlows from "@smthrs/agent/StandardFlows"
import * as WorkspaceObservation from "@smthrs/agent/WorkspaceObservation"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import { ApprovalAuthority, Control, ControlExecutor, ControlRuntime, SqlControlRuntime, SystemFlows } from "@smthrs/control"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import { Action, FlowRuntime } from "@smthrs/flow"
import type * as NodeFlowsRuntime from "@smthrs/flows/NodeRuntime"
import type * as GatewayServer from "@smthrs/gateway/GatewayServer"
import type * as NodeGateway from "@smthrs/gateway/node/NodeGateway"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import type * as Sandbox from "@smthrs/harness/Sandbox"
import * as Steering from "@smthrs/harness/Steering"
import * as GatewayProjections from "@smthrs/gateway/Projections"
import type * as KernelJj from "@smthrs/kernel/Jj"
import type { JjError } from "@smthrs/jj"
import { SqlJournal } from "@smthrs/journal"
import * as Journal from "@smthrs/journal/Journal"
import * as KernelChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as Workspace from "@smthrs/kernel/Workspace"
import type * as McpClient from "@smthrs/mcp/McpClient"
import * as McpFlows from "@smthrs/mcp/McpFlows"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import type * as RequestExecutor from "@smthrs/model/RequestExecutor"
import type { NotificationQueue } from "@smthrs/notifications"
import * as ProcessReaper from "@smthrs/platform-node/ProcessReaper"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { AttemptStore, Ownership, RunStore } from "@smthrs/run-store"
import * as Checkpoints from "@smthrs/std/Checkpoints"
import * as Container from "@smthrs/std/Container"
import * as NativeSearch from "@smthrs/std/NativeSearch"
import * as RunCatalog from "@smthrs/sync/RunCatalog"
import * as SyncAuth from "@smthrs/sync/SyncAuth"
import * as SyncServer from "@smthrs/sync/SyncServer"
import * as WorkspaceShare from "@smthrs/sync/WorkspaceShare"
import { Cause, Context, Effect, FileSystem, Layer } from "effect"
import type { Crypto, Path, Scope } from "effect"
import * as Deferred from "effect/Deferred"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { join, resolve } from "node:path"
import type * as Application from "../Application.ts"
import * as Serve from "../Serve.ts"
import * as ControlDatabasePath from "./ControlDatabasePath.ts"
import * as EngineJournalSupervisor from "./EngineJournalSupervisor.ts"
import * as ExecutionDatabasePath from "./ExecutionDatabasePath.ts"
import * as ModuleAuthority from "./ModuleAuthority.ts"
import * as ModuleAdmission from "./ModuleAdmission.ts"
import * as WorkspaceRouting from "./WorkspaceRouting.ts"
import * as LocalControl from "./LocalControl.ts"
import { cellLimits, checkpointStore, layerSeatResolver, testFlows, testRunner } from "./NativeEquipment.ts"

/** Captured durable control services shared by native consumers.
 * @since 1.0.0
 * @private
 */
export interface EngineDurable extends Application.Engine {
  readonly stores: Layer.Layer<DurableWriter.DurableWriter | SqlClient | RunStore.RunStore>
}
/** Existing executable registration input to the native runtime final phase.
 * @since 1.0.0
 * @private
 */
export type ModuleRegistration = Layer.Layer<
  Executable.Catalog,
  never,
  | Executable.Registration
  | AgentAction.Host
  | Sandbox.Sandbox
  | Steering.Source
  | Exclude<Effect.Services<ReturnType<typeof AgentSession.make>>, Scope.Scope>
  | FileSystem.FileSystem
  | Path.Path
  | KernelJj.Jj
  | SqlClient
  | AttemptStore.AttemptStore
  | KernelChildProcessSpawner.ChildProcessSpawner
  | Budget.Budget
  | QuotaPolicy.QuotaClassifier
  | NotificationQueue.NotificationQueue
>

/** Existing service implementations selected by the executable boundary.
 * @since 1.0.0
 * @private
 */
export interface Platform {
  readonly host: Layer.Layer<NodeServices.NodeServices>
  readonly crypto: Layer.Layer<Crypto.Crypto>
  readonly database: (filename: string) => Layer.Layer<DurableWriter.DurableWriter | SqlClient>
  readonly runtime: typeof NodeFlowsRuntime.layer
  readonly jj: (root: string) => Layer.Layer<KernelJj.Jj, JjError, KernelChildProcessSpawner.ChildProcessSpawner>
  /** Private deployment policy around the already guarded standard file tools. */
  readonly filesystem?: (root: string, filesystem: FileSystem.FileSystem,
    spawner: KernelChildProcessSpawner.ChildProcessSpawner["Service"]) => Effect.Effect<FileSystem.FileSystem>
  readonly requestExecutor: Layer.Layer<RequestExecutor.RequestExecutor>
  readonly gateway: typeof NodeGateway.layer
  readonly bearerPrincipal: typeof NodeGateway.bearerPrincipal
}

const secureSqliteFiles = (file: string) => Effect.gen(function*() {
  if (process.platform === "win32") return
  const fs = yield* FileSystem.FileSystem
  for (const sqliteFile of [file, `${file}-wal`, `${file}-shm`]) {
    if (yield* fs.exists(sqliteFile)) yield* fs.chmod(sqliteFile, 0o600)
  }
}).pipe(Effect.orDie)

/** Binds one control composition to the already-existing Node or Bun services.
 * @since 1.0.0
 * @private
 */
export const make = (native: Platform, seats = layerSeatResolver,
  decorateNotifications?: LocalControl.NotificationDecorator) => {
/**
 * The flow sources a local CLI discovers: the project `flows/` directory, whose
 * per-directory layout is the convention in
 * `docs/specs/Specs/Flow Directory.md`.
 *
 * Use this when building a project registry. It is pure and cannot fail; the
 * discovery layer reports unreadable or malformed sources later.
 *
 * @category constructors
 * @since 0.1.0
 */
const projectSources = (root: string): ReadonlyArray<Descriptor.Source> => [
  { source: "project", root: join(root, "flows"), naming: "path" }
]

/**
 * The raw host platform: the selected platform services plus the descriptor-relative,
 * no-follow filesystem the kernel needs underneath it. `NodeServices` alone is
 * not enough: the kernel's guarded `FileSystem` refuses every operation unless
 * the host provides descriptor-relative, no-follow access, which is what
 * `AtomicFileSystem` adds on Node.
 *
 * This is the *unguarded* half of the composition. It is what
 * {@link layerGuardedPlatform} is built on, and it is what host equipment that
 * carries its own confinement argument runs on, today only the workspace
 * observer, whose module documents why (`@smthrs/agent/WorkspaceObservation`).
 * Agent-reachable equipment never gets this layer: a flow, a tool, or anything
 * a model can steer takes {@link layerGuardedPlatform} so the kernel decides
 * what it may touch.
 *
 * One `const`, not a function, so every consumer in one composition shares a
 * single memoized build. Host acquisition failures remain startup failures in
 * the layers that consume it.
 *
 * @category layers
 * @since 0.1.0
 */
const layerHostPlatform = native.host

/**
 * The local CLI's real permission store.
 *
 * Its configured rule preserves the operator-owned CLI's allow policy, while
 * the real store still enforces the fiber's capability ceiling. This is
 * intentionally distinct from `GrantStore.layerNoop`, which skips both policy
 * evaluation and ceiling enforcement and is suitable only as an explicit test
 * input.
 *
 * @category layers
 * @since 1.0.0
 */
const layerGrantStore = (root: string): Layer.Layer<GrantStore.GrantStore> =>
  GrantStore.layer({
    attended: false,
    rules: [
      new Rule({
        effect: "allow",
        pattern: new CapabilityPattern({ action: "*", resource: "*" })
      })
    ]
  }).pipe(
    Layer.provide(Workspace.layer(resolve(root))),
    Layer.orDie
  )

/**
 * The kernel-guarded platform over one workspace root: every filesystem
 * operation resolved, authorized, re-resolved, and executed relative to a
 * pinned root descriptor.
 *
 * `grants` is the store the kernel asks before it authorizes an operation, and
 * it is a parameter rather than a constant so that one composition cannot end
 * up asking two different stores. The default is the local CLI's real store;
 * a hosted composition may supply a stricter `GrantStore`, and must supply the same one it gives
 * `KernelChildProcessSpawner`: a filesystem pinned to the allow-all store
 * beside a shell pinned to a real one is a fail-open the types would not catch.
 *
 * The confinement the kernel still enforces here is structural: canonical
 * resolution, the hard-link refusal, and descriptor-relative execution from a
 * pinned root. That is what costs: on Node one authorized operation is one
 * helper process, so a caller that performs one operation per file in a
 * checkout pays for the whole checkout. That is a cost to spend on
 * agent-reachable equipment and to refuse for a whole-tree walk; see
 * {@link layerHostPlatform}.
 *
 * @category layers
 * @since 0.1.0
 */
const layerGuardedPlatform = (
  root: string,
  grants: Layer.Layer<GrantStore.GrantStore> = layerGrantStore(root)
) =>
  Layer.orDie(KernelFileSystem.layer).pipe(
    Layer.provide([Workspace.layer(root), grants]),
    Layer.provideMerge(layerHostPlatform)
  )

/**
 * Provides the workspace observer the run's mutation accounting is measured
 * with: one pruned walk of the workspace root, taken at both ends of every
 * frame.
 *
 * On {@link layerHostPlatform}, deliberately, and never on
 * {@link layerGuardedPlatform}. The observer is host equipment: the root is
 * this composition's, not a model's. It carries its own confinement
 * argument: it stats, it never opens, it follows no symlink, and every path it
 * builds is an entry name under the root. `@smthrs/agent/WorkspaceObservation`
 * states that argument in full. Guarding it decides nothing and costs one
 * helper process per file: SWE-bench wave 6 spent 912 s of a 1,200 s budget on
 * django's opening walk and never reached the agent's first tool call.
 *
 * @category layers
 * @since 0.1.0
 */
const layerObserver = (root: string): Layer.Layer<WorkspaceObservation.Observer> =>
  WorkspaceObservation.layer(root).pipe(Layer.provide(layerHostPlatform))

/**
 * Provides the native flow registry the local CLI discovers flows with.
 *
 * `Registry.layerNoop()` was the previous local composition, so the CLI found
 * no flows at all. Discovery runs under an allow-all grant store because the
 * local CLI is the operator's own process; a hosted composition supplies a real
 * `GrantStore`. A source root that does not exist scans empty, so this is not a
 * startup failure. An unreadable one is, and dies rather than silently
 * discovering nothing.
 *
 * @category layers
 * @since 0.1.0
 */
const layerRegistry = (root: string): Layer.Layer<Registry.Registry> => {
  const platform = layerGuardedPlatform(root)
  const discovery = Discovery.layer.pipe(Layer.provide(platform))
  return Registry.layer({ sources: projectSources(root) }).pipe(
    Layer.provide([discovery, platform]),
    // A project with no `flows/` directory simply has no flows. Every other
    // discovery failure, such as an unreadable root or malformed entry, is a startup
    // defect rather than a silent empty catalog.
    Layer.catch((error) =>
      error.code === "root_missing"
        ? Registry.layerFromDescriptors([]).pipe(Layer.provide(platform))
        : Layer.effect(Registry.Registry)(Effect.die(error))
    )
  )
}

/**
 * Where a local CLI keeps its control-plane database.
 *
 * Use this instead of assembling `.flows` paths at call sites. It is a pure
 * path projection and cannot fail; opening the returned file can.
 *
 * @category constructors
 * @since 0.1.0
 */
const databasePath = ControlDatabasePath.databasePath

/**
 * Where the durable flow engine keeps executions, attempts, cache entries,
 * and wake state. The control plane has a separate connection and schema in
 * {@link databasePath}; keeping the files separate makes each composition's
 * migration ownership explicit.
 * This is a pure path projection; engine startup reports creation or migration
 * failures when it opens the file.
 *
 * @category constructors
 * @since 0.1.0
 */
const executionDatabasePath = ExecutionDatabasePath.executionDatabasePath

/**
 * Acquires one durable graph and projects its live services back into layers.
 *
 * Nested `Layer.provide` calls build with independent memo maps, so merely
 * passing the same layer value to the runtime, journal, executor, and memory
 * store still opened one SQLite connection per consumer. Building the merged
 * graph in the caller's scope first gives every consumer the same live service
 * values, and closing that scope closes the sole connection.
 */
const materializeEngine = (engine: EngineDurable): Effect.Effect<EngineDurable, never, Scope.Scope> =>
  Effect.map(
    Layer.build(Layer.mergeAll(engine.runtime, engine.journal, engine.stores)),
    (services) => ({
      runtime: Layer.succeed(
        ControlRuntime.ControlRuntime,
        Context.get(services, ControlRuntime.ControlRuntime)
      ),
      journal: Layer.succeed(Journal.Journal, Context.get(services, Journal.Journal)),
      stores: Layer.mergeAll(
        Layer.succeed(DurableWriter.DurableWriter, Context.get(services, DurableWriter.DurableWriter)),
        Layer.succeed(SqlClient, Context.get(services, SqlClient)),
        Layer.succeed(RunStore.RunStore, Context.get(services, RunStore.RunStore))
      )
    })
  )

/**
 * The reserved system catalog in the durable runtime's flow shape.
 *
 * The reserved verbs make no model calls of their own, so there is nothing for
 * a ceiling to bound and `Descriptor.budgetUnbounded` says so by name rather
 * than by an unlabelled `{}`.
 */
const systemFlows: ReadonlyArray<ControlRuntime.MemoryFlow> = SystemFlows.catalog.map((entry) => ({
  flowId: entry.flowId,
  description: `Reserved ${entry.verb} system flow`,
  deployClass: entry.deployClass,
  envelope: { capabilities: [], flows: [], budget: Descriptor.budgetUnbounded }
}))

/**
 * Projects one discovered flow into the durable runtime's flow shape.
 *
 * The budget travels with the capabilities because it is enforced the same way
 * they are: `layerExecutor` hands `Budget.layerFromEnvelope` to `AgentSession`,
 * which builds one budget per run out of the approved card's envelope. A
 * hardcoded `{}` here made that enforcement bind nothing on the shipped CLI,
 * however carefully a flow declared its ceilings. `Descriptor.budgetOf` answers
 * the undeclared case with `budgetUnbounded`, so a flow that names no ceiling
 * still runs and a flow that names one is held to it.
 */
const durableFlow = (descriptor: Descriptor.FlowDescriptor): ControlRuntime.MemoryFlow => ({
  flowId: descriptor.name,
  description: descriptor.description,
  deployClass: false,
  executionDigest: Descriptor.executionDigest(descriptor),
  envelope: {
    capabilities: descriptor.capabilities,
    flows: descriptor.flows,
    budget: Descriptor.budgetOf(descriptor)
  }
})

// Configuring the CLI's gateway token delegates the local operator's supported
// decisions to that gateway's authenticated identity. This is a host policy,
// not an authorization rule for arbitrary bearer or agent principals.
const gatewayApprovalAuthority = Effect.runSync(ApprovalAuthority.make([
  { principal: { id: "local", kind: "operator" }, scopes: ["once", "run", "remembered"], targets: ["Plan", "Node"] },
  { principal: native.bearerPrincipal, scopes: ["once", "run", "remembered"], targets: ["Plan", "Node"] }
]))

/**
 * Provides the durable local engine: `SqlControlRuntime` and the production
 * SQL journal, both over one SQLite file under the project root.
 *
 * The previous local composition was `ControlRuntime.layerMemory()` over
 * `TestJournal`, an in-memory database, so no plan, approval, run, or journal
 * entry survived the process. Sharing one connection between the runtime and
 * the journal is deliberate: the fenced run transitions and the events that
 * describe them then commit against the same database.
 *
 * With a `registry`, the runtime knows every discovered flow as well as the
 * reserved system catalog, so `smthrs plan <flow>` plans a project flow
 * instead of failing `FlowNotFound`.
 *
 * Reach for this value at a native composition root and reuse it. Database open,
 * migration, and journal startup failures are promoted to defects because no
 * local command can proceed honestly without the store.
 *
 * @category layers
 * @since 0.1.0
 */
const engineDurable = (
  root: string,
  registry?: Layer.Layer<Registry.Registry> | undefined,
  authority: Pick<Application.Config, "approvalAuthority" | "principal" | "credential"> = {}
): EngineDurable => {
  const file = databasePath(root)
  const authorization = {
    principal: authority.principal,
    approvalAuthority: authority.approvalAuthority ??
      (authority.credential === undefined || authority.credential === ""
        ? ApprovalAuthority.local
        : gatewayApprovalAuthority)
  }
  // One real process identity per local control plane. A constant pid made two
  // CLIs on one host appear to own the same fence and allowed the loser to
  // re-drive work claimed by the winner.
  const owner = Object.freeze({ hostId: hostname(), pid: process.pid, nonce: randomUUID() })
  const database = native.database(file).pipe(Layer.orDie)
  // A control plane that cannot open its own database has nothing to serve, so
  // a failed open, migration, or journal start is a startup defect rather than
  // a typed control-plane error every command would have to carry.
  // The control and native engines both use RunStore over different databases.
  // Its exported layer is a singleton: a shared memo map must not reuse the
  // control instance inside the native engine, whose state is versioned.
  const stores = Layer.mergeAll(SqlJournal.layer({ capacity: 1024, overflow: "reject" }), Layer.fresh(RunStore.layer))
    .pipe(
      Layer.provideMerge(database),
      Layer.orDie
    )
  const runtime = registry === undefined
    ? SqlControlRuntime.layer({ ...authorization, owner }).pipe(Layer.provide([stores, native.crypto]), Layer.orDie)
    : Layer.effect(ControlRuntime.ControlRuntime)(
      Effect.gen(function*() {
        const registryService = yield* Registry.Registry
        return yield* SqlControlRuntime.make({
          ...authorization,
          owner,
          loadFlows: () =>
            registryService.list().pipe(
              Effect.map((discovered) => [...systemFlows, ...discovered.map(durableFlow)])
            )
        })
      })
    ).pipe(Layer.provide([stores, native.crypto, registry]), Layer.orDie)
  return {
    runtime,
    journal: stores,
    stores
  }
}

/**
 * Provides the production run executor: the `@smthrs/agent` composition root
 * over the durable control stores, the local flow registry, and the standard
 * host capabilities: filesystem and shell through the kernel's guarded
 * layers, durable memory over the control database, approval and steering
 * wired back into the control plane by the session itself.
 *
 * The durable engine is built through the selected existing native runtime, whose
 * final registration phase constructs `AgentSession`. This is deliberate:
 * the executor cannot accept a launch until the engine database is migrated,
 * its stores and sweepers are live, and the agent flow body has been
 * registered. The resulting engine state is durable, and no launch can race
 * ahead of that durability-sensitive startup order.
 *
 * @category layers
 * @since 0.1.0
 */
const executorFromEngine = (
  registry: Layer.Layer<Registry.Registry>,
  engine: EngineDurable,
  root: string,
  environment: Readonly<Record<string, string | undefined>>,
  /**
   * MCP servers to connect at startup, each projected into the run's flow
   * catalog by `@smthrs/mcp/McpFlows`, one more source alongside filesystem,
   * shell, and memory below. Empty by default: a host that names none behaves
   * exactly as it always has.
   */
  mcpServers: ReadonlyArray<McpClient.ConnectOptions> = [],
  grants: Layer.Layer<GrantStore.GrantStore> = layerGrantStore(root),
  requestExecutor: Layer.Layer<RequestExecutor.RequestExecutor> = native.requestExecutor,
  quotaPolicy: Layer.Layer<QuotaPolicy.QuotaClassifier> = QuotaPolicy.layerDefault(),
  executionRoot: string = root,
  /**
   * Trusted native registrations using the existing executable catalog.
   * Built in the engine's registration phase with the guarded host platform;
   * every registered handler restores its owning approved control envelope.
   */
  modules?: ModuleRegistration
): Layer.Layer<
  ControlExecutor.ControlExecutor,
  never,
  ControlRuntime.ControlRuntime | Journal.Journal | NotificationQueue.NotificationQueue | Registry.Registry
> => {
  const workspaceRoot = resolve(executionRoot)
  // Startup sweepers may ask before final registration captures the native SQL
  // client. They refuse until that existing final phase installs the reader.
  let admission: ((runId: string) => Effect.Effect<boolean>) | undefined
  const canExecute = (runId: string) => Effect.suspend(() => admission?.(runId) ?? Effect.succeed(false))
  // The same guarded platform the registry discovers under: kernel FileSystem
  // over descriptor-relative atomic access, with the selected service bundle
  // (Path, raw spawner, crypto) merged through. `grants` is passed rather than
  // defaulted so the filesystem and the shell below it can never end up asking
  // two different stores.
  const platform = layerGuardedPlatform(workspaceRoot, grants)
  // Permission checks do not contain a process after its CLI owner crashes.
  // Keep one durable ledger under the shell, native search/test runners and
  // MCP connections, and reap only verified children of dead owners before
  // exposing the spawner. The registration phase receives the engine journal
  // from native.runtime, so these records survive this process.
  const contain = () => ProcessReaper.layerSpawner().pipe(
    Layer.provideMerge(platform),
    Layer.provideMerge(ProcessReaper.layer()),
    Layer.provide(ProcessLedger.layer({ hostId: hostname(), ownerPid: process.pid }))
  )
  let toolSpawner: KernelChildProcessSpawner.ChildProcessSpawner["Service"] | undefined
  const contained = contain().pipe(Layer.tap(context => Effect.sync(() => {
    toolSpawner = Context.get(context, KernelChildProcessSpawner.ChildProcessSpawner)
  })))
  // Engine bookkeeping must be contained before the native engine itself
  // starts. Reuse the already materialized control journal for that lifetime;
  // a distinct layer instance keeps registration's native journal separate.
  const engineJj = native.jj(workspaceRoot).pipe(
    Layer.provide(contain().pipe(Layer.provide(engine.journal)))
  )
  const guarded = KernelChildProcessSpawner.layer.pipe(
    Layer.provide(grants),
    Layer.provideMerge(contained)
  )
  const memory = MemoryStore.layer.pipe(Layer.provide(engine.stores), Layer.orDie)
  // AgentSession installs the effective budget from the approved card around
  // each `agent.run`. No card exists while this executor layer is built, so
  // unbounded is the only honest construction-time budget. The provider is
  // discarded after it closes `Agent.layer`; every run installs
  // `Budget.layerFromEnvelope` directly around the call. The quota layer is
  // the same policy the session installs for the run.
  const sessionAgent = Agent.layer.pipe(
    // eslint-disable-next-line no-restricted-syntax -- no envelope exists until AgentSession starts a run
    Layer.provide(Layer.mergeAll(quotaPolicy, Budget.layerUnbounded()))
  )
  // The dispatcher must live as long as the executor. A model captures this
  // service and uses it after seat resolution has returned.
  //
  // It also has to be replaceable. A retry ladder repairs a failure by waiting,
  // and an HTTP/2 session the peer has destroyed is the failure waiting does not
  // repair: every attempt that reuses the pool holding it fails identically, and
  // r92 of the SWE-bench full benchmark spent ten `transport` retries and $0.85
  // proving it on two instances. Undici's `Agent` *is* the pool, and
  // `makeDispatcher` acquires a fresh one, so the honest rebuild here is a new
  // agent in a scope of its own. The previous one is closed as soon as the new
  // one is in hand, so a run that rebuilds many times still holds one pool.
  const registration = Layer.effect(ControlExecutor.ControlExecutor)(
    Effect.gen(function*() {
      const capturedFilesystem = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
      const filesystemServices = native.filesystem === undefined ? capturedFilesystem : Context.add(
        capturedFilesystem, FileSystem.FileSystem,
        yield* native.filesystem(workspaceRoot, Context.get(capturedFilesystem, FileSystem.FileSystem), toolSpawner!)
      )
      const shellServices = yield* Effect.context<
        KernelChildProcessSpawner.ChildProcessSpawner | Path.Path
      >()
      const memoryServices = yield* Effect.context<MemoryStore.MemoryStore | Recall.Recall>()
      const nativeSearch = NativeSearch.make(Context.merge(filesystemServices, shellServices))
      // `test` is offered exactly when this host can say how the repository
      // runs its tests. The declaration carries the container too, so the
      // runner reaches the same transport `bash` does.
      const runner = testRunner(environment, root)
      const container = Container.makeCommand()
      // Each configured server is a startup-time connection the operator
      // opted into by naming it, the same way `memory` below is: a server
      // that fails to spawn dies the executor loudly (`Effect.orDie`) rather
      // than running silently short of the tools it was configured to have.
      const mcp = yield* Effect.forEach(mcpServers, (server) => Effect.orDie(McpFlows.connected(server)))
      const sources = [
        StandardFlows.filesystem(filesystemServices, nativeSearch),
        StandardFlows.shell(shellServices, container),
        StandardFlows.memory(memoryServices),
        ...testFlows(shellServices, container, runner),
        ...mcp
      ]
      const actionHost = AgentAction.makeHost({
        registry: yield* Registry.Registry,
        limits: cellLimits,
        flows: sources
      })
      const catalogReady = yield* Deferred.make<Executable.Catalog>()
      const authority = modules === undefined ? undefined : yield* ModuleAuthority.make(Deferred.await(catalogReady), actionHost)
      const catalog = modules === undefined ? undefined : Context.get(
        yield* Layer.build(modules.pipe(
          // No approved card exists at registration. ModuleAuthority installs
          // the shared, journal-backed approved Budget at each handler entry.
          // eslint-disable-next-line no-restricted-syntax -- construction-time dependency only
          Layer.provide(Budget.layerUnbounded()),
          Layer.provide(Action.layerImplementations),
          Layer.provide(AgentAction.layerHost(actionHost)),
          Layer.provide(QuickJSSandbox.layer.pipe(Layer.orDie)),
          Layer.provide(Layer.succeed(Steering.Source, authority!.steering)),
          Layer.provide(Layer.succeed(FlowRuntime.FlowRuntime, authority!.runtime))
        )),
        Executable.Catalog
      )
      if (catalog !== undefined) yield* Deferred.succeed(catalogReady, catalog)
      const engineSql = yield* SqlClient
      const controlSql = yield* SqlClient.pipe(Effect.provide(engine.stores))
      const routing = yield* WorkspaceRouting.make({ root, engine: engineSql, control: controlSql })
      const moduleAdmission = ModuleAdmission.make({
        runs: yield* RunStore.RunStore, control: yield* ControlRuntime.ControlRuntime,
        registry: yield* Registry.Registry, catalog
      })
      admission = (runId) => routing.canExecute(workspaceRoot, runId).pipe(
        Effect.flatMap(allowed => allowed ? moduleAdmission(runId) : Effect.succeed(false)),
        Effect.catchCause(cause => Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Native admission lookup failed; leaving the run parked", { runId, cause: Cause.pretty(cause) })
            .pipe(Effect.as(false)))
      )
      const session = AgentSession.make({
        canExecute,
        flows: sources,
        limits: cellLimits,
        quotaPolicy,
        budget: Budget.layerFromEnvelope
      })
      // Lifecycle, steering and approval belong to the control journal. The
      // registration phase otherwise inherits the engine's separate journal.
      // Select only Journal: an unmaterialized engine.journal layer can also
      // provide the control RunStore, which must not replace the native one.
      const controlJournal = yield* Journal.Journal.pipe(Effect.provide(engine.journal))
      // Capture the original native services before selecting the control
      // journal for AgentSession. This observer lives in the same host scope,
      // outside admission transactions; it opens no persistence of its own.
      const supervisor = yield* EngineJournalSupervisor.make({
        engineJournal: yield* Journal.Journal,
        controlJournal,
        engineState: yield* DurableEngineState.DurableEngineState,
        runs: yield* RunStore.RunStore,
        control: yield* ControlRuntime.ControlRuntime
      })
      const executor = yield* (catalog === undefined ? session : session.pipe(
        Effect.provideService(Executable.Catalog, catalog)
      )).pipe(Effect.provideService(Journal.Journal, controlJournal))
      yield* Effect.forkScoped(supervisor.recover)
      return supervisor.wrap(executor)
    })
  ).pipe(
    Layer.provide([
      guarded,
      memory,
      Recall.layerNoop,
      quotaPolicy,
      sessionAgent,
      // The run's mutation accounting is measured rather than declared, and
      // this is what measures it: without an observer in the composition the
      // controller falls back to what a frame's calls claimed about
      // themselves, which is blind to every `bash` write. It runs on the host
      // platform rather than on `platform`, for the reasons `layerObserver`
      // states.
      layerObserver(workspaceRoot),
      // Where a run's checkpoints live. Without it `ctx.checkpoint()` and
      // `ctx.base` answer `checkpoint_unavailable`, honestly, and the run
      // takes its readings on the live tree. This is the difference
      // between a run that can prove fails-before without reverting its own
      // work and one that cannot.
      Checkpoints.layerGit(checkpointStore(environment, workspaceRoot)),
      seats(environment).pipe(Layer.provide(requestExecutor))
    ])
  )
  const nativeRuntime = native.runtime(
    {
      filename: executionDatabasePath(root),
      workspaceRoot,
      // The machine's own name, for the same reason `engineDurable` stamps
      // it: `sameHostPidProbe` compares `hostId` before it trusts a pid, and
      // a constant made every row in every process table look local. Two
      // checkouts inside one container and the host they are bind-mounted
      // from share this file with disjoint pid namespaces, so under a
      // constant the probe answered about the wrong process table, and a row
      // whose owner was alive elsewhere read as dead here.
      owner: { hostId: hostname() },
      // Two terminals over one project are two engine processes over one
      // `.flows/engine.db`, so "one engine process at a time" was never true
      // and a stub answering `false` let each steal the other's running rows
      // 30 seconds after any heartbeat stall. The probe asks the process
      // table instead, and answers only about this host: a run recorded on
      // another host is left to the lease, which `RunStore.steal` verifies.
      isAlive: Ownership.sameHostPidProbe,
      canExecute: (row) => canExecute(row.runId)
    },
    StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    registration
  ).pipe(
    Layer.provide([platform, native.crypto, engineJj]),
    Layer.tap(() =>
      secureSqliteFiles(executionDatabasePath(root)).pipe(Effect.provide(native.host))
    ),
    // Failure to open or migrate the local execution engine is a startup
    // defect, just like the control database above: no command can execute
    // honestly without this composition.
    Layer.orDie
  )
  // The runtime exposes its stores for native registrations. Only the
  // executor crosses back into the control composition: leaking the native
  // Journal or RunStore here silently redirects ControlLive to engine.db.
  return Layer.effect(ControlExecutor.ControlExecutor)(ControlExecutor.ControlExecutor).pipe(
    Layer.provide(nativeRuntime)
  )
}

/**
 * Builds the executor over one captured control-store graph. Materializing
 * before native registration prevents the shared RunStore layer from being
 * memoized against the other database in an embedding composition.
 * @category layers
 * @since 1.0.0
 */
const layerExecutor = (
  ...[registry, engine, ...options]: Parameters<typeof executorFromEngine>
): ReturnType<typeof executorFromEngine> =>
  Layer.unwrap(Effect.map(
    materializeEngine(engine),
    (materialized) => executorFromEngine(registry, materialized, ...options)
  ))

  const layerControlFromEngine = (
    config: Application.Config,
    registry: Layer.Layer<Registry.Registry>,
    engine: EngineDurable,
    modules?: ModuleRegistration
  ) => {
    const root = config.root ?? process.cwd()
    return LocalControl.layer(registry, engine, layerExecutor(registry, engine, root, process.env,
      config.mcpServers ?? [], undefined, undefined, undefined, config.executionRoot ?? root, modules), decorateNotifications)
  }
  const layerControl = (config: Application.Config, suppliedRegistry?: Layer.Layer<Registry.Registry>, suppliedEngine?: EngineDurable, modules?: ModuleRegistration) => {
    const root = config.root ?? process.cwd()
    const registry = suppliedRegistry ?? layerRegistry(root)
    const engine = suppliedEngine ?? engineDurable(root, registry, config)
    return Layer.unwrap(Effect.map(materializeEngine(engine), captured => layerControlFromEngine(config, registry, captured, modules)))
  }
  const layerGateway = (
    health: GatewayServer.Health,
    options: NodeGateway.ServerOptions = { host: "127.0.0.1", port: 3000 },
    root: string,
    engine: EngineDurable = engineDurable(root, undefined, options),
    journal: Layer.Layer<Journal.Journal> = engine.journal
  ) => native.gateway(health, options).pipe(Layer.provide([
    GatewayProjections.layer,
    SyncServer.layer.pipe(Layer.provide([journal, RunCatalog.layerNoop])),
    SyncAuth.layer.pipe(Layer.provide(WorkspaceShare.layerNoop))
  ]))
  const layerGatewayHost = (engine: EngineDurable, control: Layer.Layer<Control.Control>) =>
    Layer.effect(Serve.GatewayHost, Effect.gen(function*() {
      const controlService = yield* Control.Control
      const journalService = yield* Journal.Journal
      return Serve.GatewayHost.of({
        launch: (health, options, root) => Layer.launch(layerGateway(health, options, root, engine,
          Layer.succeed(Journal.Journal, journalService))).pipe(
            Effect.provideService(Control.Control, controlService), Effect.provide(native.host), Effect.orDie)
      })
    })).pipe(Layer.provide([control, engine.journal]))
  const layerMemory = (root: string, engine: EngineDurable = engineDurable(root)) =>
    MemoryStore.layer.pipe(Layer.provide([engine.stores, native.crypto]), Layer.orDie)
  const layerHost = (config: Application.Config, modules?: ModuleRegistration) => {
    const root = config.root ?? process.cwd()
    const registry = layerRegistry(root)
    return Layer.unwrap(Effect.map(materializeEngine(engineDurable(root, registry, config)), engine => {
      const control = layerControlFromEngine(config, registry, engine, modules)
      return Layer.mergeAll(control, layerGatewayHost(engine, control), layerMemory(root, engine), native.host)
    }))
  }
  return { projectSources, layerHostPlatform, layerGrantStore, layerGuardedPlatform, layerObserver, layerRegistry,
    gatewayApprovalAuthority,
    databasePath, executionDatabasePath, materializeEngine, engineDurable, layerExecutor, layerControlFromEngine,
    layerControl, layerGateway, layerGatewayHost, layerMemory, layerHost }
}
