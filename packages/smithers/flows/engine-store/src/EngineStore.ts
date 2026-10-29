/**
 * Durable `FlowEngine.Encoded` composition over `@smthrs/journal`.
 *
 * Governing designs: `docs/concepts/ownership-and-fencing.md`,
 * `docs/concepts/attempts-and-replay.md`, and
 * `packages/smithers/flows/flow/docs/concepts/flows-and-actions.md`.
 *
 * @since 0.1.0
 */

import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { Sha256 } from "@smthrs/crypto"
import type { DurableWriter } from "@smthrs/database/DurableWriter"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { FileBoundary } from "@smthrs/flow/FileBoundary"
import { Consensus, Journal, type JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import type * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as DurableEngineState from "./DurableEngineState.ts"
import * as EngineStoreMetrics from "./EngineStoreMetrics.ts"
import * as ActionPersistence from "./internal/ActionPersistence.ts"
import * as AttemptAdmission from "./internal/AttemptAdmission.ts"
import * as AttemptProbe from "./internal/AttemptProbe.ts"
import * as CacheAgeVerdicts from "./internal/CacheAgeVerdicts.ts"
import * as DeferredPersistence from "./internal/DeferredPersistence.ts"
import * as DriveBudget from "./internal/DriveBudget.ts"
import * as EngineJj from "./internal/EngineJj.ts"
import * as NodeJournal from "./internal/NodeJournal.ts"
import * as ReplaySeed from "./internal/ReplaySeed.ts"
import * as RunDriver from "./internal/RunDriver.ts"
import * as OwnerIdentity from "./OwnerIdentity.ts"
import * as ReplayOnly from "./ReplayOnly.ts"
import { RunState } from "./RunState.ts"
import * as StepBoundary from "./StepBoundary.ts"
import * as StepSandbox from "./StepSandbox.ts"
import * as WakeBus from "./WakeBus.ts"
import * as WorkspaceSandbox from "./WorkspaceSandbox.ts"

/**
 * Why the engine itself asked a parked execution to resume, as reported to
 * {@link Options.requestResume}.
 *
 * @since 1.0.0-rc.0
 * @category models
 */
export type RequestedResumeReason = RunDriver.RequestedResumeReason

/**
 * Who wakes the runs of an engine's store: a long-lived process, or a host
 * that drives one execution from outside. See {@link Options.sweep}.
 *
 * @since 1.0.0
 * @category models
 */
export type Sweep = RunDriver.Sweep

/**
 * What one {@link drive} left an execution as.
 *
 * - `Settled`: the run reached `status` and nothing will drive it again.
 * - `Parked`: it waits. `wakeAtMs` is when its host must drive it next, the
 *   earliest pending `DurableClock` or the instant another owner's claim or
 *   lease lapses; `undefined` when only an external completion, reported
 *   through `requestResume`, wakes it.
 * - `Unfinished`: it has work due now that this drive did not do, such as a
 *   run released when the store became unavailable mid-drive. Drive it again
 *   after a backoff.
 * - `Yielded`: the drive spent its budget (`budgetMs`). It started no step
 *   after that, let the steps already running finish and record their
 *   results, and released the run at that step boundary. The run has work
 *   due now and nothing is wrong with it: drive it again at once, without a
 *   backoff. Only a drive given a budget reports it.
 *
 * @since 1.0.0
 * @category hosting
 */
export type Driven =
  | { readonly _tag: "Settled"; readonly status: RunStore.TerminalRunStatus }
  | { readonly _tag: "Parked"; readonly wakeAtMs: number | undefined }
  | { readonly _tag: "Unfinished" }
  | { readonly _tag: "Yielded" }

/**
 * What {@link drive} drives: the execution, the payload that admits it if
 * the store does not hold it yet, and an optional budget.
 *
 * `budgetMs` bounds how long the drive keeps starting steps, measured on the
 * effect `Clock` from the drive's start. A step that starts within it runs
 * to the end, however long it takes; once it is spent the drive starts no
 * other step, lets the running ones finish and record their results,
 * releases the run, and reports `Yielded`. A run that settles or parks
 * first reports that instead. The first step of a drive always starts, so a
 * budget shorter than the run's replay, or than one step, still moves the
 * run one step per drive. Absent, the drive runs until the run settles or
 * parks.
 *
 * The budget bounds when steps start, not how long one runs: a host whose
 * invocations have a hard limit sets it at that limit less its longest step.
 *
 * @since 1.0.0
 * @category hosting
 */
export interface DriveOptions {
  readonly executionId: string
  readonly payload: object
  readonly budgetMs?: number | undefined
  /**
   * How long the drive waits for a wake due soon after its run parks, in
   * milliseconds, to drive the run again itself: a durable sleep shorter than
   * this, or a completion or clock that came due as the run parked, costs no
   * new invocation of the host, which would build its runtime and replay the
   * run again to do the same. {@link defaultHoldMs} unless set; 0 hands every
   * park back. A wake past the budget's end is handed back too.
   */
  readonly holdMs?: number | undefined
}

/**
 * How long {@link drive} waits for a wake due soon after its run parks unless
 * `holdMs` says otherwise: five seconds, about what a Cloudflare Durable
 * Object pays to build its runtime and claim the run again.
 *
 * @since 1.0.0
 * @category hosting
 */
export const defaultHoldMs = 5_000

/** The most times one drive drives its run again for a wake that came due as it parked. */
const maxHeldDrives = 64

/**
 * The clock and deferred recovery an engine's registrations did, as
 * `Driver.reportRecovery` reports it: how many registrations recovered, and
 * how long they took in all, in milliseconds. A registration a hosted store
 * skips (`sweep: { host, flow }` naming another flow) recovers nothing and is
 * not counted.
 *
 * @since 1.0.0-rc.17
 * @category models
 */
export interface Recovery {
  readonly registrations: number
  readonly durationMs: number
}

/**
 * Drives one execution as far as it can go now, for a host that wakes it
 * from outside, and reports what the engine's registrations recovered. See
 * {@link drive}.
 *
 * @since 1.0.0
 * @category hosting
 */
export class Driver extends Context.Service<Driver, {
  /** Persist an admission without starting any action; the host must subsequently drive it. */
  readonly admit: (
    flow: Flow.Any,
    options: { readonly executionId: string; readonly payload: object }
  ) => Effect.Effect<void, FlowRuntime.FlowCycleDetected>
  readonly drive: (
    flow: Flow.Any,
    options: DriveOptions
  ) => Effect.Effect<Driven, FlowRuntime.FlowCycleDetected | RunStore.RunStoreError>
  /**
   * Logs `engine-store.registration.recovered` at Info with the
   * {@link Recovery} the registrations since the last report did
   * (`registrations`, `durationMs`), and answers it. Each registration's own
   * recovery is logged at Debug as `engine-store.registration.flow.recovered`
   * (`smithers.flow`, `durationMs`).
   *
   * A host reports once its registrations are built, so one engine start
   * logs one line however many flows it registers: `@smthrs/flows`
   * `Runtime.layer` and the native hosts' `layerHost` do. A report with
   * nothing new answers zero registrations.
   *
   * On a store built with {@link Options.deferRecovery}, the first report
   * first recovers every registration made before it, with one read of the
   * pending clocks and one of the completions, and counts that recovery's
   * time once; those registrations log no Debug line of their own.
   *
   * @since 1.0.0-rc.17
   */
  readonly reportRecovery: Effect.Effect<Recovery>
}>()("@smthrs/engine-store/EngineStore/Driver") {}

/**
 * Drives `executionId` once and reports what that left it as, without
 * waiting for it to settle.
 *
 * An execution the store does not hold yet is admitted with `payload` and
 * driven. One it holds is driven only if it has work due: a parked run whose
 * clock has not come due is left parked, without a replay. The drive claims
 * the run, or takes it from an earlier incarnation the host's `isAlive`
 * declares gone, replays what is recorded, and runs until the run settles or
 * parks, or, given `budgetMs`, until it yields at a step boundary (see
 * {@link DriveOptions}). A drive that stopped without any of those, such as
 * one released by an unavailable store, reports `Unfinished`. A drive of a run
 * the store holds is a resumption: it waits for its turn under
 * `Options.resumeConcurrency`.
 *
 * A drive that finds the run `Settled`, and is the last round of its lineage,
 * records the wake of every parent still waiting on it again, without
 * scheduling a wake already recorded. So an invocation that died between the
 * settlement and those records loses no parent's wake: the next drive of the
 * settled run writes them.
 *
 * `flow` must be registered with the engine. Every engine the store composes
 * provides the {@link Driver}; it is meant for a `sweep: { host }` engine,
 * whose host arms its next invocation from the result.
 *
 * @since 1.0.0
 * @category hosting
 */
export const drive = (
  flow: Flow.Any,
  options: DriveOptions
): Effect.Effect<Driven, FlowRuntime.FlowCycleDetected | RunStore.RunStoreError, Driver> =>
  Effect.gen(function*() {
    const driver = yield* Driver
    return yield* driver.drive(flow, options)
  })

/**
 * Engine-store construction options.
 *
 * @since 0.1.0
 * @category models
 */
export interface Options {
  readonly owner: {
    readonly hostId: string
  }
  readonly journalSource: string
  /**
   * The directory a declaration path is recorded relative to.
   *
   * A node record can carry where its action was declared, and the path the
   * runtime reports is absolute. A journal is read on machines that did not
   * write it, so the absolute form is at best noise and at worst an
   * operator's home directory published into a run's history: the writer
   * strips this prefix, and omits the path entirely when it cannot.
   *
   * Defaults to the process working directory where there is one. A host
   * without a filesystem identity — a worker, a browser — passes nothing and
   * records no declaration paths at all, which is the honest answer.
   */
  readonly declarationRoot?: string | undefined
  /**
   * The revision of the tree this host read its flows out of.
   *
   * A node record can carry where its action was declared, and a path with a
   * line does not say which bytes were at that line: the tree moves, and the
   * same path after an edit is a different file. A host that can name the
   * revision it loaded from declares it here, and every recorded graph page
   * carries it, so a reader can open that file AT that revision.
   *
   * Absent by default, which is the honest answer for a host served out of
   * no version control or one that cannot name a revision holding what it
   * loaded. A reader with nothing shows no code rather than code it cannot
   * bind (D-068).
   *
   * A host that only learns the answer AFTER this store is built declares a
   * reader instead of a string, and it is asked once per recorded page. The
   * native host is one: the modules whose sites these records carry are read
   * during registration, which runs after this layer, so the revision that
   * describes them is not known when the store is composed. An answer that
   * is not a non-empty string records nothing, exactly as `undefined` does.
   */
  readonly sourceRevision?: string | (() => string | undefined) | undefined
  /**
   * Liveness arbitration consulted before this store steals a run whose lease
   * has expired. Answering `true` refuses the takeover.
   *
   * Optional. The default is `Ownership.leaseLiveness(heartbeatStaleAfter)`:
   * the owner is alive while its persisted heartbeat is younger than the
   * staleness cutoff, and gone once it is not. That is the weakest honest
   * answer and the one every host can give, so a composition that supplies
   * nothing still reclaims the runs of an owner killed with SIGKILL — the
   * steal it admits carries `lease-expired` evidence, which the run store
   * verifies against the row in the same write.
   *
   * A deployment that can say more supplies its own check and refuses the
   * takeover for longer: `Ownership.sameHostIncarnation` is the guard a local
   * `process.kill(pid, 0)` probe applies before reading `owner.pid`.
   *
   * A supplied check is also asked while the lease is still fresh, about an
   * owner on this host whose pid is not this process's. Answering `false`
   * there takes the run at once with `same-host-pid-dead` evidence, so a
   * rerun after `kill -9` does not wait out the dead owner's lease.
   */
  readonly isAlive?: Ownership.LivenessCheck | undefined
  /** Host routing, checked before claiming a run (including automatic wakes). */
  readonly canExecute?: ((row: RunStore.RunRow) => Effect.Effect<boolean>) | undefined
  /**
   * Read-only host admission fence, rechecked in the native activation transaction.
   * Use captured native reads and synchronous local probes only; external I/O
   * and module loading belong in `canExecute`.
   */
  readonly canActivate?: ((row: RunStore.RunRow) => Effect.Effect<boolean>) | undefined
  /**
   * Records, for a host that keeps one, that this engine has asked a parked
   * execution to resume: a durable clock fired, a durable deferred completed,
   * or a child settled under a parent that parked on it.
   *
   * A host that refuses to re-enter a parked run nobody asked for — the
   * control plane's executor does — reads the record to tell those wakes from
   * its own heartbeat sweep. Without it a run that slept never settled.
   *
   * Optional; a composition with no such host leaves it undefined.
   *
   * @since 1.0.0-rc.0
   */
  readonly requestResume?:
    | ((executionId: string, reason: RequestedResumeReason) => Effect.Effect<void>)
    | undefined
  /**
   * Redispatch policy for a durable clock whose fire failed. Defaults to
   * {@link DeferredPersistence.defaultFireRetryPolicy} — exponential from
   * 100ms, capped at 30s, forever. Same shape as the engine's
   * `suspendedRetryPolicy` option: the built-in behavior is the default, and
   * a deployment that wants a different backoff supplies one here rather than
   * patching the store.
   */
  readonly clockFireRetryPolicy?: Schedule.Schedule<unknown, unknown> | undefined
  /**
   * Who wakes this store's runs. Defaults to `"process"`.
   *
   * `"process"` suits a long-lived process. A fiber sweeps the store every
   * `Ownership.heartbeatInterval` for runs to wake or reclaim: parked runs
   * with a cancellation or a release, due timers, admitted runs nobody
   * drove, and running rows whose owner stopped renewing its lease. Every
   * owned round renews that lease on the same cadence, and registering a flow
   * re-arms the clocks and completions of every one of its runs.
   *
   * `{ host: executionId }` suits a host that drives one execution per
   * invocation and wakes it from outside, such as a Cloudflare Durable Object
   * alarm. No sweep runs and no lease is renewed, so the engine starts no
   * background work that outlives the invocation's own drive. Registering a
   * flow re-arms only that execution's clocks and completions. The host reads
   * {@link nextWake} to arm its next invocation, and its `isAlive` check, not
   * a lease, tells a crashed incarnation from a live one. Because the lease is
   * not renewed, every other engine sharing the store must route this
   * execution away with `canExecute`, or it reclaims the run once
   * `Ownership.heartbeatStaleAfter` passes.
   *
   * @since 1.0.0
   */
  readonly sweep?: Sweep | undefined
  /**
   * How many runs the engine resumes on its own at once. Absent, the default,
   * is no bound.
   *
   * The engine resumes a run on its own when its sweep reclaims it (a run
   * released by an engine that stopped, a running row whose owner's lease
   * lapsed, an admitted run nobody drove, a timer that came due) and when a
   * host drives it through the {@link Driver}, as a browser leader does for
   * every unfinished run after a reload. Bounded, those drives take turns:
   * at most this many run at once, and the rest wait in the order they were
   * asked for. Nothing else waits for them. A run started or awaited with
   * `FlowRuntime.execute`, or woken by an event such as a signal, a child's
   * settlement or its own timer, drives at once, including a run still
   * waiting for its turn, and so does `interrupt`, whose drive then delivers
   * the cancellation.
   *
   * A host with one connection to its store, such as a browser leader, sets
   * it so a backlog of resumed runs cannot starve the run a user just
   * started. Must be a positive integer.
   *
   * @since 1.0.0
   */
  readonly resumeConcurrency?: number | undefined
  /**
   * Where this store's runs run, as their usage metrics label it:
   * `browser`, `cloudflare`, `sandbox` or `local` (`@smthrs/flow`
   * `RunMetrics.placements`). Defaults to `local`; any other value reads
   * `other`.
   *
   * @since 1.0.0-rc.17
   */
  readonly placement?: string | undefined
  /**
   * Recovers the registrations made before the host's first
   * {@link Driver.reportRecovery} together, in that report, instead of each as
   * it registers: one read of the pending clocks and one of the unconsumed
   * completions, for every flow registered by then, however many there are.
   * Every registration after that report recovers as it registers. Defaults
   * to `false`.
   *
   * A host sets it when it reports as soon as its registrations are built and
   * resumes no run before that, as `@smthrs/flows` `Runtime.layer` and the
   * native hosts' `layerHost` do. A browser engine registers about 500 flows
   * on every start, and one read per registration was 1,000 statements on its
   * one SQLite connection before its first page could render.
   *
   * @since 1.0.0
   */
  readonly deferRecovery?: boolean | undefined
}

type PublicRequirements =
  | AttemptStore.AttemptStore
  | CacheStore.CacheStore
  // DECIDED (2026-08-11, pending review): hashing is a construction-time
  // requirement of this composition rather than a per-call one.
  // The run driver derives each trampoline round's execution id from
  // (lineage, ordinal) with the injected SHA-256, on the coordinator's own
  // fiber rather than a caller's, so hashing is a construction-time
  // requirement of the composition (`packages/smithers/flows/engine/docs/api.md`).
  | Crypto.Crypto
  | DurableEngineState.DurableEngineState
  | DurableWriter
  | Journal.Journal
  | Jj.Jj
  | OwnerIdentity.OwnerIdentity
  | RunStore.RunStore
  | Scope.Scope
  | StepBoundary.Service

type Requirements = PublicRequirements | EngineJj.EngineJj

const isBoundaryMetadata = Schema.is(FileBoundary)

/**
 * What the file boundary refuses a sealed attempt with: `StepSandbox` and
 * `StepBoundary` failures for a step that broke its declaration or a host that
 * cannot honour one. None of them is a failure the action declared.
 */
const BoundaryRefusal = Schema.Union([
  StepSandbox.UndeclaredRead,
  StepBoundary.UndeclaredWrite,
  StepBoundary.MissingDeclaredOutput,
  StepBoundary.SurvivingDeclaredRemoval,
  StepBoundary.UnsupportedBoundary,
  StepBoundary.BoundaryCorruption,
  StepBoundary.MissingArtifact
])

/**
 * Matches a boundary refusal and answers its encoded tagged fields (issue
 * #4019). A live refusal is a class instance; a replayed one is the fields its
 * failed attempt row persisted, decoded first so both settle as one value.
 */
const boundaryRefusal = (error: unknown): Result.Result<unknown, unknown> => {
  const encoded = Option.orElse(
    Schema.encodeUnknownOption(BoundaryRefusal)(error),
    () =>
      Option.flatMap(Schema.decodeUnknownOption(BoundaryRefusal)(error), Schema.encodeUnknownOption(BoundaryRefusal))
  )
  return Option.isSome(encoded) ? Result.succeed(encoded.value) : Result.fail(error)
}

/** Store failures are engine outcomes, independent of an action's error codec. */
const EngineError = Schema.Union([
  ActionPersistence.CacheConflictDetected,
  ActionPersistence.CacheCorruptionDetected,
  ActionPersistence.AttemptAdmissionRejected,
  WorkspaceSandbox.MaterializationConflict,
  WorkspaceSandbox.WorkspaceError
])
/** The stores an attempt's persistence writes through. */
const StorageErrors = [
  Journal.JournalError,
  AttemptStore.AttemptStoreError,
  RunStore.RunStoreError,
  CacheStore.CacheStoreError,
  Consensus.ConsensusError
] as const

/** The codes those stores fail with when the database did not answer. */
const unavailableCodes: ReadonlySet<string> = new Set(["sink_failed", "read_failed", "persistence_failed"])

/**
 * Whether a failure out of the attempt's persistence is the store being
 * unavailable: a lost connection, an I/O error, a database that is restarting.
 * Those are failures of the engine's own writes, never the action's outcome,
 * and they are transient. Only live store failures qualify: they are class
 * instances, while an action's own failure reaches this point encoded by its
 * error schema, so a body that happens to fail with one of these types is
 * never mistaken for one.
 */
const storageUnavailable = (error: unknown): error is InstanceType<typeof StorageErrors[number]> =>
  StorageErrors.some((type) => error instanceof type) &&
  unavailableCodes.has((error as InstanceType<typeof StorageErrors[number]>).code)

const encodeEngineError = (error: unknown): Option.Option<unknown> =>
  Option.orElse(
    Schema.encodeUnknownOption(EngineError)(error),
    () => Option.flatMap(Schema.decodeUnknownOption(EngineError)(error), Schema.encodeUnknownOption(EngineError))
  )

type Instance = FlowRuntime.FlowInstance["Service"]

// Run instances bound cache lifetime; each producer has independent provenance.
type PlanProvenance = { readonly lineageId: string; readonly sourceRevision: string | undefined }
/** A plan row this run already holds: its provenance and what it says. */
type RecordedPlan = { readonly provenance: PlanProvenance; readonly payload: Readonly<Record<string, unknown>> }

/** No registration has recovered anything yet. */
const noRecovery: Recovery = { registrations: 0, durationMs: 0 }

/** The recovery a store defers to its host's first report: the flows registered so far, and how many registrations. */
interface DeferredRecovery {
  readonly flows: Set<string>
  registrations: number
}

/**
 * Opens one engine store: the services it captures at composition, the
 * in-process tables its dispatches share, its run driver, and its deferred
 * persistence.
 */
const openStore = Effect.fnUntraced(function*(options: Options) {
  const host = yield* CapabilitySet.current
  const ownerIdentity = yield* OwnerIdentity.OwnerIdentity
  const owner = yield* ownerIdentity.ownerId(options.owner.hostId)
  const attemptStore = yield* AttemptStore.AttemptStore
  const cacheStore = yield* CacheStore.CacheStore
  const journal = yield* Journal.Journal
  const actionJj = yield* Jj.Jj
  const engineJj = yield* EngineJj.EngineJj
  const runStore = yield* RunStore.RunStore
  const stepBoundary = yield* StepBoundary.StepBoundary
  /**
   * Both halves of the isolated-execution lane are OPTIONAL and resolved
   * here, at composition time, for the same reason every service above is:
   * `actionExecute` runs on the engine's fiber, which does not carry the
   * store's layer context, so anything the dispatch needs has to be captured
   * now and re-provided below. A composition without a sandbox keeps the
   * pre-existing behaviour — the body runs against the host directly — and
   * one without a dispatcher journals what a transaction queued without
   * sending it.
   */
  const workspaceSandbox = yield* Effect.serviceOption(WorkspaceSandbox.WorkspaceSandbox)
  const stepSandbox = yield* Effect.serviceOption(StepSandbox.StepSandbox)
  const effectDispatcher = yield* Effect.serviceOption(WorkspaceSandbox.EffectDispatcher)
  // Resolved at composition like the sandboxes: a verifier composes an
  // engine that replays and executes nothing (`ReplayOnly`).
  const replayOnly = Option.getOrUndefined(yield* Effect.serviceOption(ReplayOnly.ReplayOnly))
  const engineState = yield* DurableEngineState.DurableEngineState
  /**
   * Resolved like the sandbox lane above: OPTIONAL, at composition time. A
   * host that provides `WakeBus.layer` shares one bus between this engine
   * and its own wake sources; a composition given none builds a private
   * bus, which is complete for the in-process seam because every wake
   * source below (driver, deferred persistence) publishes through it.
   */
  const providedWakeBus = yield* Effect.serviceOption(WakeBus.WakeBus)
  const wakeBus = Option.getOrElse(providedWakeBus, WakeBus.makeUnsafe)

  const engine = yield* Deferred.make<FlowRuntime.FlowRuntime["Service"]>()
  const driver = yield* RunDriver.make({
    owner,
    journalSource: options.journalSource,
    isAlive: options.isAlive,
    canExecute: options.canExecute,
    canActivate: options.canActivate,
    requestResume: options.requestResume,
    engine: Deferred.await(engine),
    wakeBus,
    sweep: options.sweep,
    resumeConcurrency: options.resumeConcurrency,
    placement: options.placement
  })
  const deferredRecovery: DeferredRecovery | undefined = options.deferRecovery === true
    ? { flows: new Set<string>(), registrations: 0 }
    : undefined
  const deferred = yield* DeferredPersistence.make({
    owner,
    journalSource: options.journalSource,
    scheduleResume: (flowName, executionId, reason, sourceId) =>
      driver.scheduleResume(flowName, executionId, reason, sourceId),
    fireRetryPolicy: options.clockFireRetryPolicy
  })
  return {
    options,
    host,
    owner,
    // One admission mutex per incarnation, shared by every dispatch this
    // store drives: `ActionPersistence.make` runs per dispatch below, so a
    // per-make default would never contend and the same-key exclusion the
    // adoption evidence rests on (issues #102, #103) would silently vanish.
    admission: AttemptAdmission.makeUnsafe(),
    // Run instances own the projection's lifetime, including nested actions.
    // A resumed instance rebuilds it without retaining completed runs here.
    ageVerdicts: new WeakMap<Instance, ReturnType<typeof CacheAgeVerdicts.make>>(),
    attemptStore,
    cacheStore,
    journal,
    declarationRoot: NodeJournal.hostRoot(options.declarationRoot),
    /*
     * Stated by the host or not at all; nothing here derives a revision. A
     * reader is asked where the record is written rather than here, because a
     * host that learns its revision after this layer builds would otherwise
     * be captured before it knows the answer.
     */
    declaredRevision: options.sourceRevision,
    actionJj,
    engineJj,
    runStore,
    forkFacts: new WeakMap<Instance, ForkFacts>(),
    recordedPlans: new WeakMap<Instance, Map<string, Effect.Effect<RecordedPlan | undefined>>>(),
    /*
     * Plans a resume found recorded by an earlier build: the same plan, read
     * from other declaration sites. The first build's pages stand whole, so
     * the rebuilt pages, whose sites and layout may differ, are not appended.
     */
    recordedByEarlierBuild: new WeakMap<Instance, Set<string>>(),
    stepBoundary,
    workspaceSandbox,
    stepSandbox,
    effectDispatcher,
    replayOnly,
    engineState,
    attemptSurvivors: engineState.attemptSurvivors,
    wakeBus,
    engine,
    driver,
    // The one execution a hosted store's registration recovers, if any.
    hostedExecution: typeof options.sweep === "object" ? options.sweep.host : undefined,
    hostedFlow: typeof options.sweep === "object" ? options.sweep.flow : undefined,
    deferred,
    // What registrations recovered since the host last asked (`Driver.reportRecovery`); milliseconds unrounded.
    recovery: yield* Ref.make(noRecovery),
    // Under `deferRecovery`, until the first report: the flows registered so far, and how many registrations, whose
    // recovery that report does at once.
    deferredRecovery,
    // The budget of each execution a budgeted `drive` is driving now.
    budgets: new Map<string, DriveBudget.DriveBudget>(),
    // The instances action dispatches run their bodies under. A dispatch
    // whose parent is one is called by a running step and is part of it.
    dispatchInstances: new WeakSet<Instance>(),
    // Each round's replay seed, read on its first ask and shared with the
    // instances its dispatches run under (`internal/ReplaySeed`).
    seeds: new WeakMap<Instance, Effect.Effect<ReplaySeed.Seed>>()
  }
})

/** Everything one engine store holds; {@link openStore} builds it. */
type Store = Effect.Success<ReturnType<typeof openStore>>

/** The source revision the host states now, if it states one. */
const sourceRevision = (store: Store): string | undefined => {
  const answer = typeof store.declaredRevision === "function" ? store.declaredRevision() : store.declaredRevision
  return typeof answer === "string" && answer.length > 0 ? answer : undefined
}

/**
 * What a forked or retried run's replay reads off its row: the runs its
 * action keys may have been recorded under, and the run it retries from a
 * step, if any.
 */
interface ForkFacts {
  readonly origins: ReadonlyArray<string>
  readonly retrySource: string | undefined
}

/** An instance's fork facts, read once per instance. */
const forkFacts = Effect.fnUntraced(function*(store: Store, instance: Instance) {
  const cached = store.forkFacts.get(instance)
  if (cached !== undefined) return cached
  const row = yield* store.runStore.get(instance.executionId).pipe(Effect.orDie)
  const state = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RunState))(row.stateJson).pipe(Effect.orDie)
  const facts = { origins: state.forkKeyRunIds ?? [], retrySource: state.retryFrom?.source }
  store.forkFacts.set(instance, facts)
  return facts
})

