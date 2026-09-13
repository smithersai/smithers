/**
 * Platform-independent composition for the durable flows runtime.
 *
 * The SQL client and host services are injected. No driver is opened here;
 * native entrypoints compose their matching database and platform layers.
 *
 * Construction is ordered by layer dependencies: the SQLite parent directory
 * is created before the database opens, migrations finish before any store is
 * built, the durable engine is built over those stores, and `registerFlows`
 * finishes before the resulting services are exposed. The engine's own
 * registration hook then re-arms durable clocks and deferred wakes, so a
 * persisted run cannot resume through this composition before its flow has
 * been registered.
 *
 * @since 0.1.0
 */
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import { DurableWriter } from "@smthrs/database"
import {
  DurableEngineState,
  EngineStore,
  OwnerIdentity,
  type StepBoundary,
  type WorkspaceSandbox
} from "@smthrs/engine-store"
import * as Migrations from "@smthrs/engine-store/Migrations"
import { SqlJournal } from "@smthrs/journal"
import * as RedactedLogger from "@smthrs/journal/RedactedLogger"
import * as Workspace from "@smthrs/kernel/Workspace"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"

/**
 * Configuration for the injected runtime.
 *
 * `isAlive` is intentionally required, and a stub is not an answer: a check
 * that returns `false` without asking says "that owner is gone" about an owner
 * it never looked at, and the engine steals runs out of live processes on the
 * strength of it. A single-machine host passes `Ownership.sameHostPidProbe`,
 * which asks this machine's process table; a multi-process deployment answers
 * from its supervisor or lease system instead.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Options {
  /** SQLite database filename. Its parent directory is created recursively. */
  readonly filename: string
  /** Workspace whose file actions may read or mutate. */
  readonly workspaceRoot: string
  /** Stable identity of this engine host. */
  readonly owner: {
    readonly hostId: string
  }
  /**
   * Whether a previously recorded owner is still alive.
   *
   * Takes the claim context as well as the owner, so a probe can tell whether
   * the recorded pid names a process on the machine it is running on. A
   * one-argument check that ignores the context still satisfies this.
   */
  readonly isAlive: Ownership.LivenessCheck
  /** Routes shared-store runs to the host configured for their workspace. */
  readonly canExecute?: ((row: RunStore.RunRow) => Effect.Effect<boolean>) | undefined
}

/**
 * Stable failure raised synchronously for invalid runtime construction input.
 *
 * @since 1.0.0
 * @category errors
 */
export class RuntimeConfigurationError extends Schema.TaggedError<RuntimeConfigurationError>()(
  "@smthrs/flows/RuntimeConfigurationError",
  {
    code: Schema.Literal("invalid_runtime_configuration"),
    field: Schema.String,
    message: Schema.String
  }
) {}

const invalidConfiguration = (field: string, message: string): RuntimeConfigurationError =>
  new RuntimeConfigurationError({ code: "invalid_runtime_configuration", field, message })

/**
 * Decodes one named option and reports the option that was wrong.
 *
 * A single struct decode would answer "options" for every refusal, and the
 * whole point of {@link RuntimeConfigurationError.field} is that an embedder
 * can tell an empty `filename` from an empty `owner.hostId` without reading
 * prose. Decoding field by field makes the name come from the call site rather
 * than from walking a schema issue tree.
 */
const decodeField = <A>(field: string, schema: Schema.Codec<A>, value: unknown, expectation: string): A => {
  try {
    return Schema.decodeUnknownSync(schema)(value)
  } catch {
    throw invalidConfiguration(field, `Runtime ${field} ${expectation}`)
  }
}

const nonEmpty = "must be a non-empty string"

interface ValidatedOptions {
  readonly filename: string
  readonly workspaceRoot: string
  readonly owner: Readonly<{ readonly hostId: string }>
  readonly isAlive: Ownership.LivenessCheck
  readonly canExecute?: ((row: RunStore.RunRow) => Effect.Effect<boolean>) | undefined
}

