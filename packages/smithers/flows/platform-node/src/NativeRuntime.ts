/**
 * The native Node and Bun lifecycle over the shared, injected durable runtime.
 *
 * `@smthrs/flows` `Runtime.layer` composes the engine and its stores over an
 * injected SQL client and injected host services, and names no platform. This
 * module is what a native host adds on top: it opens the database a filename
 * or PostgreSQL URL names, keeps artifacts on disk beside it, confines file
 * actions to a workspace root, guards flow bodies behind the capability
 * kernel, and installs the signal handlers that shut a host down cleanly.
 *
 * `NodeRuntime` binds it to Node's database and host layers, and
 * `@smthrs/platform-bun`'s `BunRuntime` binds it to Bun's. A program uses one
 * of those two; {@link make} is the seam they share.
 *
 * @since 1.0.0
 */

import * as NodePath from "@effect/platform-node/NodePath"
import { ArtifactStore } from "@smthrs/artifacts"
import { Capability, Permission } from "@smthrs/capability"
import { EngineStore, OwnerIdentity, StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
import { Action } from "@smthrs/flow"
import { Runtime } from "@smthrs/flows"
import { RedactedLogger } from "@smthrs/journal"
import {
  type ContainedSpawner,
  GrantStore,
  HostServices,
  Jj as KernelJj,
  ProcessLedger,
  Workspace
} from "@smthrs/kernel"
import type { Ownership } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import type * as SqlClient from "effect/sql/SqlClient"
import { mkdirSync } from "node:fs"
import { constants } from "node:os"
import { dirname, join, resolve } from "node:path"
import * as HostLiveness from "./HostLiveness.ts"
import type * as NodeHost from "./NodeHost.ts"
import type * as ProcessReaper from "./ProcessReaper.ts"

/**
 * Configuration for the native Node and Bun runtimes: the injected runtime's
 * options, plus the database the host opens and the workspace it confines
 * file actions to. Artifacts live beside the database file.
 *
 * @since 1.0.0
 * @category models
 */
export interface Options extends Runtime.Options {
  /** SQLite database filename or PostgreSQL URL. A file's parent directory is created recursively. */
  readonly filename: string
  /** Workspace whose file actions may read or mutate. */
  readonly workspaceRoot: string
}

/** Native process and host configuration.
 * @since 1.0.0
 * @category models
 */
export interface HostOptions {
  readonly filename: string
  readonly workspaceRoot: string
  readonly owner: {
    readonly hostId: string
  }
  readonly isAlive?: Ownership.LivenessCheck | undefined
  readonly requestResume?: Runtime.Options["requestResume"]
  readonly canExecute?: Runtime.Options["canExecute"]
  readonly canActivate?: Runtime.Options["canActivate"]
  readonly cacheEnvironment?: Runtime.Options["cacheEnvironment"]
  readonly sourceRevision?: Runtime.Options["sourceRevision"]
  readonly rules?: GrantStore.MakeOptions["rules"]
  readonly signals?: ReadonlyArray<NodeJS.Signals> | undefined
  readonly shutdownTimeoutMs?: number | undefined
  readonly containment?: (ContainedSpawner.Options & ProcessReaper.Options) | undefined
}

/**
 * What a native runtime binds: the name its configuration errors carry, the
 * driver a filename opens, the host bundle, and the host's `Crypto`.
 *
 * @since 1.0.0
 * @category models
 */
export interface Platform {
  readonly name: string
  readonly database: (filename: string) => Layer.Layer<SqlClient.SqlClient>
  readonly host: Pick<typeof NodeHost, "layerAt" | "layerContainedAt">
  readonly crypto: Layer.Layer<Crypto.Crypto>
}

const RuntimeConfigurationError = Runtime.RuntimeConfigurationError
type RuntimeConfigurationError = Runtime.RuntimeConfigurationError

/** Binds the shared native lifecycle to a platform’s database and host layers.
 * @since 1.0.0
 * @category constructors
 */
export const make = (platform: Platform) => {
  const invalidConfiguration = (field: string, message: string): RuntimeConfigurationError =>
    new RuntimeConfigurationError({ code: "invalid_runtime_configuration", field, message })

  const decodeField = <A>(field: string, schema: Schema.Codec<A>, value: unknown, expectation: string): A =>
    Runtime.decodeField(field, schema, value, expectation, platform.name)

  const nonEmpty = "must be a non-empty string"

  const isPostgres = (filename: string): boolean => /^postgres(?:ql)?:\/\//.test(filename)

  const validate = (options: Options): Options => {
    const filename = decodeField("filename", Schema.NonEmptyString, options.filename, nonEmpty)
    const workspaceRoot = decodeField("workspaceRoot", Schema.NonEmptyString, options.workspaceRoot, nonEmpty)
    return {
      ...Runtime.validate(options, platform.name),
      filename: isPostgres(filename) ? filename : resolve(filename),
      workspaceRoot: resolve(workspaceRoot)
    }
  }

  const databaseLayer = (filename: string) =>
    // Share the entire driver graph, not only Layer.unwrap's factory. Parallel
    // host consumers share the memoized engine; distinct driver acquisitions
    // let one consumer close its SQL client while another still owns the engine
    // and its shutdown drains (#2756).
    Layer.suspend(() =>
      Layer.unwrap(Effect.gen(function*() {
        if (isPostgres(filename)) return platform.database(filename)
        const directory = dirname(filename)
        const fs = yield* FileSystem.FileSystem
        // The engine database is host configuration and is never a path a model
        // can name, so it does not have to live inside the workspace the run is
        // confined to. A host that serves a live JJ or Git checkout deliberately
        // keeps `engine.db` outside it, because the engine writes on every step
        // and inside the checkout those writes are untracked files that move the
        // working-copy tree digest under the code the run is reading. The
        // injected filesystem stays the first answer, so a confined workspace
        // still creates its own directory through the kernel; a path that
        // filesystem refuses as outside its pinned root falls back to the host's
        // own mkdir, which reports its own failure rather than hiding this one.
        yield* fs.makeDirectory(directory, { recursive: true }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.sync(() => mkdirSync(directory, { recursive: true }))
          )
        )
        return platform.database(filename)
      }))
    )

  /**
   * What a native host keeps outside SQL: its process identity, the workspace
   * root, and artifacts on disk beside the database. A database file keeps
   * them in its own directory; a PostgreSQL store names no directory, so they
   * live under `<workspaceRoot>/.flows`, or `./.flows` without one. The
   * workspace root defaults to that directory.
   */
  const hostStorage = (filename: string, workspaceRoot: string | undefined) => {
    const databaseRoot = isPostgres(filename) ? join(workspaceRoot ?? resolve("."), ".flows") : dirname(filename)
    return Layer.mergeAll(
      OwnerIdentity.layer,
      Workspace.layer(workspaceRoot ?? databaseRoot),
      ArtifactStore.layerFileSystem({ directory: join(databaseRoot, "objects") })
    ).pipe(Layer.fresh)
  }

  const storage = (filename: string, workspaceRoot?: string) => {
    const decodedFilename = decodeField("filename", Schema.NonEmptyString, filename, nonEmpty)
    const validatedFilename = isPostgres(decodedFilename) ? decodedFilename : resolve(decodedFilename)
    const root = workspaceRoot === undefined
      ? undefined
      : resolve(decodeField("workspaceRoot", Schema.NonEmptyString, workspaceRoot, nonEmpty))
    return Layer.merge(Runtime.storage, hostStorage(validatedFilename, root)).pipe(
      Layer.provideMerge(databaseLayer(validatedFilename)),
      Layer.provide(NodePath.layer)
    )
  }

  const layer = <
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
    ...registry: Runtime.RegistryArgs<RegistryOut, RegistryError, RegistryRequirements>
  ) => {
    const validated = validate(options)
    return Runtime.layer(validated, stepBoundary, workspaceSandbox, registerFlows, ...registry).pipe(
      Layer.provideMerge(hostStorage(validated.filename, validated.workspaceRoot)),
      Layer.provideMerge(databaseLayer(validated.filename)),
      Layer.provide(NodePath.layer)
    )
  }

  const make = <
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
    ...registry: Runtime.RegistryArgs<RegistryOut, RegistryError, RegistryRequirements>
  ) => Layer.build(layer(options, stepBoundary, workspaceSandbox, registerFlows, ...registry))

  const defaultSignals: ReadonlyArray<NodeJS.Signals> = Object.freeze(["SIGINT", "SIGTERM"])

  const defaultShutdownTimeoutMs = 30_000

  const maximumShutdownTimeoutMs = 2_147_483_647

  const catchableSignals = new Set<NodeJS.Signals>(
    Object.keys(constants.signals)
      .filter((signal) => signal !== "SIGKILL" && signal !== "SIGSTOP") as Array<NodeJS.Signals>
  )

  const snapshotSignals = (
    signals: ReadonlyArray<NodeJS.Signals> | undefined
  ): ReadonlyArray<NodeJS.Signals> => {
    const configured = signals ?? defaultSignals
    if (!Array.isArray(configured)) {
      throw invalidConfiguration("signals", `${platform.name} signals must be an array`)
    }
    const snapshot: Array<NodeJS.Signals> = []
    const seen = new Set<NodeJS.Signals>()
    for (const candidate of configured as ReadonlyArray<unknown>) {
      if (typeof candidate !== "string" || !catchableSignals.has(candidate as NodeJS.Signals)) {
        throw invalidConfiguration("signals", `${platform.name} cannot install signal ${String(candidate)}`)
      }
      const signal = candidate as NodeJS.Signals
      if (!seen.has(signal)) {
        seen.add(signal)
        snapshot.push(signal)
      }
    }
    return Object.freeze(snapshot)
  }

  const snapshotShutdownTimeout = (timeoutMs: number | undefined): number => {
    const timeout = timeoutMs ?? defaultShutdownTimeoutMs
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > maximumShutdownTimeoutMs) {
      throw invalidConfiguration(
        "shutdownTimeoutMs",
        `${platform.name} shutdownTimeoutMs must be an integer from 0 through ${maximumShutdownTimeoutMs}`
      )
    }
    return timeout
  }

  // A JavaScript caller can put anything in the list, so a member that is not
  // a rule is refused as the option it is rather than with whatever the
  // property reads or the constructors throw.
  const snapshotRule = (rule: Permission.Rule): Permission.Rule => {
    try {
      return new Permission.Rule({
        effect: rule.effect,
        pattern: new Capability.CapabilityPattern({
          action: rule.pattern.action,
          resource: rule.pattern.resource
        })
      })
    } catch {
      throw invalidConfiguration("rules", `${platform.name} rules must be capability rules`)
    }
  }

  const snapshotRules = (
    rules: GrantStore.MakeOptions["rules"]
  ): GrantStore.MakeOptions["rules"] => {
    if (rules === undefined) return undefined
    if (!Array.isArray(rules)) {
      throw invalidConfiguration("rules", `${platform.name} rules must be an array`)
    }
    if (rules.length > 0 && Array.isArray(rules[0])) {
      return Object.freeze(
        (rules as ReadonlyArray<ReadonlyArray<Permission.Rule>>).map((ruleset) => {
          if (!Array.isArray(ruleset)) {
            throw invalidConfiguration("rules", `${platform.name} rulesets must be arrays`)
          }
          return Object.freeze(ruleset.map(snapshotRule))
        })
      )
    }
    return Object.freeze((rules as ReadonlyArray<Permission.Rule>).map(snapshotRule))
  }

  const snapshotContainment = (
    options: (ContainedSpawner.Options & ProcessReaper.Options) | undefined
  ): (ContainedSpawner.Options & ProcessReaper.Options) | undefined => {
    if (options === undefined) return undefined
    const graceMs = options.graceMs
    const platform = options.platform
    const ownerPid = options.ownerPid
    const system = options.system
    const systemSnapshot = system === undefined
      ? undefined
      : Object.freeze({
        isAlive: system.isAlive,
        startedAtMs: system.startedAtMs,
        ownGroup: system.ownGroup,
        bootedAtMs: system.bootedAtMs,
        refuseTarget: system.refuseTarget,
        killTree: system.killTree
      })
    return Object.freeze({
      ...(graceMs === undefined ? {} : { graceMs }),
      ...(platform === undefined ? {} : { platform }),
      ...(ownerPid === undefined ? {} : { ownerPid }),
      ...(systemSnapshot === undefined ? {} : { system: systemSnapshot })
    })
  }

  interface ValidatedHostOptions extends Options {
    readonly rules: GrantStore.MakeOptions["rules"]
    readonly signals: ReadonlyArray<NodeJS.Signals>
    readonly shutdownTimeoutMs: number
    readonly containment: (ContainedSpawner.Options & ProcessReaper.Options) | undefined
  }

  const validateHost = (options: HostOptions): ValidatedHostOptions => {
    const filename = options.filename
    const owner = options.owner
    const hostId = decodeField("owner.hostId", Schema.NonEmptyString, owner?.hostId, nonEmpty)
    const configuredLiveness = options.isAlive
    const rules = options.rules
    const signals = options.signals
    const shutdownTimeoutMs = options.shutdownTimeoutMs
    const containment = options.containment
    const validated = validate({
      filename,
      workspaceRoot: options.workspaceRoot,
      owner: { hostId },
      isAlive: configuredLiveness ?? HostLiveness.isAlive({ hostId }),
      requestResume: options.requestResume,
      canExecute: options.canExecute,
      canActivate: options.canActivate,
      cacheEnvironment: options.cacheEnvironment,
      sourceRevision: options.sourceRevision
    })
    return Object.freeze({
      ...validated,
      rules: snapshotRules(rules),
      signals: snapshotSignals(signals),
      shutdownTimeoutMs: snapshotShutdownTimeout(shutdownTimeoutMs),
      containment: snapshotContainment(containment)
    })
  }

  const signalExitCode = (signal: NodeJS.Signals): number =>
    128 + ((constants.signals as Record<string, number>)[signal] ?? constants.signals.SIGTERM)

  const onSignal = (
    signals: ReadonlyArray<NodeJS.Signals>,
    runtime: Scope.Closeable,
    timeoutMs: number
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function*() {
      let closing = false
      let deadline: NodeJS.Timeout | undefined
      const leave = (signal: NodeJS.Signals) => {
        process.exit(signalExitCode(signal))
      }
      const handlers = signals.map((signal) => {
        const handler = () => {
          if (closing) {
            // The operator asked twice. Whatever the shutdown is waiting for, it
            // has stopped being this program's decision.
            leave(signal)
            return
          }
          closing = true
          Effect.runFork(Scope.close(runtime, Exit.void))
          deadline = setTimeout(() => leave(signal), timeoutMs)
          // A shutdown that finishes on time must not be held open by its own
          // deadline timer.
          deadline.unref()
        }
        return { signal, handler }
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (deadline !== undefined) clearTimeout(deadline)
        })
      )
      for (const { handler, signal } of handlers) {
        yield* Effect.acquireRelease(
          Effect.sync(() => process.on(signal, handler)),
          () => Effect.sync(() => process.removeListener(signal, handler))
        )
      }
    })

  const layerHost = <
    Registered,
    RegistrationError,
    RegistrationRequirements,
    RegistryOut = never,
    RegistryError = never,
    RegistryRequirements = never
  >(
    options: HostOptions,
    registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>,
    ...registry: Runtime.RegistryArgs<RegistryOut, RegistryError, RegistryRequirements>
  ) => {
    const validated = validateHost(options)
    const workspaceRoot = validated.workspaceRoot
    // The layering is the design decision this function makes, and it has two
    // sides. The engine's MACHINERY — the SQLite storage, the step boundary, the
    // workspace sandbox — runs on the raw host: a database directory the engine
    // must create to exist at all cannot be something the engine asks permission
    // for, and a whole-tree sandbox copy is engine bookkeeping, not an agent
    // reaching for a file. Everything the engine then hands a FLOW BODY is the
    // guarded surface, because a body is exactly what the capability check
    // exists for. That is why the engine is built over the kernel here and not
    // beside it: an action resolves its host services from the engine's context.
    // The one exception is inside the machinery itself: cache replay and
    // sandbox copy-back write what recorded evidence names, so each confines
    // its own writes to the workspace root through the kernel's descriptor-
    // relative `confined` view rather than trusting this raw host's pathnames.
    const raw = Layer.mergeAll(platform.host.layerAt(workspaceRoot), platform.crypto).pipe(
      Layer.provideMerge(RedactedLogger.layer())
    )
    const privilegedJj = Layer.effect(KernelJj.Jj, KernelJj.Jj).pipe(Layer.provide(raw))
    const store = storage(validated.filename, workspaceRoot).pipe(Layer.provideMerge(raw))
    const execution = Layer.merge(StepBoundary.layer, WorkspaceSandbox.layerFileSystem()).pipe(
      Layer.provideMerge(store)
    )
    const guarded = HostServices.layer.pipe(
      Layer.provide(Layer.orDie(GrantStore.layer({ attended: false, rules: validated.rules }))),
      Layer.provideMerge(platform.host.layerContainedAt(workspaceRoot, validated.containment)),
      Layer.provideMerge(ProcessLedger.layer({ hostId: validated.owner.hostId, ownerPid: process.pid })),
      Layer.provideMerge(execution)
    )
    const engine = EngineStore.layerWithPrivilegedJj(
      {
        owner: validated.owner,
        journalSource: `${validated.owner.hostId}-engine`,
        isAlive: validated.isAlive,
        canExecute: validated.canExecute,
        canActivate: validated.canActivate,
        requestResume: validated.requestResume,
        // The same declaration `Runtime.layer` passes: the tree this host
        // read its flows out of, or nothing (D-068).
        sourceRevision: validated.sourceRevision
      },
      privilegedJj
    ).pipe(
      Layer.provideMerge(guarded),
      // Under the engine, as in `Runtime.layer`: dispatch reads the cache
      // environment off the context the engine captures for an action.
      Layer.provideMerge(
        validated.cacheEnvironment === undefined
          ? Layer.empty
          : Action.layerCacheEnvironment(validated.cacheEnvironment)
      )
    )
    // Registration stays the final startup phase, exactly as in `layer`: no
    // persisted run can resume through this composition before its flow is
    // registered. The registry sits directly beneath it, so a registration built
    // from a discovered catalog reads the catalog on the guarded host this
    // composition already built.
    const composed = registerFlows.pipe(Layer.provideMerge(Runtime.registryLayer(registry)), Layer.provideMerge(engine))
    return Layer.effectContext(Effect.gen(function*() {
      const parent = yield* Scope.Scope
      // The composition is built into a scope this module can close, because a
      // signal has to be able to shut the runtime down without the program
      // having handed anything over. Forking from the caller's scope keeps the
      // ordinary path unchanged: closing the caller's scope closes this one.
      const runtime = yield* Scope.fork(parent)
      const context = yield* Effect.provideService(Layer.build(composed), Scope.Scope, runtime)
      // As in `Runtime.layer`: one line says what every registration's recovery did.
      yield* Context.get(context, EngineStore.Driver).reportRecovery
      yield* onSignal(
        validated.signals,
        runtime,
        validated.shutdownTimeoutMs
      )
      return context
    }))
  }

  return {
    storage,
    make,
    layer,
    layerHost,
    signalExitCode,
    defaultShutdownTimeoutMs,
    maximumShutdownTimeoutMs
  } as const
}

/** The native host API {@link make} returns, shared by `NodeRuntime` and `BunRuntime`.
 * @since 1.0.0
 * @category models
 */
export type Api = ReturnType<typeof make>