/** The runs a forked run's action keys may have been recorded under. */
const keyOrigins = (store: Store, instance: Instance) =>
  Effect.map(forkFacts(store, instance), (facts) => facts.origins)

/**
 * The plan record `runId` holds in the slot `slot` names, whichever source wrote it. A run records one plan per
 * round, its first page in one slot, so its plan records fit one read.
 */
const sourcePlan = Effect.fnUntraced(function*(store: Store, runId: string, slot: string) {
  const page = yield* store.journal.entries({
    runId: runId as JournalEvent.RunId,
    eventTypes: ["flows.engine.plan-recorded"],
    limit: 256
  }).pipe(Effect.orDie)
  const recorded = page.entries.find((entry) => entry.sourceId.endsWith(`/${slot}`) && entry.sourceSeq === 0)
  return recorded?.payload as Readonly<Record<string, unknown>> | undefined
})

/**
 * A retry runs the plan its source ran, or nothing. Before a retry records
 * its plan, the plan is compared with the one the source recorded in the same
 * slot, by the identity a resume compares (`NodeJournal.samePlan`). A
 * different plan, or a source that recorded none, fails the round with
 * `plan_changed` before any step runs: a changed declaration derives other
 * step keys, and executing them would run steps the retry promised to replay.
 */
const guardRetryPlan = (store: Store, instance: Instance, record: FlowRuntime.PlanRecorded, plan: unknown) =>
  Effect.gen(function*() {
    const { retrySource } = yield* forkFacts(store, instance)
    if (retrySource === undefined) return
    const recorded = yield* sourcePlan(store, retrySource, record.sourceId)
    if (recorded !== undefined && NodeJournal.samePlan(recorded, plan as Readonly<Record<string, unknown>>)) return
    return yield* Effect.fail(
      new Interpreter.InterpreterError({
        code: "plan_changed",
        flow: record.flow,
        node: "root",
        message: "The plan differs from the plan the retried run recorded; retry the whole run instead"
      })
    )
  })