/** Captures immutable options; paths resolve through the injected Path service. */
const validate = (options: Options): ValidatedOptions => {
  const filename = decodeField("filename", Schema.NonEmptyString, options.filename, nonEmpty)
  const workspaceRoot = decodeField("workspaceRoot", Schema.NonEmptyString, options.workspaceRoot, nonEmpty)
  // A JavaScript caller can omit `owner` entirely, so the field is read off a
  // possibly-absent record rather than dereferenced.
  const owner = options.owner as { readonly hostId?: unknown } | undefined
  const hostId = decodeField("owner.hostId", Schema.NonEmptyString, owner?.hostId, nonEmpty)
  const isAlive = options.isAlive
  if (typeof isAlive !== "function") {
    throw invalidConfiguration("isAlive", "Runtime isAlive must be a function")
  }
  const canExecute = options.canExecute
  if (canExecute !== undefined && typeof canExecute !== "function") {
    throw invalidConfiguration("canExecute", "Runtime canExecute must be a function when supplied")
  }
  return Object.freeze({
    filename,
    workspaceRoot,
    owner: Object.freeze({ hostId }),
    isAlive,
    canExecute
  })
}

/**
 * Provides the migrated database, durable stores, owner minter, workspace,
 * and local artifact store without constructing an engine.
 *
 * This is the lower-level seam for integrations that construct another
 * engine-backed service over the same storage context, such as the time-travel
 * example. Application entry points should normally use {@link layer}.
 *
 * @since 0.1.0
 * @category layers
 * @slop
 */
export const storage = (filename: string, workspaceRoot?: string) => {
  const configuredFilename = decodeField("filename", Schema.NonEmptyString, filename, nonEmpty)
  const configuredRoot = workspaceRoot === undefined
    ? undefined
    : decodeField("workspaceRoot", Schema.NonEmptyString, workspaceRoot, nonEmpty)
  return Layer.unwrap(Effect.gen(function*() {
    const path = yield* Path.Path
    const databaseRoot = path.dirname(path.resolve(configuredFilename))
    const resolvedWorkspaceRoot = configuredRoot === undefined ? databaseRoot : path.resolve(configuredRoot)
    const database = Layer.provideMerge(Migrations.layer, DurableWriter.layer())
    return Layer.mergeAll(
      SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
      RunStore.layer,
      AttemptStore.layer,
      CacheStore.layer,
      DurableEngineState.layer,
      OwnerIdentity.layer,
      Workspace.layer(resolvedWorkspaceRoot),
      ArtifactStore.layerFileSystem({ directory: path.join(databaseRoot, "objects") })
    ).pipe(Layer.provideMerge(database))
  })).pipe(Layer.fresh)
}

const composition = <
  BoundaryError,
  BoundaryRequirements,
  SandboxError,
  SandboxRequirements,
  Registered,
  RegistrationError,
  RegistrationRequirements,
  RegistryOut,
  RegistryError,
  RegistryRequirements
>(
  options: Options,
  stepBoundary: Layer.Layer<StepBoundary.Service, BoundaryError, BoundaryRequirements>,
  workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, SandboxError, SandboxRequirements>,
  registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>,
  registry: Layer.Layer<RegistryOut, RegistryError, RegistryRequirements>
) => {
  const validated = validate(options)
  const execution = Layer.merge(stepBoundary, workspaceSandbox).pipe(
    Layer.provideMerge(storage(validated.filename, validated.workspaceRoot)),
    // Credential redaction covers the operator's terminal as well as the
    // journal (the release policy). It sits UNDER the engine so the
    // context the engine captures for an action body carries it: a line an
    // action, the harness, or an agent session writes leaves through the same
    // rules `@smthrs/journal` applies on the write path.
    Layer.provideMerge(RedactedLogger.layer())
  )
  const engine = EngineStore.layer({
    owner: validated.owner,
    journalSource: `${validated.owner.hostId}-engine`,
    isAlive: validated.isAlive,
    canExecute: validated.canExecute
  }).pipe(Layer.provideMerge(execution))
  // The registry is built BETWEEN the engine and the registration phase, so a
  // registration that reads a catalog off it — `@smthrs/registry`'s
  // `Executable.layer`, which turns every discovered descriptor into a
  // registered durable flow — has both the registry and the engine's own
  // context in hand, and the engine is still live before the first flow is
  // registered.
  // Constant store and registration layers must belong to this runtime's SQL
  // context. An enclosing control plane can build the same layer values over
  // another database; sharing their memoized instances crosses that boundary.
  return registerFlows.pipe(Layer.provideMerge(registry), Layer.provideMerge(engine), Layer.fresh)
}

