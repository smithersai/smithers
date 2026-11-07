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
import { DurableWriter } from "@smthrs/database";
import { DurableEngineState, EngineStore, type StepBoundary, type WorkspaceSandbox } from "@smthrs/engine-store";
import { AttemptStore, RunStore } from "@smthrs/run-store";
import { CacheStore } from "@smthrs/step-cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type RegistryArgs } from "./internal/RegistryArgs.vibe";
export { type RegistryArgs, registryLayer } from "./internal/RegistryArgs.vibe";
export { decodeField, type Options, RuntimeConfigurationError, validate } from "./internal/RuntimeOptions.vibe";
import { type Options } from "./internal/RuntimeOptions.vibe";
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
export declare const storage: Layer.Layer<AttemptStore.AttemptStore | CacheStore.CacheStore | DurableEngineState.DurableEngineState | DurableWriter.DurableWriter | import("@smthrs/journal/Journal").Journal | RunStore.RunStore, import("@smthrs/journal/Journal").JournalError | import("effect/sql/Migrator").MigrationError | import("effect/sql/SqlError").SqlError, import("effect/sql/SqlClient").SqlClient>;
/** Compose an isolated runtime from injected storage and execution services.
 * @category layers
 * @since 1.0.0-rc.0
 */
export declare const layer: <BoundaryError, BoundaryRequirements, SandboxError, SandboxRequirements, Registered, RegistrationError, RegistrationRequirements, RegistryOut = never, RegistryError = never, RegistryRequirements = never>(options: Options, stepBoundary: Layer.Layer<StepBoundary.Service, BoundaryError, BoundaryRequirements>, workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, SandboxError, SandboxRequirements>, registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>, ...registry: RegistryArgs<RegistryOut, RegistryError, RegistryRequirements>) => Layer.Layer<Registered | RegistryOut | AttemptStore.AttemptStore | CacheStore.CacheStore | EngineStore.Driver | DurableEngineState.DurableEngineState | DurableWriter.DurableWriter | import("@smthrs/flow/FlowRuntime").FlowRuntime | import("@smthrs/journal/Journal").Journal | RunStore.RunStore | StepBoundary.Service | WorkspaceSandbox.Service | import("@smthrs/engine/FlowEngine").SnapshotBoundary, BoundaryError | RegistrationError | RegistryError | SandboxError | import("@smthrs/journal/Journal").JournalError | import("effect/sql/Migrator").MigrationError | import("effect/sql/SqlError").SqlError, import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/jj").Jj | import("@smthrs/engine-store/OwnerIdentity").OwnerIdentity | import("effect/sql/SqlClient").SqlClient | Exclude<Exclude<RegistryRequirements, AttemptStore.AttemptStore | CacheStore.CacheStore | EngineStore.Driver | DurableEngineState.DurableEngineState | DurableWriter.DurableWriter | import("@smthrs/flow/FlowRuntime").FlowRuntime | import("@smthrs/journal/Journal").Journal | RunStore.RunStore | StepBoundary.Service | WorkspaceSandbox.Service | import("@smthrs/engine/FlowEngine").SnapshotBoundary>, import("effect/Scope").Scope> | Exclude<Exclude<Exclude<RegistrationRequirements, RegistryOut>, AttemptStore.AttemptStore | CacheStore.CacheStore | EngineStore.Driver | DurableEngineState.DurableEngineState | DurableWriter.DurableWriter | import("@smthrs/flow/FlowRuntime").FlowRuntime | import("@smthrs/journal/Journal").Journal | RunStore.RunStore | StepBoundary.Service | WorkspaceSandbox.Service | import("@smthrs/engine/FlowEngine").SnapshotBoundary>, import("effect/Scope").Scope> | Exclude<Exclude<Exclude<Exclude<BoundaryRequirements, AttemptStore.AttemptStore | CacheStore.CacheStore | DurableEngineState.DurableEngineState | DurableWriter.DurableWriter | import("@smthrs/journal/Journal").Journal | RunStore.RunStore>, never>, never>, import("effect/Scope").Scope> | Exclude<Exclude<Exclude<Exclude<SandboxRequirements, AttemptStore.AttemptStore | CacheStore.CacheStore | DurableEngineState.DurableEngineState | DurableWriter.DurableWriter | import("@smthrs/journal/Journal").Journal | RunStore.RunStore>, never>, never>, import("effect/Scope").Scope>>;
/** Build the runtime in the caller's scope.
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const make: <BoundaryError, BoundaryRequirements, SandboxError, SandboxRequirements, Registered, RegistrationError, RegistrationRequirements, RegistryOut = never, RegistryError = never, RegistryRequirements = never>(options: Options, stepBoundary: Layer.Layer<StepBoundary.Service, BoundaryError, BoundaryRequirements>, workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, SandboxError, SandboxRequirements>, registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>, ...registry: RegistryArgs<RegistryOut, RegistryError, RegistryRequirements>) => Effect.Effect<Context.Context<Registered | RegistryOut | AttemptStore.AttemptStore | CacheStore.CacheStore | EngineStore.Driver | DurableEngineState.DurableEngineState | DurableWriter.DurableWriter | import("@smthrs/flow/FlowRuntime").FlowRuntime | import("@smthrs/journal/Journal").Journal | RunStore.RunStore | StepBoundary.Service | WorkspaceSandbox.Service | import("@smthrs/engine/FlowEngine").SnapshotBoundary>, BoundaryError | RegistrationError | RegistryError | SandboxError | import("@smthrs/journal/Journal").JournalError | import("effect/sql/Migrator").MigrationError | import("effect/sql/SqlError").SqlError, import("@smthrs/crypto/Crypto").Crypto | import("@smthrs/jj").Jj | import("@smthrs/engine-store/OwnerIdentity").OwnerIdentity | import("effect/Scope").Scope | import("effect/sql/SqlClient").SqlClient | Exclude<Exclude<RegistryRequirements, AttemptStore.AttemptStore | CacheStore.CacheStore | EngineStore.Driver | DurableEngineState.DurableEngineState | DurableWriter.DurableWriter | import("@smthrs/flow/FlowRuntime").FlowRuntime | import("@smthrs/journal/Journal").Journal | RunStore.RunStore | StepBoundary.Service | WorkspaceSandbox.Service | import("@smthrs/engine/FlowEngine").SnapshotBoundary>, import("effect/Scope").Scope> | Exclude<Exclude<Exclude<RegistrationRequirements, RegistryOut>, AttemptStore.AttemptStore | CacheStore.CacheStore | EngineStore.Driver | DurableEngineState.DurableEngineState | DurableWriter.DurableWriter | import("@smthrs/flow/FlowRuntime").FlowRuntime | import("@smthrs/journal/Journal").Journal | RunStore.RunStore | StepBoundary.Service | WorkspaceSandbox.Service | import("@smthrs/engine/FlowEngine").SnapshotBoundary>, import("effect/Scope").Scope> | Exclude<Exclude<Exclude<Exclude<BoundaryRequirements, AttemptStore.AttemptStore | CacheStore.CacheStore | DurableEngineState.DurableEngineState | DurableWriter.DurableWriter | import("@smthrs/journal/Journal").Journal | RunStore.RunStore>, never>, never>, import("effect/Scope").Scope> | Exclude<Exclude<Exclude<Exclude<SandboxRequirements, AttemptStore.AttemptStore | CacheStore.CacheStore | DurableEngineState.DurableEngineState | DurableWriter.DurableWriter | import("@smthrs/journal/Journal").Journal | RunStore.RunStore>, never>, never>, import("effect/Scope").Scope>>;