/** Every page of one plan shares the source id before its page index. */
const planOf = (sourceId: string) => sourceId.slice(0, sourceId.lastIndexOf("/"))

/** The plan row a run holds under `sourceId`, looked up once per instance and producer. */
const recordedPlan = Effect.fnUntraced(function*(store: Store, instance: Instance, sourceId: string) {
  let producers = store.recordedPlans.get(instance)
  if (producers === undefined) {
    producers = new Map()
    store.recordedPlans.set(instance, producers)
  }
  let lookup = producers.get(sourceId)
  if (lookup === undefined) {
    lookup = yield* Effect.cached(findRecordedPlan(store, instance, sourceId))
    producers.set(sourceId, lookup)
  }
  return yield* lookup
})

/** Pages the run's plan records for the one `sourceId` wrote. */
const findRecordedPlan = (store: Store, instance: Instance, sourceId: string) =>
  Effect.gen(function*() {
    const origins = yield* keyOrigins(store, instance)
    let after: JournalEvent.Seq | undefined
    while (true) {
      const page = yield* store.journal.entries({
        runId: instance.executionId as JournalEvent.RunId,
        eventTypes: ["flows.engine.plan-recorded"],
        limit: 256,
        ...(after === undefined ? {} : { after })
      }).pipe(Effect.orDie)
      const inherited = page.entries.find((entry) => entry.sourceId === sourceId && entry.sourceSeq === 0)
      if (inherited !== undefined) return inheritedPlan(instance, origins, inherited)
      if (!page.hasMore) return undefined
      after = page.entries[page.entries.length - 1]!.seq
    }
  })

