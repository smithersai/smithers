/** Shared native runtime contracts.
 * @since 1.0.0
 */
import type * as FlowEngine from "@smthrs/engine/FlowEngine"
import type * as FlowRuntime from "@smthrs/flow/FlowRuntime"
import type * as jj from "@smthrs/jj"
import type * as Journal from "@smthrs/journal/Journal"
import type * as Context from "effect/Context"
import type * as PlatformError from "effect/PlatformError"
import type * as Migrator from "effect/unstable/sql/Migrator"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as SqlError from "effect/unstable/sql/SqlError"
/** Existing native composition contracts, shared by Node and Bun.
 * @since 1.0.0
 */
import type * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import type { DurableWriter } from "@smthrs/database"
import type { DurableEngineState, OwnerIdentity, StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
import type * as ContainedSpawner from "@smthrs/kernel/ContainedSpawner"
import type * as GrantStore from "@smthrs/kernel/GrantStore"
import type * as KernelJj from "@smthrs/kernel/Jj"
import type * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import type * as Workspace from "@smthrs/kernel/Workspace"
import type * as NodeHost from "@smthrs/platform-node/NodeHost"
import type * as ProcessReaper from "@smthrs/platform-node/ProcessReaper"
import type { AttemptStore, Ownership, RunStore } from "@smthrs/run-store"
import type { CacheStore } from "@smthrs/step-cache"
import type * as Crypto from "effect/Crypto"
import type * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
type StoredServices =
  | ArtifactStore.ArtifactStore
  | SqlClient.SqlClient
  | DurableWriter.DurableWriter
  | Workspace.Workspace
  | CacheStore.CacheStore
  | RunStore.RunStore
  | DurableEngineState.DurableEngineState
  | Journal.Journal
  | AttemptStore.AttemptStore
  | OwnerIdentity.OwnerIdentity
type ExecutionServices =
  | StoredServices
  | StepBoundary.Service
  | WorkspaceSandbox.Service
  | FlowRuntime.FlowRuntime
  | FlowEngine.SnapshotBoundary
type HostedServices = ExecutionServices | Crypto.Crypto | ProcessLedger.ProcessLedger | NodeHost.NodeHost
interface Options {
  readonly filename: string
  readonly workspaceRoot: string
  readonly owner: {
    readonly hostId: string
  }
  readonly isAlive: Ownership.LivenessCheck
  readonly canExecute?: ((row: RunStore.RunRow) => Effect.Effect<boolean>) | undefined
}
declare const _storage: (
  filename: string,
  workspaceRoot?: string
) => Layer.Layer<
  StoredServices,
  | PlatformError.PlatformError
  | SqlError.SqlError
  | Migrator.MigrationError
  | Journal.JournalError,
  Crypto.Crypto | FileSystem.FileSystem
>
declare const _makeWithRegistry: <
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
) => Effect.Effect<
  Context.Context<ExecutionServices | Registered | RegistryOut>,
  | PlatformError.PlatformError
  | SqlError.SqlError
  | Migrator.MigrationError
  | Journal.JournalError
  | BoundaryError
  | SandboxError
  | RegistrationError
  | RegistryError,
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Scope.Scope
  | KernelJj.Jj
  | Exclude<Exclude<BoundaryRequirements, StoredServices>, never>
  | Exclude<Exclude<SandboxRequirements, StoredServices>, never>
  | Exclude<RegistryRequirements, ExecutionServices>
  | Exclude<Exclude<RegistrationRequirements, RegistryOut>, ExecutionServices>
>
declare const _make: {
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
    typeof _makeWithRegistry<
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
    typeof _makeWithRegistry<
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
}
declare const _layerWithRegistry: <
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
) => Layer.Layer<
  ExecutionServices | Registered | RegistryOut,
  | PlatformError.PlatformError
  | SqlError.SqlError
  | Migrator.MigrationError
  | Journal.JournalError
  | BoundaryError
  | SandboxError
  | RegistrationError
  | RegistryError,
  | Crypto.Crypto
  | FileSystem.FileSystem
  | KernelJj.Jj
  | Exclude<Exclude<Exclude<BoundaryRequirements, StoredServices>, never>, Scope.Scope>
  | Exclude<Exclude<Exclude<SandboxRequirements, StoredServices>, never>, Scope.Scope>
  | Exclude<Exclude<RegistryRequirements, ExecutionServices>, Scope.Scope>
  | Exclude<Exclude<Exclude<RegistrationRequirements, RegistryOut>, ExecutionServices>, Scope.Scope>
>
declare const _layer: {
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
    typeof _layerWithRegistry<
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
    typeof _layerWithRegistry<
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
}
interface HostOptions {
  readonly filename: string
  readonly workspaceRoot: string
  readonly owner: {
    readonly hostId: string
  }
  readonly isAlive?: Ownership.LivenessCheck | undefined
  readonly rules?: GrantStore.MakeOptions["rules"]
  readonly signals?: ReadonlyArray<NodeJS.Signals> | undefined
  readonly shutdownTimeoutMs?: number | undefined
  readonly containment?: (ContainedSpawner.Options & ProcessReaper.Options) | undefined
}
declare const _defaultShutdownTimeoutMs = 30000
declare const _maximumShutdownTimeoutMs = 2147483647
declare const _signalExitCode: (signal: NodeJS.Signals) => number
declare const _layerHostWithRegistry: <
  Registered,
  RegistrationError,
  RegistrationRequirements,
  RegistryOut,
  RegistryError,
  RegistryRequirements
>(
  options: HostOptions,
  registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>,
  registry: Layer.Layer<RegistryOut, RegistryError, RegistryRequirements>
) => Layer.Layer<
  HostedServices | Registered | RegistryOut,
  | PlatformError.PlatformError
  | SqlError.SqlError
  | Migrator.MigrationError
  | Journal.JournalError
  | jj.JjError
  | RegistrationError
  | RegistryError,
  | Exclude<Exclude<Exclude<RegistryRequirements, HostedServices>, Scope.Scope>, Scope.Scope>
  | Exclude<Exclude<Exclude<Exclude<RegistrationRequirements, RegistryOut>, HostedServices>, Scope.Scope>, Scope.Scope>
>
declare const _layerHost: {
  <Registered, RegistrationError, RegistrationRequirements>(
    options: HostOptions,
    registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>
  ): ReturnType<
    typeof _layerHostWithRegistry<Registered, RegistrationError, RegistrationRequirements, never, never, never>
  >
  <Registered, RegistrationError, RegistrationRequirements, RegistryOut, RegistryError, RegistryRequirements>(
    options: HostOptions,
    registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>,
    registry: Layer.Layer<RegistryOut, RegistryError, RegistryRequirements>
  ): ReturnType<
    typeof _layerHostWithRegistry<
      Registered,
      RegistrationError,
      RegistrationRequirements,
      RegistryOut,
      RegistryError,
      RegistryRequirements
    >
  >
}

/** The native adapters preserve the existing composition contracts.
 * @since 1.0.0
 * @category models
 */
export interface NativeRuntimeApi {
  readonly storage: typeof _storage
  readonly make: typeof _make
  readonly layer: typeof _layer
  readonly layerHost: typeof _layerHost
  readonly signalExitCode: typeof _signalExitCode
  readonly defaultShutdownTimeoutMs: typeof _defaultShutdownTimeoutMs
  readonly maximumShutdownTimeoutMs: typeof _maximumShutdownTimeoutMs
}