/**
 * The registry-taking construction every public arity delegates to.
 *
 * {@link make}, {@link layer} and {@link layerHost} are OVERLOADED on this
 * rather than defaulting the registry argument, because a default value cannot
 * honor a caller-chosen registry type. With one signature and a default,
 * `layer<..., MyRegistry, never, never>(options, boundary, sandbox, register)`
 * compiles and returns a layer that CLAIMS to provide `MyRegistry` while
 * providing nothing, and the disagreement surfaces as a service-not-found
 * defect when the layer builds instead of as a type error where it was
 * written. Splitting the arities keeps the registry type parameters on the
 * signature that also takes the argument, so the mismatch cannot be spelled,
 * and the empty registry the shorter arity passes is `Layer.empty` at its own
 * `Layer<never, never, never>` type rather than an assertion.
 */
const makeWithRegistry = <
  BoundaryError,
  BoundaryRequirements,
  SandboxError,
  SandboxRequirements,
  Registered,
  RegistrationError,
  RegistrationRequirements,
  RegistryOut,
  RegistryError,
  RegistryRequirements
>(
  options: Options,
  stepBoundary: Layer.Layer<StepBoundary.Service, BoundaryError, BoundaryRequirements>,
  workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, SandboxError, SandboxRequirements>,
  registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>,
  registry: Layer.Layer<RegistryOut, RegistryError, RegistryRequirements>
) => Layer.build(composition(options, stepBoundary, workspaceSandbox, registerFlows, registry))

/**
 * Builds the production service context in the current scope.
 *
 * The caller selects the filesystem boundary and workspace sandbox layers,
 * and supplies a registration layer such as a merge of action implementation
 * layers and `Interpreter.layer(flow)`. `Jj`, Effect `FileSystem`, and Effect
 * `Crypto` remain requirements of the returned effect and are supplied by the
 * host. Closing the surrounding scope closes the database, journal writer,
 * sweeper, and active engine fibers through their existing finalizers.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export const make: {
  <
    BoundaryError,
    BoundaryRequirements,
    SandboxError,
    SandboxRequirements,
    Registered,
    RegistrationError,
    RegistrationRequirements
  >(
    options: Options,
    stepBoundary: Layer.Layer<StepBoundary.Service, BoundaryError, BoundaryRequirements>,
    workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, SandboxError, SandboxRequirements>,
    registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>
  ): ReturnType<
    typeof makeWithRegistry<
      BoundaryError,
      BoundaryRequirements,
      SandboxError,
      SandboxRequirements,
      Registered,
      RegistrationError,
      RegistrationRequirements,
      never,
      never,
      never
    >
  >
  <
    BoundaryError,
    BoundaryRequirements,
    SandboxError,
    SandboxRequirements,
    Registered,
    RegistrationError,
    RegistrationRequirements,
    RegistryOut,
    RegistryError,
    RegistryRequirements
  >(
    options: Options,
    stepBoundary: Layer.Layer<StepBoundary.Service, BoundaryError, BoundaryRequirements>,
    workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, SandboxError, SandboxRequirements>,
    registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>,
    registry: Layer.Layer<RegistryOut, RegistryError, RegistryRequirements>
  ): ReturnType<
    typeof makeWithRegistry<
      BoundaryError,
      BoundaryRequirements,
      SandboxError,
      SandboxRequirements,
      Registered,
      RegistrationError,
      RegistrationRequirements,
      RegistryOut,
      RegistryError,
      RegistryRequirements
    >
  >
} = (
  options: Options,
  stepBoundary: Layer.Layer<StepBoundary.Service, any, any>,
  workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, any, any>,
  registerFlows: Layer.Layer<any, any, any>,
  registry?: Layer.Layer<any, any, any>
) => makeWithRegistry(options, stepBoundary, workspaceSandbox, registerFlows, registry ?? Layer.empty)

/** The registry-taking layer both {@link layer} arities delegate to. */
const layerWithRegistry = <
  BoundaryError,
  BoundaryRequirements,
  SandboxError,
  SandboxRequirements,
  Registered,
  RegistrationError,
  RegistrationRequirements,
  RegistryOut,
  RegistryError,
  RegistryRequirements