/**
 * A recorded plan row this run may resume under: its own lineage's, or one
 * of its fork origins'.
 */
const inheritedPlan = (
  instance: Instance,
  origins: ReadonlyArray<string>,
  inherited: JournalEvent.Entry
): RecordedPlan | undefined => {
  const root = FlowEngine.Lineage.root(instance.executionId)
  const meta = Schema.decodeUnknownOption(Schema.Struct({ lineageId: Schema.String }))(inherited.meta)
  const payload = Schema.decodeUnknownOption(
    Schema.Struct({ graph: Schema.Struct({ sourceRevision: Schema.optional(Schema.String) }) })
  )(inherited.payload)
  // Legacy or malformed rows still reach content deduplication and
  // its typed plan_changed refusal, rather than dying in the decoder.
  if (Option.isNone(meta) || Option.isNone(payload)) return undefined
  const { lineageId } = meta.value
  if (
    lineageId !== root && !origins.some((origin) => FlowEngine.Lineage.root(origin) === lineageId)
  ) return undefined
  return {
    provenance: { lineageId, sourceRevision: payload.value.graph.sourceRevision },
    // The decode above proved it an object; the raw row keeps every member.
    payload: inherited.payload as Readonly<Record<string, unknown>>
  }
}

// A resumed or copied plan keeps its original source revision, even when
// coding changes the workspace.
const planProvenance = Effect.fnUntraced(function*(
  store: Store,
  instance: Instance,
  record: FlowRuntime.NodeRecord
) {
  const current = { lineageId: FlowEngine.Lineage.root(instance.executionId), sourceRevision: sourceRevision(store) }
  if (record._tag !== "PlanRecorded") return current
  // A missing row does not pin the revision of a size measurement. The
  // successful first write below replaces this cached absence.
  return (yield* recordedPlan(store, instance, `${store.options.journalSource}/${record.sourceId}`))?.provenance ??
    current
})

/*
 * The journal refused a plan record because its slot holds other bytes.
 * Only the plan's identity decides what that means (NodeJournal.planIdentity):
 * the same plan from a build whose declarations moved resumes under the
 * row already written, and anything else is a changed plan.
 */
const rebuiltPlan = (
  store: Store,
  instance: Instance,
  record: FlowRuntime.PlanRecorded,
  rebuilt: Readonly<Record<string, unknown>>
) => {
  const sourceId = `${store.options.journalSource}/${record.sourceId}`
  return Effect.flatMap(recordedPlan(store, instance, sourceId), (recorded) => {
    if (recorded === undefined || !NodeJournal.samePlan(recorded.payload, rebuilt)) {
      return Effect.fail(
        new Interpreter.InterpreterError({
          code: "plan_changed",
          flow: record.flow,
          node: "root",
          message: "The rebuilt plan differs from the recorded plan; start a new execution"
        })
      )
    }
    let plans = store.recordedByEarlierBuild.get(instance)
    if (plans === undefined) {
      plans = new Set()
      store.recordedByEarlierBuild.set(instance, plans)
    }
    plans.add(planOf(sourceId))
    return Effect.logDebug("engine-store: resuming under a plan an earlier build recorded", {
      runId: instance.executionId,
      flow: record.flow,
      sourceId
    })
  })
}

// Verification observes current code over copied history. Its plan is a
// separate producer's immutable observation, never a replacement of the
// executing producer's approved plan. ReplayOnly still refuses every new action.
const observation = (store: Store, record: FlowRuntime.NodeRecord): FlowRuntime.NodeRecord =>
  store.replayOnly === undefined ? record : { ...record, sourceId: `replay-only/${record.sourceId}` }

/** The cache-age verdicts of a parent instance's run, shared by its dispatches. */
const ageVerdictOf = (store: Store, parent: Instance): ReturnType<typeof CacheAgeVerdicts.make> => {
  let cacheAgeVerdict = store.ageVerdicts.get(parent)
  if (cacheAgeVerdict === undefined) {
    cacheAgeVerdict = CacheAgeVerdicts.make(parent.executionId)
    store.ageVerdicts.set(parent, cacheAgeVerdict)
  }
  return cacheAgeVerdict
}

