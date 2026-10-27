/**
 * Platform-independent composition for the durable flows runtime.
 *
 * The SQL client and every host service are injected. No driver is opened
 * and no file is named here: the host supplies the owner identity
 * (`OwnerIdentity`), the workspace root (`Workspace`) and the artifact store
 * (`ArtifactStore`) wherever the layers it passes in need them. The native
 * hosts, `NodeRuntime` in `@smthrs/platform-node` and `BunRuntime` in
 * `@smthrs/platform-bun`, supply the process identity, a workspace directory
 * and filesystem artifacts beside the database. A host without a filesystem
 * supplies `OwnerIdentity.layerWithoutPid` and passes
 * `StepBoundary.layerUnsupported` with `WorkspaceSandbox.layerUnsupported`,
 * which need no workspace and no artifact store.
 *
 * Construction is ordered by layer dependencies: migrations finish before any
 * store is built, the durable engine is built over those stores, and
 * `registerFlows` finishes before the resulting services are exposed. The
 * engine's own registration hook then re-arms durable clocks and deferred
 * wakes, so a persisted run cannot resume through this composition before its
 * flow has been registered. Once every flow is registered, the runtime
 * recovers them together, with one read of the store
 * (`EngineStore.Options.deferRecovery`), and logs that recovery once, as
 * `engine-store.registration.recovered` with `registrations` and `durationMs`
 * (`EngineStore.Driver.reportRecovery`).
 *
 * @since 0.1.0
 */

import { DurableWriter } from "@smthrs/database"
import {
  DurableEngineState,
  EngineStore,
  Migrations,
  type StepBoundary,
  type WorkspaceSandbox
} from "@smthrs/engine-store"
import { Action, RunMetrics } from "@smthrs/flow"
import { RedactedLogger, SqlJournal } from "@smthrs/journal"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { type RegistryArgs, registryLayer } from "./internal/RegistryArgs.ts"

export { type RegistryArgs, registryLayer } from "./internal/RegistryArgs.ts"
export { decodeField, type Options, RuntimeConfigurationError, validate } from "./internal/RuntimeOptions.ts"
import { type Options, validate } from "./internal/RuntimeOptions.ts"

/** Records a phase without changing its memoization or resource scope. */
const observed = <A, E, R>(phase: string, layer: Layer.Layer<A, E, R>) =>
  Layer.fromBuild((memoMap, scope) =>
    Layer.buildWithMemoMap(layer, memoMap, scope).pipe(
      Effect.timed,
      Effect.tap(([elapsed]) =>
        Effect.flatMap(RunMetrics.LineLevel, (level) => Effect.logWithLevel(level)("flows.runtime.phase")).pipe(
          Effect.annotateLogs({ phase, durationMs: Math.round(Duration.toMillis(elapsed)) })
        )
      ),
      Effect.map(([, context]) => context)
    )
  )

/**
 * Provides the migrated durable stores over the injected SQL client, without
 * constructing an engine: the journal, `RunStore`, `AttemptStore`,
 * `CacheStore` and `DurableEngineState`, with the `DurableWriter` they share.
 *
 * This is the lower-level seam for integrations that construct another
 * engine-backed service over the same storage context. Application entry
 * points should normally use {@link layer}.
 *
 * Every use builds its own stores. Two runtimes over two databases in one
 * program never share a store instance, so each stays on its own SQL client.
 *
 * @since 0.1.0
 * @category layers
 * @slop
 */
export const storage = observed(
  "stores",
  Layer.mergeAll(
    SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    DurableEngineState.layer
  )
).pipe(
  Layer.provideMerge(Layer.provideMerge(observed("migrations", Migrations.layer), DurableWriter.layer())),
  Layer.fresh
)