>(
  options: Options,
  stepBoundary: Layer.Layer<StepBoundary.Service, BoundaryError, BoundaryRequirements>,
  workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, SandboxError, SandboxRequirements>,
  registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>,
  registry: Layer.Layer<RegistryOut, RegistryError, RegistryRequirements>
) =>
  Layer.effectContext(
    makeWithRegistry(options, stepBoundary, workspaceSandbox, registerFlows, registry)
  )

/**
 * Provides the scoped runtime over the supplied SQL client.
 *
 * `registerFlows` is the final startup phase, not a layer callers merge beside
 * the engine. This serializes the durability-sensitive order and ensures the
 * runtime is usable only after every supplied flow registration has completed.
 * Shutdown is scope closure; this module installs no process or signal
 * handlers.
 *
 * `registry` is the optional catalog the registration phase reads from. A host
 * that discovers its flows rather than listing them passes
 * `@smthrs/registry`'s `Registry.layerProject({ root })` — `Discovery` over
 * `<root>/flows/**` plus any installed packs — and a `registerFlows` built from
 * `Executable.layer(...)`; the registry is provided beneath registration, so
 * every discovered flow is registered before the runtime accepts a launch.
 * Omitting it is exactly the previous behavior.
 *
 * @since 0.1.0
 * @category layers
 * @slop
 */
export const layer: {
  <
    BoundaryError,
    BoundaryRequirements,
    SandboxError,
    SandboxRequirements,
    Registered,
    RegistrationError,
    RegistrationRequirements
  >(
    options: Options,
    stepBoundary: Layer.Layer<StepBoundary.Service, BoundaryError, BoundaryRequirements>,
    workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, SandboxError, SandboxRequirements>,
    registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>
  ): ReturnType<
    typeof layerWithRegistry<
      BoundaryError,
      BoundaryRequirements,
      SandboxError,
      SandboxRequirements,
      Registered,
      RegistrationError,
      RegistrationRequirements,
      never,
      never,
      never
    >
  >
  <
    BoundaryError,
    BoundaryRequirements,
    SandboxError,
    SandboxRequirements,
    Registered,
    RegistrationError,
    RegistrationRequirements,
    RegistryOut,
    RegistryError,
    RegistryRequirements
  >(
    options: Options,
    stepBoundary: Layer.Layer<StepBoundary.Service, BoundaryError, BoundaryRequirements>,
    workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, SandboxError, SandboxRequirements>,
    registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>,
    registry: Layer.Layer<RegistryOut, RegistryError, RegistryRequirements>
  ): ReturnType<
    typeof layerWithRegistry<
      BoundaryError,
      BoundaryRequirements,
      SandboxError,
      SandboxRequirements,
      Registered,
      RegistrationError,
      RegistrationRequirements,
      RegistryOut,
      RegistryError,
      RegistryRequirements
    >
  >
} = (
  options: Options,
  stepBoundary: Layer.Layer<StepBoundary.Service, any, any>,
  workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, any, any>,
  registerFlows: Layer.Layer<any, any, any>,
  registry?: Layer.Layer<any, any, any>
) => layerWithRegistry(options, stepBoundary, workspaceSandbox, registerFlows, registry ?? Layer.empty)