const actionExecute = Effect.fn("FlowEngine.actionExecute")(
  function*(store: Store, input: FlowEngine.ActionExecuteOptions) {
    const parent = yield* FlowRuntime.FlowInstance
    const cacheAgeVerdict = ageVerdictOf(store, parent)
    yield* Effect.annotateCurrentSpan({
      runId: parent.executionId,
      action: input.action.name,
      // `stepKey`, never `key`. `@smthrs/journal`'s redaction replaces the
      // value of any field whose name is a standalone trailing `key` word,
      // and `RedactedLogger` applies that rule to every log line this
      // package emits under a real host. A field named `key` reached the
      // operator as `[REDACTED]`, destroying the one field that says which
      // dispatch the line describes. The span carries the same name so the
      // trace and the log agree.
      stepKey: input.key,
      attempt: input.attempt,
      tier: input.tier
    })
    const instance = FlowEngine.makeInstance(
      parent.flow,
      parent.executionId
    )
    store.ageVerdicts.set(instance, cacheAgeVerdict)
    store.dispatchInstances.add(instance)
    // A step's own dispatches belong to its round, and answer from its seed.
    const seeding = seedOf(store, parent)
    store.seeds.set(instance, seeding)
    const seed = yield* seeding
    const flowEngine = yield* Deferred.await(store.engine)
    instance.interrupted = parent.interrupted
    // DECIDED (2026-08-11, pending review): the waiting classification is
    // threaded through the dispatch's instance and back, because the dispatch
    // runs under an instance of its own while `annotateWaiting` is documented
    // to reach the parked row. An implementation that declares one — `Sleep`
    // under `timer`, `WaitFor` under `event` with its wake token — writes it
    // here, so without the thread-back `RunDriver` would park on the derived
    // default and an action's declaration would be inert. It is seeded as
    // well as copied back so a body that annotated before dispatching keeps
    // its own declaration, and so the consumption `deferredResult` performs
    // on a settled wait travels out the same way (issue #42).
    const waitingBefore = parent.waiting
    instance.waiting = waitingBefore
    const logContext = {
      runId: parent.executionId,
      action: input.action.name,
      stepKey: input.key,
      attempt: input.attempt,
      tier: input.tier
    }
    yield* Effect.logTrace("action dispatch started", logContext)
    // The boundary preparation runs under the dispatching parent, not the
    // action's own instance, exactly as the engine would run it itself.
    const snapshot = input.snapshot === undefined
      ? undefined
      : Effect.provideContext(input.snapshot, yield* Effect.context<FlowRuntime.FlowInstance | Crypto.Crypto>())
    const result = yield* persistAction(store, input, parent, cacheAgeVerdict, seed, snapshot, logContext).pipe(
      Flow.intoResult,
      Effect.provideService(FlowRuntime.FlowInstance, instance),
      Effect.provideService(
        FlowRuntime.FlowRuntime,
        flowEngine
      ),
      Effect.provideService(AttemptStore.AttemptStore, store.attemptStore),
      Effect.provideService(CacheStore.CacheStore, store.cacheStore),
      Effect.provideService(Journal.Journal, store.journal),
      Effect.provideService(Jj.Jj, store.actionJj),
      Effect.provideService(RunStore.RunStore, store.runStore),
      Effect.provideService(StepBoundary.StepBoundary, store.stepBoundary),
      (dispatch) =>
        Option.isNone(store.stepSandbox)
          ? dispatch
          : Effect.provideService(dispatch, StepSandbox.StepSandbox, store.stepSandbox.value),
      (dispatch) =>
        Option.isNone(store.workspaceSandbox)
          ? dispatch
          : Effect.provideService(dispatch, WorkspaceSandbox.WorkspaceSandbox, store.workspaceSandbox.value),
      (dispatch) =>
        Option.isNone(store.effectDispatcher)
          ? dispatch
          : Effect.provideService(dispatch, WorkspaceSandbox.EffectDispatcher, store.effectDispatcher.value),
      Effect.ensuring(Effect.sync(() => {
        if (parent.waiting === waitingBefore) parent.waiting = instance.waiting
      }))
    )
    const outcome = result._tag === "Complete"
      ? result.exit._tag === "Success" ? "success" : "failure"
      : result._tag.toLowerCase()
    yield* Effect.annotateCurrentSpan({ outcome })
    yield* Effect.logTrace("action dispatch settled", { ...logContext, outcome })
    return result
  }
)

/**
 * Persists one action dispatch through `ActionPersistence`, keeping the
 * engine's own refusals and a lost store off the action's error channel.
 */
const persistAction = (
  store: Store,
  input: FlowEngine.ActionExecuteOptions,
  parent: Instance,
  cacheAgeVerdict: ReturnType<typeof CacheAgeVerdicts.make>,
  seed: ReplaySeed.Seed,
  snapshot: ActionPersistence.ActionInput["snapshot"],
  logContext: Readonly<Record<string, unknown>>
) =>
  ActionPersistence.make({
    runId: parent.executionId,
    owner: store.owner,
    sourceId: store.options.journalSource,
    isAlive: store.options.isAlive,
    engineJj: store.engineJj,
    execute: (actionInput) => (actionInput.action as Action.Any).executeEncoded as Effect.Effect<unknown, unknown>,
    idempotencyKey: input.action.idempotencyKey === undefined
      ? undefined
      : input.key,
    admission: store.admission,
    cacheAgeVerdict,
    recorded: (id) => seed.take(id.stepKeyDigest, id.attempt),
    replayOnly: store.replayOnly,
    // A step a budgeted drive starts; an action a running step calls is part
    // of that step and never waits on the budget.
    step: store.dispatchInstances.has(parent) ? undefined : store.budgets.get(parent.executionId)?.step
  })({
    action: input.action,
    attempt: input.attempt,
    key: input.key,
    tier: input.tier,
    ...(input.nondeterministic === undefined ? {} : { nondeterministic: input.nondeterministic }),
    ...(isBoundaryMetadata(input.metadata)
      ? { metadata: input.metadata }
      : {}),
    ...(snapshot === undefined ? {} : { snapshot })
  }).pipe(
    // This is an engine safety refusal, not a failure declared by the
    // action. Keep it on the defect channel like the numbered-retry
    // guard in FlowEngine, before the action's error codec can mask it.
    Effect.catchIf(
      (cause): cause is Action.IrreversibleRetryRequiresIdempotencyKey =>
        cause instanceof Action.IrreversibleRetryRequiresIdempotencyKey,
      // Encode the tagged fields before the generic defect codec reduces
      // an Error instance to just its name and message.
      (cause) => Effect.die(Schema.encodeSync(Action.IrreversibleRetryRequiresIdempotencyKey)(cause))
    ),
    // A boundary refusal is the engine's verdict on the step, not the
    // action's error, so it takes the same defect channel. Decoded through
    // the action's error schema it became "SchemaError: Expected never"
    // and lost the refused paths.
    Effect.catchFilter(boundaryRefusal, Effect.die),
    // The store went away while this attempt was admitted, run or
    // recorded. Its outcome is not the action's: whatever did not commit
    // left the attempt row running, so the dispatch interrupts itself, as
    // it does on a lost fence, and the run is released for a later drive
    // that adopts the attempt and records its result.
    Effect.catchIf(storageUnavailable, (error) =>
      Effect.annotateCurrentSpan({ outcome: "storage_unavailable" }).pipe(
        Effect.andThen(Effect.logWarning("action attempt interrupted: the engine store is unavailable")),
        Effect.annotateLogs({ ...logContext, error: error._tag, code: error.code }),
        Effect.andThen(Metric.update(EngineStoreMetrics.storageUnavailable, 1)),
        Effect.andThen(Effect.interrupt)
      ))
  )

/**
 * The graph a walk drove, and how each of its nodes settled.
 *
 * Addressed by the record's own `sourceId` rather than a minted one, so
 * a resumed walk writes the identities the first walk used and the
 * journal's `(run, source, sequence)` uniqueness holds one row per node
 * instead of one per observation. A `Duplicate` receipt is that
 * collapse happening, and it is the expected answer on a resume.
 *
 * A plan record is the exception to byte equality: a resume compares it
 * by identity, without declaration sites or page layout, so a rebuilt
 * bundle resumes and a changed plan fails with `plan_changed`.
 *
 * On the durable, owner-fenced channel, like every other engine record:
 * a writer that lost the run self-interrupts rather than narrating a
 * walk it no longer owns.
 */
const recordNode = (store: Store, input: FlowRuntime.NodeRecord, flush: boolean) => {
  const record = observation(store, input)
  return Effect.flatMap(FlowRuntime.FlowInstance, (parent) => {
    if (
      record._tag === "SubgraphAppended" &&
      store.recordedByEarlierBuild.get(parent)?.has(planOf(`${store.options.journalSource}/${record.sourceId}`))
    ) {
      return Effect.void
    }
    // The walk's first record reads the round's seed, so the journal knows
    // the run's entries before the records a resumed walk re-emits arrive.
    return seedOf(store, parent).pipe(
      Effect.andThen(planProvenance(store, parent, record)),
      Effect.tap((provenance) =>
        record._tag === "PlanRecorded"
          ? guardRetryPlan(store, parent, record, nodeEntry(store, parent, record, provenance).payload)
          : Effect.void
      ),
      Effect.flatMap((provenance) => emitNode(store, parent, record, provenance, flush))
    )
  })
}