/** Compose an isolated runtime from injected storage and execution services.
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = <
  BoundaryError,
  BoundaryRequirements,
  SandboxError,
  SandboxRequirements,
  Registered,
  RegistrationError,
  RegistrationRequirements,
  RegistryOut = never,
  RegistryError = never,
  RegistryRequirements = never
>(
  options: Options,
  stepBoundary: Layer.Layer<StepBoundary.Service, BoundaryError, BoundaryRequirements>,
  workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, SandboxError, SandboxRequirements>,
  registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>,
  ...registry: RegistryArgs<RegistryOut, RegistryError, RegistryRequirements>
) => {
  const validated = validate(options)
  const execution = Layer.merge(stepBoundary, workspaceSandbox).pipe(
    Layer.provideMerge(storage),
    // Credential redaction covers the operator's terminal as well as the
    // journal (the release policy). It sits UNDER the engine so the
    // context the engine captures for an action body carries it: a line an
    // action, the harness, or an agent session writes leaves through the same
    // rules `@smthrs/journal` applies on the write path.
    Layer.provideMerge(RedactedLogger.layer())
  )
  const engineOptions: EngineStore.Options = {
    owner: validated.owner,
    journalSource: `${validated.owner.hostId}-engine`,
    isAlive: validated.isAlive,
    canExecute: validated.canExecute,
    canActivate: validated.canActivate,
    requestResume: validated.requestResume,
    // What this host says about the tree it read its flows out of; every
    // recorded graph page carries it, and a host that says nothing records
    // nothing (D-068).
    sourceRevision: validated.sourceRevision,
    sweep: validated.sweep,
    resumeConcurrency: validated.resumeConcurrency,
    placement: validated.placement,
    // Registration is the last phase and its report follows it, before any run can resume through this runtime: every
    // registration's clocks and completions recover together, in that report.
    deferRecovery: true
  }
  // A host that guards the ambient `Jj` for action bodies keeps the engine's
  // own snapshots on its privileged repository, as `layerHost` does.
  const engine = observed(
    "engine",
    validated.privilegedJj === undefined
      ? EngineStore.layer(engineOptions)
      : EngineStore.layerWithPrivilegedJj(engineOptions, validated.privilegedJj)
  ).pipe(
    Layer.provideMerge(execution),
    // Under the engine, not beside it: `@smthrs/engine`
    // `FlowEngine/Dispatch` reads this reference off the context the engine
    // captures for an action dispatch, and a sibling layer is not in it.
    // Undeclared it stays absent, which is what every sealed key in this repo
    // is derived without today.
    Layer.provideMerge(
      validated.cacheEnvironment === undefined
        ? Layer.empty
        : Action.layerCacheEnvironment(validated.cacheEnvironment)
    )
  )
  // The registry is built BETWEEN the engine and the registration phase, so a
  // registration that reads a catalog off it — `@smthrs/registry`'s
  // `Executable.layer`, which turns every discovered descriptor into a
  // registered durable flow — has both the registry and the engine's own
  // context in hand, and the engine is still live before the first flow is
  // registered.
  // Constant store and registration layers must belong to this runtime's SQL
  // context. An enclosing control plane can build the same layer values over
  // another database; sharing their memoized instances crosses that boundary.
  return Layer.effectContext(
    Layer.build(
      observed("registration", registerFlows).pipe(
        Layer.provideMerge(observed("registry", registryLayer(registry))),
        Layer.provideMerge(engine),
        Layer.fresh
      )
    ).pipe(
      // Registration is the last phase: one line says what every registration's recovery did.
      Effect.tap((context) => Context.get(context, EngineStore.Driver).reportRecovery)
    )
  )
}

/** Build the runtime in the caller's scope.
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const make = <
  BoundaryError,
  BoundaryRequirements,
  SandboxError,
  SandboxRequirements,
  Registered,
  RegistrationError,
  RegistrationRequirements,
  RegistryOut = never,
  RegistryError = never,
  RegistryRequirements = never
>(
  options: Options,
  stepBoundary: Layer.Layer<StepBoundary.Service, BoundaryError, BoundaryRequirements>,
  workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, SandboxError, SandboxRequirements>,
  registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>,
  ...registry: RegistryArgs<RegistryOut, RegistryError, RegistryRequirements>
) => Layer.build(layer(options, stepBoundary, workspaceSandbox, registerFlows, ...registry))