/** The journal entry a node record is written as. */
const nodeEntry = (store: Store, parent: Instance, record: FlowRuntime.NodeRecord, provenance: PlanProvenance) =>
  NodeJournal.entry({
    runId: parent.executionId,
    sourceId: store.options.journalSource,
    ...provenance,
    root: store.declarationRoot
  }, record)

/** Writes one node record, remembering a plan it records and resolving a plan its slot refuses. */
const emitNode = (
  store: Store,
  parent: Instance,
  record: FlowRuntime.NodeRecord,
  provenance: PlanProvenance,
  flush: boolean
) => {
  const entry = nodeEntry(store, parent, record, provenance)
  // Every node record is built as an object, so its payload is one.
  const payload = entry.payload as Readonly<Record<string, unknown>>
  // Interpreter records commit with the run's next write. A caller reporting
  // progress from inside a long-running action can explicitly flush now;
  // its enclosing action may leave no later write to publish that progress.
  // A plan's pages commit at once: `findRecordedPlan` reads them back, and
  // a conflicting plan is rebuilt below.
  //
  // A resumed walk writes the records its first walk wrote. One the journal
  // already holds is not written again: `emitDeferred` drops it, and a plan
  // the journal holds byte for byte is not re-emitted. It narrates nothing
  // new, so it needs no fenced write; the walk's next step that runs is
  // fenced as ever.
  const deferred = !flush && (record._tag === "NodeScheduled" || record._tag === "NodeSettled")
    ? store.journal.emitDeferred
    : undefined
  const write = deferred === undefined
    ? Effect.flatMap(
      store.journal.recorded?.(entry) ?? Effect.succeed(false),
      (held) => held ? Effect.void : Effect.asVoid(store.journal.emitDurable(entry, store.owner))
    )
    : deferred(entry, store.owner)
  return write.pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        if (record._tag === "PlanRecorded") {
          store.recordedPlans.get(parent)?.set(
            `${store.options.journalSource}/${record.sourceId}`,
            Effect.succeed({ provenance, payload })
          )
        }
      })
    ),
    Effect.catch((error) =>
      error.code === "fence_lost" ?
        Effect.interrupt :
        error.code === "idempotency_conflict" && record._tag === "PlanRecorded"
        ? rebuiltPlan(store, parent, record, payload)
        : Effect.die(error)
    ),
    Effect.asVoid
  )
}

/**
 * The key an action replays under. A record an earlier engine wrote under an
 * older key encoding is this dispatch's own, so an ordinary run replays it
 * there. A forked run prefers this child's own work on resume, then only
 * ancestor keys backed by attempts copied into this child, under every
 * encoding. Never read parent rows.
 */
const actionReplayKey = Effect.fnUntraced(function*(
  store: Store,
  derive: Parameters<NonNullable<FlowEngine.Encoded["actionReplayKey"]>>[0],
  legacy: Parameters<NonNullable<FlowEngine.Encoded["actionReplayKey"]>>[1]
) {
  const instance = yield* FlowRuntime.FlowInstance
  const origins = yield* keyOrigins(store, instance)
  if (origins.length === 0) {
    // Only a keyed sealed action's key differs between encodings, so every
    // other dispatch probes nothing here.
    for (const key of yield* legacy(instance.executionId, false)) {
      if (yield* hasAttempts(store, instance, key)) return key
    }
    return yield* derive(instance.executionId, false)
  }
  const probed = new Set<string>()
  for (const runId of [instance.executionId, ...origins]) {
    for (const runScoped of [true, false]) {
      for (const key of [yield* derive(runId, runScoped), ...yield* legacy(runId, runScoped)]) {
        if (probed.has(key)) continue
        probed.add(key)
        if (yield* hasAttempts(store, instance, key)) return key
      }
    }
  }
  return yield* derive(instance.executionId, true)
})

/** Whether this run holds attempts, its own or copied, under `key`. */
const hasAttempts = (store: Store, instance: Instance, key: string) =>
  Effect.gen(function*() {
    const digest = yield* Schema.decodeUnknownEffect(Sha256)(key).pipe(Effect.orDie)
    return Option.isSome(yield* probe(store, instance, digest))
  })

/** The surviving attempts of the dispatching run under `key`. */
const survivingAttempts = (store: Store, key: string) =>
  Effect.gen(function*() {
    const parent = yield* FlowRuntime.FlowInstance
    return yield* probe(store, parent, yield* Schema.decodeUnknownEffect(Sha256)(key).pipe(Effect.orDie))
  })

/**
 * The surviving attempts of `instance`'s run under `stepKeyDigest`: from the
 * round's replay seed while it holds the key, else from the store.
 */
const probe = (store: Store, instance: Instance, stepKeyDigest: string) =>
  Effect.flatMap(seedOf(store, instance), (seed) => {
    const seeded = seed.survivors(stepKeyDigest)
    return seeded !== undefined ? Effect.succeed(seeded) : AttemptProbe.probeAttempts(
      store.attemptStore,
      store.attemptSurvivors,
      instance.executionId,
      stepKeyDigest
    )
  })

/**
 * The replay seed of `instance`'s round, read on the round's first ask: the
 * first record its walk journals or the first step it dispatches.
 */
const seedOf = (store: Store, instance: Instance): Effect.Effect<ReplaySeed.Seed> => {
  let seed = store.seeds.get(instance)
  if (seed === undefined) {
    seed = ReplaySeed.once(readSeed(store, instance.executionId))
    store.seeds.set(instance, seed)
  }
  return seed
}

/**
 * Reads a round's seed: the run's attempt rows and, into the journal, its
 * entries, in one read transaction. A store that cannot read them at once
 * gives a seed that sends every question to the store, as does a read that
 * fails, which is logged: the steps then read what they need themselves.
 */
const readSeed = (store: Store, runId: string): Effect.Effect<ReplaySeed.Seed> =>
  store.engineState.readTransaction(
    Effect.all([
      store.attemptStore.listRun?.(runId) ?? Effect.succeed(undefined),
      store.journal.recall?.(runId as JournalEvent.RunId) ?? Effect.void
    ])
  ).pipe(
    Effect.map(([rows]) => ReplaySeed.make(rows)),
    Effect.tap((seed) =>
      Effect.andThen(
        Effect.annotateCurrentSpan({ runId, attempts: seed.size }),
        Metric.update(EngineStoreMetrics.replaySeeds, 1)
      )
    ),
    Effect.catch((error) =>
      Effect.logWarning("replay seed unavailable; the run's steps read the store").pipe(
        Effect.annotateLogs({ runId, error: error._tag, code: error.code }),
        Effect.as(ReplaySeed.make(undefined))
      )
    ),
    Effect.withSpan("EngineStore.replaySeed")
  )

/**
 * What one registration recovers: its flow's clocks and completions, swept now, or, while the store defers recovery
 * (`Options.deferRecovery`), listed for the host's first report to sweep with every other.
 */
const recoverRegistration = (store: Store, flow: Flow.Any): Effect.Effect<void> =>
  Effect.suspend(() => {
    const deferred = store.deferredRecovery
    if (deferred !== undefined) {
      deferred.flows.add(flow._tag)
      deferred.registrations++
      return Effect.void
    }
    return store.deferred.sweepDue(flow._tag, store.hostedExecution).pipe(
      Effect.timed,
      // At Debug: a catalog registers hundreds of flows per start, and the host reports their sum at Info.
      Effect.flatMap(([elapsed]) => {
        const durationMs = Duration.toMillis(elapsed)
        return Ref.update(store.recovery, (recovered) => ({
          registrations: recovered.registrations + 1,
          durationMs: recovered.durationMs + durationMs
        })).pipe(
          Effect.andThen(Effect.logDebug("engine-store.registration.flow.recovered")),
          Effect.annotateLogs({ "smithers.flow": flow._tag, durationMs: Math.round(durationMs) })
        )
      })
    )
  })

/**
 * The recovery the store deferred (`Options.deferRecovery`), done once: every flow registered so far swept together,
 * counted as the registrations it covers. Later registrations recover as they register.
 */
const recoverDeferred = (store: Store): Effect.Effect<void> =>
  Effect.suspend(() => {
    const deferred = store.deferredRecovery
    store.deferredRecovery = undefined
    if (deferred === undefined || deferred.registrations === 0) return Effect.void
    return store.deferred.sweepFlows(deferred.flows, store.hostedExecution).pipe(
      Effect.timed,
      Effect.flatMap(([elapsed]) =>
        Ref.update(store.recovery, (recovered) => ({
          registrations: recovered.registrations + deferred.registrations,
          durationMs: recovered.durationMs + Duration.toMillis(elapsed)
        }))
      )
    )
  })

/**
 * The engine operations this store answers: the run driver's, deferred
 * persistence's, and the action and node records it writes itself.
 */
const adapter = (store: Store): FlowEngine.Encoded => ({
  encodeEngineError,

  // Unspanned here: `driver.register` already opens the
  // `FlowEngine.register` span, and a second identical wrapper would nest
  // two same-name spans around one operation.
  register: (flow, execute) =>
    store.driver.register(flow, execute).pipe(
      Effect.tap(() =>
        store.hostedFlow !== undefined && store.hostedFlow !== flow._tag
          ? Effect.void
          : recoverRegistration(store, flow)
      )
    ),
  execute: store.driver.execute,
  retryFrom: store.driver.retryFrom,
  poll: store.driver.poll,
  interrupt: store.driver.interrupt,
  // The driver's refusal, forwarded rather than re-implemented: the
  // durable engine has one cancellation path, so `interruptUnsafe` fails
  // with `unsafe_interrupt_unsupported` here too (the release policy).
  interruptUnsafe: store.driver.interruptUnsafe,
  resume: store.driver.resume,
  actionExecute: (input) => actionExecute(store, input),
  nodeRecordBytes: (input) => {
    const record = observation(store, input)
    return Effect.flatMap(
      FlowRuntime.FlowInstance,
      (parent) =>
        Effect.map(planProvenance(store, parent, record), (provenance) =>
          NodeJournal.encodedBytes({
            runId: parent.executionId,
            sourceId: store.options.journalSource,
            ...provenance,
            root: store.declarationRoot
          }, record))
    )
  },
  recordNode: (input, options) => recordNode(store, input, options?.flush === true),
  actionReplayKey: (derive, legacy) => actionReplayKey(store, derive, legacy),
  // The durable schedule-to-close origin (issue #45): the first
  // attempt's persisted `startedAtMs` for the action key. It lives in
  // the same `flows_attempts` rows that already restore the attempt
  // sequence across park/resume and process death, so the engine's
  // `expirationMs` budget is measured from the true first attempt
  // instead of restarting on every process.
  actionRetryOrigin: (input: { readonly key: string }) =>
    Effect.map(
      survivingAttempts(store, input.key),
      (survivors) => Option.map(survivors, ({ earliestStartedAtMs }) => earliestStartedAtMs)
    ),
  // The durable attempt counter (issue #59): the highest contiguous
  // persisted attempt for the key, so a resumed run replays failed
  // attempts under their original numbers instead of restarting at 1 —
  // the persisted failure is rethrown by `ActionPersistence`, the
  // retry decision sees the true attempt count, and the backoff ladder
  // is not re-slept.
  actionLatestAttempt: (input: { readonly key: string }) =>
    Effect.map(survivingAttempts(store, input.key), (survivors) => Option.map(survivors, ({ latest }) => latest)),
  // The durable restore-before-retry handle (issue #1805): the earliest
  // boundary snapshot persisted in the key's surviving attempt rows, so a
  // restarted process restores the original pre-image before a retry.
  actionSnapshot: (input: { readonly key: string }) => actionSnapshot(store, input.key),
  deferredResult: store.deferred.deferredResult,
  deferredDone: store.deferred.deferredDone,
  deferredDoneIfWaiting: store.deferred.deferredDoneIfWaiting,
  scheduleClock: store.deferred.scheduleClock,
  // The engine races this against its suspension backoff sleep, so an
  // IN-PROCESS wake — deferred completed, clock fired, operator resume,
  // run settled — resumes the waiting caller immediately, with the
  // polling schedule as the bounded fallback. The bus is edge-triggered
  // and miss-tolerant (`WakeBus.ts`); a wake published before the caller
  // re-subscribes only costs one poll interval. Cross-process wakes ride
  // the polling schedule and the heartbeat sweeps: the bus is in-process,
  // and the journal offers no committed cross-process subscription.
  resumeSignal: (_flow, executionId) => store.wakeBus.awaitWake(executionId)
})

/** The earliest boundary snapshot the dispatching run's surviving attempts under `key` persisted. */
const actionSnapshot = Effect.fnUntraced(function*(store: Store, key: string) {
  const parent = yield* FlowRuntime.FlowInstance
  const stepKeyDigest = yield* Schema.decodeUnknownEffect(Sha256)(key).pipe(Effect.orDie)
  const survivors = yield* probe(store, parent, stepKeyDigest)
  if (Option.isNone(survivors)) {
    return Option.none()
  }
  return yield* ActionPersistence.earliestBoundarySnapshot(store.attemptStore, parent.executionId, stepKeyDigest, {
    earliest: survivors.value.earliestAttempt,
    latest: survivors.value.latest
  })
})

/**
 * What the store says the execution is now, for its host, and when the drive
 * may drive it again itself: the wake of a run parked by its own flow, with
 * no claim or owner on it, which a run left unfinished for any other reason
 * (released by an interrupted drive, claimed elsewhere, cancelled) never has.
 */
const driven = (store: Store, executionId: string) =>
  Effect.gen(function*() {
    const row = yield* store.runStore.get(executionId)
    if (RunStore.isTerminalRunStatus(row.status)) {
      return { left: { _tag: "Settled", status: row.status } as Driven, row, wakeAtMs: undefined }
    }
    const wake = yield* nextWake(executionId).pipe(
      Effect.provideService(RunStore.RunStore, store.runStore),
      Effect.provideService(DurableEngineState.DurableEngineState, store.engineState)
    )
    const nowMs = Math.floor(yield* Clock.currentTimeMillis)
    // Parked by its own flow: suspended with nothing holding it, waiting for what the flow parked on, not released by a
    // drive that was interrupted (a lost fence, an unavailable store), which its host drives again only after a backoff.
    const parked = row.status === "suspended" && row.claim === null && row.owner === null &&
      row.cancelRequestedAtMs === null &&
      Option.exists(yield* store.engineState.waiting(executionId), (waiting) => waiting.reason !== "released")
    const left: Driven = Option.isSome(wake) && wake.value <= nowMs
      ? { _tag: "Unfinished" }
      : { _tag: "Parked", wakeAtMs: Option.getOrUndefined(wake) }
    return { left, row, wakeAtMs: parked ? Option.getOrUndefined(wake) : undefined }
  })

/** Why a drive left work due: the run as the store holds it now, never its state or payload. */
const logUnfinished = (row: RunStore.RunRow) =>
  Effect.logWarning("engine-store.drive.unfinished").pipe(Effect.annotateLogs({
    "smithers.execution.id": row.runId,
    status: row.status,
    claimed: row.claim !== null,
    owned: row.owner !== null,
    cancelRequested: row.cancelRequestedAtMs !== null
  }))

/**
 * Runs `round` under `budget`: once the budget is spent and no step is
 * running, ends the round and releases the run as `yielded`. Answers whether
 * it did; a round that settles or parks first is left to end by itself.
 */
const withinBudget = <A, E>(
  store: Store,
  executionId: string,
  budget: DriveBudget.DriveBudget,
  round: Effect.Effect<A, E>
): Effect.Effect<{ readonly exit: Exit.Exit<A, E>; readonly yielded: boolean }> =>
  Effect.acquireUseRelease(
    Effect.sync(() => store.budgets.set(executionId, budget)),
    () =>
      Effect.suspend(() => {
        let yielded = false
        // The release completes the round with an interruption, so the round
        // ends after it either way; `yielded` says which ending this was.
        const yieldAtBudget = budget.spent.pipe(
          Effect.andThen(Effect.sync(() => {
            yielded = true
          })),
          Effect.andThen(store.driver.yieldDrive(executionId)),
          Effect.andThen(Effect.never)
        )
        return Effect.raceFirst(Effect.exit(round), yieldAtBudget).pipe(
          Effect.map((exit) => ({ exit, yielded }))
        )
      }),
    () => Effect.sync(() => store.budgets.delete(executionId))
  )

/** The store's host-facing driver: one drive of one execution, and what it left. */
const hostDriver = (store: Store) =>
  Driver.of({
    admit: (flow, input) => store.driver.admit(flow, input).pipe(CapabilitySet.attenuateGroups(store.host.groups)),
    // Compared under the host ceiling, as every call of the typed service is.
    drive: Effect.fn("EngineStore.drive")(function*(flow, input) {
      yield* Effect.annotateCurrentSpan({ executionId: input.executionId, flow: flow._tag })
      const admitted = yield* store.runStore.get(input.executionId).pipe(
        Effect.as(true),
        Effect.catchIf((error) => error.code === "not_found_row", () => Effect.succeed(false))
      )
      const resumed = store.driver.resumeHosted(flow, input.executionId)
      let round = admitted
        ? resumed
        : store.driver.execute(flow, { executionId: input.executionId, payload: input.payload, discard: false })
      const startedMs = yield* Clock.currentTimeMillis
      const deadlineMs = input.budgetMs === undefined ? undefined : startedMs + input.budgetMs
      const holdMs = input.holdMs ?? defaultHoldMs
      let left: Driven
      let yielded: boolean
      for (let held = 0;; held++) {
        // A drive that ends on a lost fence, an unavailable store or a spent
        // budget interrupts itself and releases the run; the store, read below,
        // says what is left. Any other failure is the caller's.
        const drove = deadlineMs === undefined
          ? { exit: yield* Effect.exit(round), yielded: false }
          : yield* withinBudget(store, input.executionId, DriveBudget.make(deadlineMs), round)
        if (Exit.isFailure(drove.exit) && !Cause.hasInterruptsOnly(drove.exit.cause)) {
          return yield* Effect.failCause(drove.exit.cause)
        }
        const now = yield* driven(store, input.executionId)
        left = now.left
        yielded = drove.yielded
        const nowMs = yield* Clock.currentTimeMillis
        // A run its own flow parked on a wake due within `holdMs`, and before the budget's end, is driven again here.
        const holding = !yielded && now.wakeAtMs !== undefined && now.wakeAtMs - nowMs <= holdMs &&
          (deadlineMs === undefined || now.wakeAtMs < deadlineMs) && held < maxHeldDrives
        if (!holding) {
          if (left._tag === "Unfinished" && !yielded) yield* logUnfinished(now.row)
          break
        }
        yield* Effect.sleep(Math.max(0, now.wakeAtMs! - nowMs))
        yield* Metric.update(EngineStoreMetrics.heldDrives, 1)
        round = resumed
      }
      const outcome: Driven = yielded && left._tag === "Unfinished" ? { _tag: "Yielded" } : left
      if (outcome._tag === "Settled") yield* store.driver.reannounce(input.executionId)
      if (outcome._tag === "Yielded") {
        yield* Metric.update(EngineStoreMetrics.driveYields, 1)
        yield* Effect.logInfo("engine-store: drive yielded its budget at a step boundary", {
          executionId: input.executionId,
          budgetMs: input.budgetMs,
          elapsedMs: (yield* Clock.currentTimeMillis) - startedMs
        })
      }
      yield* Effect.annotateCurrentSpan({ outcome: outcome._tag })
      return outcome
    }, CapabilitySet.attenuateGroups(store.host.groups)),
    reportRecovery: Effect.gen(function*() {
      yield* recoverDeferred(store)
      const recovered = yield* Ref.getAndSet(store.recovery, noRecovery)
      const report: Recovery = {
        registrations: recovered.registrations,
        durationMs: Math.round(recovered.durationMs)
      }
      yield* Effect.logInfo("engine-store.registration.recovered").pipe(Effect.annotateLogs({ ...report }))
      return report
    })
  })

/**
 * Constructs the production encoded composition.
 *
 * Registrations and active fibers are scoped in memory. Run identity, encoded
 * payload, results, deferred completions, clocks, actions, and ownership
 * are persisted by the supplied layers. Supply the same DurableWriter used
 * by the journal and run store so cancellation can retain complete failures.
 * The capability ceiling current at construction is the engine's host
 * ceiling: every run it admits records it, and every join, poll, and resume
 * is compared under it, whichever context later calls the service.
 *
 * @since 0.1.0
 * @category constructors
 */
const makeWithEngineJj = (
  options: Options
): Effect.Effect<
  { readonly runtime: FlowRuntime.FlowRuntime["Service"]; readonly driver: Driver["Service"] },
  never,
  Requirements
> =>
  Effect.gen(function*() {
    const store = yield* openStore(options)
    const service = {
      ...FlowEngine.bindHostCeiling(store.host, FlowEngine.makeUnsafe(adapter(store))),
      durability: "durable" as const
    }
    yield* Deferred.succeed(store.engine, service)
    return { runtime: service, driver: hostDriver(store) }
  })

/**
 * Constructs the production encoded composition using the ambient `Jj` for
 * both public action access and private engine bookkeeping.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (
  options: Options
): Effect.Effect<FlowRuntime.FlowRuntime["Service"], never, PublicRequirements> =>
  Effect.gen(function*() {
    const jj = yield* Jj.Jj
    return (yield* makeWithEngineJj(options).pipe(
      Effect.provideService(EngineJj.EngineJj, jj)
    )).runtime
  })

/**
 * Provides the durable flow engine.
 *
 * @since 0.1.0
 * @category layers
 */
const layerBase = (
  options: Options
): Layer.Layer<
  FlowEngine.SnapshotBoundary | FlowRuntime.FlowRuntime | Driver,
  never,
  Requirements
> => {
  const snapshotBoundary = Layer.effect(
    FlowEngine.SnapshotBoundary,
    Effect.map(EngineJj.EngineJj, (jj) =>
      FlowEngine.SnapshotBoundary.of({
        snapshot: Effect.fn("SnapshotBoundary.snapshot")(({ key, attempt }) =>
          Effect.annotateCurrentSpan({ stepKey: key, attempt }).pipe(
            Effect.andThen(jj.snapshot(`smithers action ${key} attempt ${attempt}`)),
            Effect.orDie,
            // The commit id, never the change id: an agent's `jj squash` in the
            // step rewrites the change, and a change id would then name the
            // step's edits instead of the pre-image.
            Effect.map((snapshot) => snapshot.commitId)
          )
        ),
        restore: Effect.fn("SnapshotBoundary.restore")((snapshot) =>
          Effect.annotateCurrentSpan({ snapshot: String(snapshot) }).pipe(
            Effect.andThen(jj.restore(snapshot as never)),
            Effect.orDie
          )
        ),
        diff: Effect.fn("SnapshotBoundary.diff")((snapshot, { key, attempt }) =>
          Effect.annotateCurrentSpan({ stepKey: key, attempt }).pipe(
            Effect.andThen(jj.snapshot(`smithers action ${key} attempt ${attempt} settled`)),
            Effect.orDie,
            Effect.flatMap((current) => jj.diff(snapshot as never, current.commitId).pipe(Effect.orDie))
          )
        )
      }))
  )
  return Layer.merge(
    Layer.effectContext(Effect.map(
      makeWithEngineJj(options),
      ({ driver, runtime }) => Context.make(FlowRuntime.FlowRuntime, runtime).pipe(Context.add(Driver, driver))
    )),
    snapshotBoundary
  )
}

/**
 * Provides the durable engine using the ambient `Jj` for both action and
 * engine contexts. Host compositions that guard action access should use
 * {@link layerWithPrivilegedJj} instead.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (
  options: Options
): Layer.Layer<FlowEngine.SnapshotBoundary | FlowRuntime.FlowRuntime | Driver, never, PublicRequirements> =>
  layerBase(options).pipe(Layer.provide(EngineJj.layerFromJj))

/**
 * Provides the durable engine with a private repository implementation for
 * engine bookkeeping while retaining ambient `Jj` for action bodies.
 *
 * @since 1.0.0
 * @category layers
 */
export const layerWithPrivilegedJj = <E, R>(
  options: Options,
  privilegedJj: Layer.Layer<Jj.Jj, E, R>
): Layer.Layer<
  FlowEngine.SnapshotBoundary | FlowRuntime.FlowRuntime | Driver,
  E,
  PublicRequirements | R
> =>
  layerBase(options).pipe(
    Layer.provide(EngineJj.layerFromJj.pipe(Layer.provide(privilegedJj)))
  )

/**
 * When the host of a `sweep: { host }` store must next drive `executionId`, in
 * epoch milliseconds.
 *
 * A hosted store runs no sweep, so nothing wakes a parked execution unless its
 * host arms the next invocation for this instant:
 *
 * - `Option.none()`: nothing will wake the execution by itself. It settled, it
 *   does not exist, it is quarantined until an operator resumes it, or it is
 *   parked on an external event whose completion has not arrived. The writer
 *   of that completion reports it through `requestResume`.
 * - `Option.some(at)` with `at` at or before now: there is work now. A
 *   completion or a clock is due and not yet consumed, a cancellation was
 *   requested, the run was released by an interrupted drive, or it was
 *   admitted and never driven.
 * - `Option.some(at)` later than now: the earliest pending `DurableClock` of a
 *   parked execution, or the instant another owner's claim or lease lapses,
 *   when another owner holds the run.
 *
 * @since 1.0.0
 * @category hosting
 */
export const nextWake = Effect.fn("EngineStore.nextWake")(function*(executionId: string) {
  const runs = yield* RunStore.RunStore
  const state = yield* DurableEngineState.DurableEngineState
  const nowMs = Math.floor(yield* Clock.currentTimeMillis)
  const staleAfterMs = Duration.toMillis(Ownership.heartbeatStaleAfter)
  const row = yield* runs.get(executionId).pipe(
    Effect.map(Option.some),
    Effect.catchIf((error) => error.code === "not_found_row", () => Effect.succeedNone)
  )
  if (Option.isNone(row) || RunStore.isTerminalRunStatus(row.value.status)) return Option.none<number>()
  const run = row.value
  // A claim another owner holds is taken only once it is stale.
  if (run.claimedAtMs !== null) return Option.some(Math.max(nowMs, run.claimedAtMs + staleAfterMs))
  if (run.status === "running") return Option.some(Math.max(nowMs, run.heartbeatAtMs! + staleAfterMs))
  if (run.status === "pending" || run.cancelRequestedAtMs !== null) return Option.some(nowMs)
  const waiting = yield* state.waiting(executionId)
  if (Option.isSome(waiting) && waiting.value.reason === "quarantine") return Option.none<number>()
  if (Option.isSome(waiting) && waiting.value.reason === "released") return Option.some(nowMs)
  if (yield* state.hasDueWake(executionId, nowMs)) return Option.some(nowMs)
  const clocks = yield* state.pendingClocks({ executionId })
  return clocks.length === 0 ? Option.none<number>() : Option.some(clocks[0]!.dueAtMs)
})
