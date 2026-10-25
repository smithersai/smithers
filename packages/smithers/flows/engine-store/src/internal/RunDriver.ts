/**
 * Claim-gated durable flow run lifecycle.
 *
 * @since 0.1.0
 */

import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { DatabaseError, DurableWriter } from "@smthrs/database/DurableWriter"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime, Interpreter, RunMetrics } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import type * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as DurableEngineState from "../DurableEngineState.ts"
import * as EngineStoreMetrics from "../EngineStoreMetrics.ts"
import { EventTypes } from "../EventTypes.ts"
import * as ExecutionFacts from "../ExecutionFacts.ts"
import { type OnParentExit, type ReleaseCause, RunState } from "../RunState.ts"
import * as WakeBus from "../WakeBus.ts"
import * as ActionPersistence from "./ActionPersistence.ts"
import * as EffectRecords from "./EffectRecords.ts"
import * as ExitEncoding from "./ExitEncoding.ts"
import * as JournalRecords from "./JournalRecords.ts"
import * as RetrySource from "./RetrySource.ts"
import * as RunCoordinator from "./RunCoordinator.ts"
import * as RunLifecycle from "./RunLifecycle.ts"
import * as StateTransaction from "./StateTransaction.ts"

const RunStateJson = Schema.fromJsonString(RunState)

/**
 * Re-channels every typed reason of a cause as a defect, identity intact.
 *
 * A boundary whose declared error type cannot describe what happened has two
 * honest options: widen the type, or stop calling the failure typed. Casting
 * the cause is the third, dishonest one — it left a raw `DatabaseError`
 * escaping an `Effect<void, CancelRequestFailed>`. Demotion keeps the error
 * object, every other reason and every interruption, and no caller can
 * mistake the result for a failure its handler declared.
 */
const asDefects = <E>(cause: Cause.Cause<E>): Cause.Cause<never> =>
  Cause.fromReasons(
    cause.reasons.map((reason) =>
      Cause.isFailReason(reason)
        ? Cause.makeDieReason(reason.error).annotate(Cause.reasonAnnotations(reason))
        : reason
    )
  )

/**
 * Raised when a flow (directly or through mutual ancestry) attempts to
 * execute an execution id that already appears in its own persisted
 * `parentExecutionId` chain.
 *
 * Detection walks the already-persisted parent chain from the requesting
 * parent upward — an O(depth) check, not a dependency-graph DFS — because
 * `parentExecutionId` is the only edge our runtime model can express.
 *
 * The class is declared by `@smthrs/flow` (it is part of the `execute`
 * contract) and re-exported here for the detector's callers.
 *
 * @since 0.1.0
 * @category errors
 */
export const FlowCycleDetected = FlowRuntime.FlowCycleDetected

/**
 * The value form of {@link FlowCycleDetected}.
 *
 * @since 0.1.0
 * @category errors
 */
export type FlowCycleDetected = FlowRuntime.FlowCycleDetected

/**
 * Why the engine itself asked a parked execution to resume.
 *
 * The operator's own resume is absent on purpose: it is the one wake a host
 * has already claimed before the engine hears about it.
 *
 * @since 0.1.0
 * @category models
 */
export type RequestedResumeReason = "deferred" | "clock" | "parent"

/**
 * Why a wake is scheduled for an execution.
 *
 * Only `operator` is recovery consent for a quarantine park. `delegated` is a
 * host taking up a control delegation it has already claimed, so, like
 * `operator`, it is not recorded back to the host as a request.
 *
 * @since 1.0.0
 * @category models
 */
export type ScheduledResumeReason = RequestedResumeReason | "operator" | "delegated"

/**
 * Who wakes the runs of this driver's store.
 *
 * `"process"` is a long-lived process: a fiber sweeps the store every
 * heartbeat interval for runs to wake or reclaim, and every owned round renews
 * its lease on the same cadence. `{ host }` is one execution driven by a host
 * that wakes it from outside, such as a Cloudflare Durable Object alarm: no
 * sweep runs, no lease is renewed, and registration recovers only that
 * execution's own clocks and completions.
 *
 * @since 1.0.0
 * @category models
 */
export type Sweep = "process" | {
  readonly host: string
  /** The persisted intent's flow tag; recover only this flow during registration when supplied. */
  readonly flow?: string | undefined
}

/**
 * Dependencies for the run driver.
 *
 * @since 0.1.0
 * @category models
 */
export interface Dependencies {
  readonly owner: Ownership.OwnerId
  readonly journalSource: string
  /**
   * Liveness arbitration before a steal. Optional: the default is
   * `Ownership.leaseLiveness(Ownership.heartbeatStaleAfter)`, which has no
   * evidence beyond the lease and therefore reports the owner gone, so a
   * composition that supplies nothing still reclaims hard-killed runs.
   *
   * A supplied check is consulted for a run whose lease has expired, and also,
   * while the lease is still fresh, for an owner on this host with a different
   * pid: answering `false` there takes the run at once with
   * `same-host-pid-dead` evidence instead of waiting out the lease (#3897).
   */
  readonly isAlive?: Ownership.LivenessCheck | undefined
  readonly canExecute?: ((row: RunStore.RunRow) => Effect.Effect<boolean>) | undefined
  readonly canActivate?: ((row: RunStore.RunRow) => Effect.Effect<boolean>) | undefined
  /**
   * Records, for a host that keeps one, that this driver has asked a
   * SUSPENDED execution to resume.
   *
   * Every wake the engine itself initiates passes through here: a durable
   * clock firing, a durable deferred completing (a signal, a queue offer, a
   * registration-time sweep of completions taken while the host was down),
   * and a child settling under a parent that parked on it. A host that guards
   * re-entry into a parked run — `AgentSession` refuses a round for a parked
   * control row that nobody asked for — otherwise cannot tell those from its
   * own heartbeat sweep, and a run that slept never settled.
   *
   * An operator resume is NOT recorded: `Control.resume` and
   * `ControlLive.decide` claim the control row themselves, and recording a
   * second request for the resume a host is already taking up would buy that
   * park a second re-drive.
   *
   * Optional. A composition with no such host leaves it undefined and the
   * wake is exactly what it was.
   */
  readonly requestResume?:
    | ((executionId: string, reason: RequestedResumeReason) => Effect.Effect<void>)
    | undefined
  readonly engine: Effect.Effect<FlowRuntime.FlowRuntime["Service"]>
  /**
   * In-process wake bus announced to whenever a durable write makes a run
   * runnable — a scheduled resume (deferred, clock, operator) and a run
   * settling terminally. Optional so a direct construction without one keeps
   * the pre-existing polling-only behavior: the default drops every wake,
   * which the engine's suspension polling schedule already covers.
   */
  readonly wakeBus?: WakeBus.Service | undefined
  /**
   * Runs inside the uninterruptible finalizer that retains a suspended run's
   * flow scope, immediately after the entry is inserted and before the round's
   * settlement can start.
   *
   * Private to `packages/smithers/flows/engine-store/test`. That boundary is where a pending
   * interruption first becomes observable again, and no public seam reaches
   * it, so the regression proving the retention is released there — rather
   * than stranded until the driver's own scope closes — raises the
   * interruption from here. This module is not exported from the package
   * (`"./internal/*": null`), and production compositions leave the hook
   * undefined, which costs one `undefined` check per suspension.
   */
  readonly unsafeOnScopeRetained?: ((runId: string) => Effect.Effect<void>) | undefined
  /**
   * Who wakes this store's runs. Absent is `"process"`. See {@link Sweep}.
   */
  readonly sweep?: Sweep | undefined
  /**
   * How many runs the engine resumes on its own at once. Absent is no bound.
   * See `EngineStore.Options.resumeConcurrency`.
   */
  readonly resumeConcurrency?: number | undefined
  /**
   * Where this store's runs run, as their usage metrics label it
   * (`@smthrs/flow` `RunMetrics.placements`). Absent is `local`.
   */
  readonly placement?: string | undefined
}

/**
 * Claim-gated operations composed into the encoded flow engine.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  readonly admit: (
    flow: Flow.Any,
    options: { readonly executionId: string; readonly payload: object }
  ) => Effect.Effect<void, FlowCycleDetected>
  readonly register: FlowEngine.Encoded["register"]
  /**
   * The encoded `execute`, widened for direct driver callers: an absent
   * `round` admits the execution as round zero of its own lineage. Nested
   * direct callers observe its latest round; encoded callers read one round.
   * To decode a terminal result, direct nested callers must register the
   * terminal flow's codec in this driver, even if another worker ran it.
   * A missing codec is a wiring defect, as with the typed Trampoline; it
   * fails fast rather than suspending terminal work with no future wake.
   */
  readonly execute: <const Discard extends boolean>(
    flow: Flow.Any,
    options: {
      readonly executionId: string
      readonly payload: object
      readonly discard: Discard
      readonly parent?: FlowRuntime.FlowInstance["Service"] | undefined
      readonly round?: Parameters<FlowEngine.Encoded["execute"]>[1]["round"] | undefined
      readonly follow?: boolean | undefined
    }
  ) => Effect.Effect<Discard extends true ? void : Flow.Result<unknown, unknown>, FlowCycleDetected>
  readonly poll: FlowEngine.Encoded["poll"]
  /**
   * The encoded `retryFrom`: admits a root run that retries a settled run
   * from one of its steps, seeded with the source's attempts that finished
   * before that step, and schedules it. See `internal/RetrySource`.
   */
  readonly retryFrom: NonNullable<FlowEngine.Encoded["retryFrom"]>
  readonly interrupt: FlowEngine.Encoded["interrupt"]
  readonly interruptUnsafe: FlowEngine.Encoded["interruptUnsafe"]
  readonly resume: FlowEngine.Encoded["resume"]
  /**
   * `resume` with `{ poll: true }` for a host that drives a run from outside,
   * such as after a restart: an idle run waits for a slot of the resume lane
   * (`Options.resumeConcurrency`).
   */
  readonly resumeHosted: (flow: Flow.Any, executionId: string) => Effect.Effect<void>
  readonly scheduleResume: (
    flowName: string,
    executionId: string,
    reason: ScheduledResumeReason,
    sourceId?: string | undefined
  ) => Effect.Effect<void>
  readonly active: Effect.Effect<ReadonlySet<string>>
  /**
   * The runs whose parked flow scope this driver still holds. Cancellation
   * and re-drive both release; the set is the leak assertion's observation
   * point.
   */
  readonly retainedRuns: Effect.Effect<ReadonlySet<string>>
  /**
   * Announces a settled run's settlement again to every parent still waiting
   * on it, as its settling drive did, when the run is the last round of its
   * lineage; a round that handed off announces nothing.
   *
   * For a host that drives one execution per invocation: an invocation that
   * died between the terminal transition and the parents' wake records left
   * those parents parked with nothing due, and the next drive of the settled
   * run records them. A wake already recorded, consumed or not, is not
   * scheduled again. Call it only for a run the store holds as settled.
   */
  readonly reannounce: (executionId: string) => Effect.Effect<void>
  /**
   * Ends the active drive of `executionId` at once and releases the run, as
   * an interruption does, recording the release as `yielded`: its host spent
   * the drive's budget and drives the run again right away. Waits for the
   * release to be written. A run with no active drive is left as it is.
   *
   * The caller decides when: `EngineStore.drive` calls it only once no step
   * is running, so nothing it interrupts has started an attempt.
   */
  readonly yieldDrive: (executionId: string) => Effect.Effect<void>
}

interface Registration {
  readonly flow: Flow.Any
  readonly execute: (
    payload: object,
    executionId: string
  ) => Effect.Effect<unknown, unknown, FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime>
}

/**
 * The effect kind a detached child spawn is journaled under, and therefore the
 * kind an engine composition registers a spawn-compensation handler for.
 *
 * @since 0.1.0
 * @category constants
 */
export const spawnEffectKind = EventTypes.childSpawnKind

const snapshot = (row: RunStore.RunRow): RunStore.RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object") return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Compares encoded JSON payloads structurally. Object key order is not part
 * of JSON identity, while array order and array length are.
 *
 * Values outside JSON compare unequal unless both arguments are the same
 * reference.
 *
 * @since 1.0.0
 * @category guards
 * @private
 */
export const samePayload = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true
  if (typeof left === "number" && typeof right === "number") {
    return left === 0 && right === 0
  }
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false
    for (let index = 0; index < left.length; index++) {
      if (!samePayload(left[index], right[index])) return false
    }
    return true
  }
  if (Array.isArray(right) || !isPlainObject(left) || !isPlainObject(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key) || !samePayload(left[key], right[key])) return false
  }
  return true
}

/**
 * Sentinel produced when the cancel-request poll observes a durable
 * cancellation before the flow settles.
 */
const cancelRequested = { _tag: "CancelRequested" } as const

/**
 * How many stale-running rows one heartbeat tick may wake (issue #79).
 * Oldest heartbeats surface first, so a backlog larger than the batch
 * drains across ticks; each successful steal removes the row from the
 * stale window, and losing drivers see a shrinking batch next tick.
 */
const staleRunningSweepBatch = 64

/**
 * How long a run waits before its live owner is probed again, and how far
 * that wait doubles.
 *
 * A refusal is evidence: the recorded owner answered, so the one thing the
 * sweep knows is that re-asking immediately is waste. Without a wait the
 * oldest batch is re-probed every heartbeat forever and nothing behind it is
 * ever reached (issue #79 follow-up). The first wait is two ticks, which is
 * already enough for the batch to move on, and it doubles up to the lease
 * window: an owner that stops heartbeating is therefore re-probed within one
 * `heartbeatStaleAfter` of the last refusal, which is the same window every
 * other reclaim decision is made against.
 */
const stealRefusalBackoffFirst = Duration.times(Ownership.heartbeatInterval, 2)

const stealRefusalBackoffMax = Ownership.heartbeatStaleAfter

/**
 * A refusal this driver remembers: which lease it was refused against, when
 * the owner may be probed again, and how many consecutive refusals that
 * lease has produced (the backoff exponent).
 *
 * Keyed by run id and holding the heartbeat it was collected against, so an
 * owner that resumes heartbeating — a new lease — restarts the ladder rather
 * than inheriting a long wait from the stall that preceded it.
 */
interface StealRefusal {
  readonly heartbeatAtMs: number | null
  readonly nextProbeAtMs: number
  readonly attempt: number
}

/**
 * The type of {@link cancelRequested}: the settlement a round takes when the
 * cancel-request poll wins the race against the flow.
 */
type CancelRequested = typeof cancelRequested

/** Whether a run's status is final: it completed, failed, or was cancelled. */
const isSettled = (status: RunStore.RunStatus): boolean =>
  status === "completed" || status === "failed" || status === "cancelled"

const withoutResult = (state: RunState): RunState => {
  const { cancellation: _, result: __, ...rest } = state
  return rest
}

/**
 * Where the pending-admission sweep is in one flow's backlog: the last row
 * of the backlog it saw when the cycle began, the admission cutoff it reads
 * against, and the last row it has visited.
 */
interface PendingCycle {
  readonly through: DurableEngineState.PendingRunCursor
  readonly eligibleBeforeMs: number
  after?: DurableEngineState.PendingRunCursor
}

/** Where the pending-cancellation sweep is in its backlog, as for {@link PendingCycle}. */
interface CancellationCycle {
  readonly through: DurableEngineState.PendingRunCursor
  after?: DurableEngineState.PendingRunCursor
}

/**
 * Everything one run driver holds: what it was built with, the stores it
 * writes through, the coordinator that runs one drive per run, and the
 * in-process tables its steps share.
 */
interface Driver {
  readonly dependencies: Dependencies
  readonly journal: Journal.Service
  readonly writer: DurableWriter["Service"]
  readonly store: RunStore.Service
  readonly engineState: DurableEngineState.Service
  readonly lifecycle: ReturnType<typeof RunLifecycle.make>
  readonly executionFacts: ReturnType<typeof ExecutionFacts.make>
  /**
   * The package's ordered state-and-journal boundary: engine state first,
   * the journal's write transaction inside it. See
   * {@link StateTransaction.make} for the order and what it guarantees.
   */
  readonly transactState: ReturnType<typeof StateTransaction.make>
  readonly wakeBus: WakeBus.Service
  /**
   * Runs each run's drives one at a time. Its drain is {@link drive}, and
   * every start, wake, and sweep enters through it.
   */
  readonly coordinator: RunCoordinator.RunCoordinator<string, never>
  /** Where this store's runs run, as their usage metrics label it. */
  readonly placement: RunMetrics.Placement
  /**
   * The level the host that built this store asked the usage lines at. A
   * run is admitted in its caller's fiber, such as a browser leader's
   * request handler, whose context doesn't say; every usage record of this
   * store writes at the host's level.
   */
  readonly lineLevel: "Debug" | "Info"
  /**
   * Whether a host wakes this store's runs from outside (`sweep: { host }`).
   * Such a host lives for one invocation: it neither sweeps the store nor
   * renews leases, and its own liveness check, not a lease, tells a crashed
   * incarnation from a live one.
   */
  readonly hosted: boolean
  /**
   * The deployment's own liveness answer, if it gave one.
   *
   * Kept separate from {@link Driver.isAlive} because the two differ in what they
   * PROVE, and the journal says which was used: a supplied probe reports on
   * the process (or the host it lives on), while the default reports only
   * that the lease it stopped renewing has expired.
   */
  readonly suppliedIsAlive: Ownership.LivenessCheck | undefined
  readonly isAlive: Ownership.LivenessCheck
  readonly registrations: Map<string, Array<Registration>>
  /**
   * Runs already warned about waking without a registered flow (issue
   * #62): the sweep retries every heartbeat, so the warning is emitted
   * once per run, not once per tick. Cleared on every registration — a
   * newly registered flow makes previously dropped runs drivable again.
   */
  readonly warnedUnregistered: Set<string>
  /**
   * Runs whose owner answered a probe (or held a fresh lease) and are
   * therefore not worth re-arbitrating yet. See {@link StealRefusal}.
   *
   * Bounded by the stale set the sweep can see: every tick drops the entries
   * whose rows are no longer in the window it read, so a run that is stolen,
   * released, or settled takes its entry with it.
   */
  readonly stealRefusals: Map<string, StealRefusal>
  /**
   * The owner and reason each waiting run was last reported with, so a
   * caller that polls a held run reads one line per owner, not one per
   * poll. An entry leaves when this driver takes the run.
   */
  readonly waitNotices: Map<string, string>
  readonly liveInstances: Map<string, FlowRuntime.FlowInstance["Service"]>
  /**
   * Runs whose drive {@link Service.yieldDrive} is ending, so the release
   * its interruption writes records `yielded` rather than `interrupted`.
   */
  readonly yielding: Set<string>
  /**
   * Flow scopes retained past a round's settlement.
   *
   * `Flow.intoResult` closes the flow scope for every settlement EXCEPT a
   * suspension — a parked flow keeps its scope so the resources its body
   * acquired outlive the park (`packages/smithers/flows/flow/src/Flow/Runtime.ts`). Nothing
   * then owned that scope: the instance left `liveInstances` on the way out
   * and the `Scope.Closeable` became unreachable, so a cancelled parked flow
   * never ran its finalizers and every park leaked one scope for the
   * process's lifetime.
   *
   * The map is that owner. It holds at most one scope per run — an entry is
   * a state, not a queue — and every removal goes through
   * `releaseRetainedScope`, which deletes before it closes. That makes the
   * close idempotent by construction rather than by a flag: a second caller
   * finds no entry and does nothing, so concurrent cancel, resume, and
   * shutdown paths cannot double-finalize.
   */
  readonly retainedScopes: Map<string, Scope.Closeable>
  /**
   * The pending-admission sweep's place in each flow's backlog. Admissions
   * committed before a host crash have no lease to go stale, so the sweep
   * reuses the normal coordinator and claim/activate path for these rows.
   */
  readonly pendingCycles: Map<string, PendingCycle>
  /** The pending-cancellation sweep's place in its backlog, between ticks. */
  pendingCancellationCycle: CancellationCycle | undefined
  /** Which registered flow the pending-admission sweep starts from next tick. */
  pendingFlowOffset: number
  /** The driver's own `Crypto`, which a child's admission derives boundary ids with. */
  readonly crypto: Context.Context<Crypto.Crypto>
  /**
   * Each running round's retry seed, read once when the round first admits
   * a child: `null` for a round of a run that is no retry. A child opened at a
   * boundary the source settled is carried (`carriedChild`).
   */
  readonly retries: WeakMap<FlowRuntime.FlowInstance["Service"], RunState["retryFrom"] | null>
}

/**
 * Records a lineage's settlement in the usage metrics (`@smthrs/flow`
 * `RunMetrics`), once its terminal transition committed: by its flow, how
 * it settled, its origin and this store's placement, and how long it took
 * since its first round's admission. Never its payload or its result.
 */
const recordSettled = (
  driver: Driver,
  executionId: string,
  state: RunState,
  settled: { readonly outcome: RunMetrics.Outcome; readonly code: string }
): Effect.Effect<void> =>
  Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
    RunMetrics.recordSettled({
      flow: state.flowName,
      door: state.origin?.door ?? "unknown",
      actor: state.origin?.actor ?? "unknown",
      placement: driver.placement,
      executionId,
      outcome: settled.outcome,
      code: settled.code,
      durationMs: state.origin === undefined ? undefined : nowMs - state.origin.admittedAtMs
    })).pipe(Effect.provideService(RunMetrics.LineLevel, driver.lineLevel))

/**
 * The evidence kind a steal admitted by {@link Driver.isAlive} carries.
 *
 * `steal` is only reached for a run whose lease has already expired, so
 * `lease-expired` is always true here; what the supplied-probe kinds add
 * is WHY the deployment believes the owner is gone, which is the
 * distinction `RunStore` binds to the host relation.
 */
const livenessEvidenceKind = (driver: Driver, expectedOwner: Ownership.OwnerId): Ownership.LivenessEvidence["kind"] =>
  driver.suppliedIsAlive === undefined
    ? "lease-expired"
    : Ownership.sameHostIncarnation(expectedOwner, driver.dependencies.owner)
    ? "same-host-pid-dead"
    : "cross-host-unreachable-stale"

/** Owner identity equality, the fence's own notion of "the same process". */
const sameOwner = (left: Ownership.OwnerId, right: Ownership.OwnerId): boolean =>
  left.hostId === right.hostId && left.pid === right.pid && left.nonce === right.nonce

/**
 * Records that a run's recorded owner was found alive, and when it may be
 * asked about again.
 */
const deferSteal = (driver: Driver, runId: string, heartbeatAtMs: number | null, nowMs: number): void => {
  const previous = driver.stealRefusals.get(runId)
  // A moved lease is new evidence about a different state of the world, so
  // it starts the ladder over instead of inheriting the old wait.
  const attempt = previous !== undefined && previous.heartbeatAtMs === heartbeatAtMs ? previous.attempt + 1 : 1
  const waitMs = Math.min(
    Duration.toMillis(stealRefusalBackoffFirst) * Math.pow(2, attempt - 1),
    Duration.toMillis(stealRefusalBackoffMax)
  )
  driver.stealRefusals.set(runId, { heartbeatAtMs, nextProbeAtMs: nowMs + waitMs, attempt })
}

/**
 * The journal address of one refusal.
 *
 * Refusals were emitted through the driver's default source id with no
 * `sourceSeq`, so nothing deduplicated them: a live owner cost one durable
 * journal row per refused run per heartbeat, indefinitely. Addressing the
 * record by the run, the owner, and the lease it was refused against makes
 * the journal's own first-writer admission the deduplication — the same
 * mechanism the registration-time wake records use — so a repeated refusal
 * about an unchanged lease says nothing twice.
 *
 * The evidence is part of the address because one lease can be refused for
 * two different reasons, and they are different records. A wake that
 * arrives while the owner is still pulsing is refused by the lease alone
 * (`lease-fresh`); the same owner, still alive but stalled past the
 * window, is refused by the probe (`probe`). Addressing both to one key
 * made the second write a different payload under the first one's address,
 * which the journal rejects as `idempotency_conflict` — a defect that
 * killed the drive fiber, dropped the probe refusal, and took down any
 * `execute` joined to that run. One address per (run, owner, lease,
 * evidence) keeps every reason sayable and still admits each of them once.
 *
 * That makes this driver's own payload a pure function of its address, so
 * it can no longer conflict with itself. It is not the only writer at
 * these addresses, and a conflict raised by another one is no longer fatal
 * either: refusals are emitted through {@link emitEvidence}.
 */
const stealRefusedSourceId = (
  driver: Driver,
  owner: Ownership.OwnerId,
  heartbeatAtMs: number | null,
  evidence: "lease-fresh" | "probe"
): string =>
  `${driver.dependencies.journalSource}:steal-refused:${evidence}:${
    JSON.stringify([owner.hostId, owner.pid, owner.nonce])
  }:${heartbeatAtMs}`

/**
 * Asks the supplied probe about the owner of a fresh lease, when its
 * answer can prove that owner gone (#3897).
 *
 * A process killed with `SIGKILL` leaves its run `running` under a lease
 * that stays fresh for `heartbeatStaleAfter`, and a rerun of the same
 * execution used to wait that long in silence. On the owner's own host a
 * pid probe answers the question the lease stands in for, so it is asked.
 * Two owners are never put to it, and answer `undefined`: one on another
 * host, whose pid names nothing here, and one with this process's own pid,
 * which is running. Without a supplied probe there is nothing to ask. The
 * probe's `alive` is final, so a pid the system reused for a live process
 * keeps the run waiting.
 */
const probeFreshOwner = (
  driver: Driver,
  owner: Ownership.OwnerId,
  heartbeatAtMs: number,
  nowMs: number
): Effect.Effect<"alive" | "dead" | undefined> =>
  driver.suppliedIsAlive === undefined ||
    !Ownership.sameHostIncarnation(owner, driver.dependencies.owner) ||
    owner.pid === driver.dependencies.owner.pid
    ? Effect.succeed(undefined)
    : Effect.map(
      driver.suppliedIsAlive(owner, { claimant: driver.dependencies.owner, heartbeatAtMs, nowMs }),
      (alive) => alive ? "alive" : "dead"
    )

/**
 * Says why this driver will not take a run another owner holds, and for
 * how long (#3897). Without it a rerun waiting out a dead owner's lease
 * printed nothing for the whole window.
 *
 * `alive` is the probe's answer when it was asked. A live owner is waited
 * on until it finishes or exits; any other refusal is the lease, which
 * expires `heartbeatStaleAfter` after the owner's last heartbeat.
 */
const noticeWait = (
  driver: Driver,
  runId: string,
  owner: Ownership.OwnerId,
  heartbeatAtMs: number,
  nowMs: number,
  alive: boolean
): Effect.Effect<void> => {
  const holder = `${owner.hostId}:${owner.pid}`
  const sameHost = Ownership.sameHostIncarnation(owner, driver.dependencies.owner)
  const key = `${holder}:${owner.nonce}:${alive}`
  // A run this driver already owns is not another owner's to wait on.
  if (sameOwner(owner, driver.dependencies.owner) || driver.waitNotices.get(runId) === key) return Effect.void
  driver.waitNotices.set(runId, key)
  const waitMs = heartbeatAtMs + Duration.toMillis(Ownership.heartbeatStaleAfter) - nowMs
  const message = alive
    ? sameHost
      ? `run ${runId} is held by ${holder}, a live process on this host; waiting for it to finish or exit`
      : `run ${runId} is held by ${holder} on another host, which the liveness check reports alive; waiting for it to release the run`
    : `run ${runId} is held by ${holder}${
      !sameHost
        ? " on another host"
        : driver.suppliedIsAlive === undefined
        ? ", which no liveness probe checks"
        : ", an earlier owner in this process"
    }; waiting up to ${Math.max(1, Math.ceil(waitMs / 1000))} s for its lease to expire`
  return Effect.logInfo(`engine-store: ${message}`).pipe(
    Effect.annotateLogs({ runId, ownerHostId: owner.hostId, ownerPid: owner.pid, ...(alive ? {} : { waitMs }) })
  )
}

/**
 * Closes a run's retained flow scope exactly once, if it has one.
 *
 * `exit` decides what the finalizers see. A cancellation closes with an
 * interrupt exit so `Flow.withRollback` compensations run; a supersede
 * (the run re-entered execution under a fresh instance and scope) closes
 * with `Exit.void` so ordinary finalizers release resources while
 * rollbacks correctly stay out — a re-driven round is not an unsuccessful
 * exit.
 */
const releaseRetainedScope = (
  driver: Pick<Driver, "retainedScopes">,
  runId: string,
  exit: Exit.Exit<unknown, unknown>
): Effect.Effect<void> =>
  Effect.suspend(() => {
    const scope = driver.retainedScopes.get(runId)
    if (scope === undefined) return Effect.void
    driver.retainedScopes.delete(runId)
    return Scope.close(scope, exit).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `engine-store: finalizers of parked run ${runId} failed while closing its retained flow scope`,
          cause
        )
      )
    )
  })

/**
 * Snapshots the runs whose flow scope this driver is currently holding.
 * Exposed for the leak assertions in `packages/smithers/flows/engine-store/test`, which
 * would otherwise have to reach into driver internals.
 */
const retainedRuns = (driver: Driver) => Effect.sync(() => new Set(driver.retainedScopes.keys()))

const encodeState = (state: RunState): Effect.Effect<string> =>
  Schema.encodeEffect(RunStateJson)(state).pipe(Effect.orDie)

const decodeState = (stateJson: string): Effect.Effect<RunState> =>
  Schema.decodeUnknownEffect(RunStateJson)(stateJson).pipe(Effect.orDie)

/** A run's row, or `undefined` when the store holds none; any other read failure is a defect. */
const findRun = (driver: Driver, runId: string): Effect.Effect<RunStore.RunRow | undefined> =>
  driver.store.get(runId).pipe(
    Effect.catch((error) => error.code === "not_found_row" ? Effect.succeed(undefined) : Effect.die(error))
  )

/**
 * Tells the host that this driver is asking a PARKED execution to resume.
 *
 * Only a parked one. A wake against a run that is still running is
 * already covered by the round it is in, and a request recorded for it
 * would be a delegation no park ever takes up: the host polls it for as
 * long as the run lives, and every poll pays a park wait for a run that
 * is not parked.
 *
 * See {@link Dependencies.requestResume} for which wakes reach here.
 */
const recordResume = (
  driver: Driver,
  executionId: string,
  parked: boolean,
  reason: RequestedResumeReason
): Effect.Effect<void> =>
  driver.dependencies.requestResume === undefined || !parked
    ? Effect.void
    : driver.dependencies.requestResume(executionId, reason)

/**
 * {@link recordResume} for the parent a settling child is waking.
 *
 * The waiting row is the park: it is written in the same transaction as
 * the suspended transition and cleared by the claim that ends it, so a
 * parent that has one is parked and a parent mid-round has none. It is
 * Persist the wake even without a host recorder: the parent can belong to
 * another process whose suspended execution discovers it by polling.
 */
const parentWakePrefix = "@smthrs/engine/parent-settled/"

const recordParentResume = (driver: Driver, parentExecutionId: string, childExecutionId: string): Effect.Effect<void> =>
  Effect.gen(function*() {
    const parent = yield* findRun(driver, parentExecutionId)
    if (parent === undefined || isSettled(parent.status)) return
    const state = yield* decodeState(parent.stateJson)
    const waiting = yield* driver.engineState.waiting(parentExecutionId)
    if (Option.isSome(waiting) && waiting.value.reason === "quarantine") return
    // Persist before publishing: a remote parent's poll must see this wake,
    // including when its current round has not finished parking yet.
    const recorded = yield* driver.transactState(
      Effect.gen(function*() {
        const completed = yield* driver.engineState.completeDeferred({
          flowName: state.flowName,
          executionId: parentExecutionId,
          deferredName: parentWakePrefix + childExecutionId,
          exit: { _tag: "Success", value: null },
          completedAtMs: yield* Clock.currentTimeMillis
        })
        // A settlement announced again (`reannounce`) finds its wake
        // already recorded, and perhaps already consumed: it is not
        // scheduled twice.
        if (completed._tag === "Existing") return false
        yield* emitDecision(driver, parentExecutionId, { decision: "wake-scheduled", reason: "parent" })
        return true
      }),
      { partition: parentExecutionId }
    ).pipe(Effect.orDie)
    if (recorded) yield* recordResume(driver, parentExecutionId, Option.isSome(waiting), "parent")
  })

const requestCancellation = (driver: Driver, runId: string, at: number) =>
  driver.executionFacts.requestCancel(runId, at).pipe(
    Effect.catchIf(
      (error) => error._tag === "@smthrs/journal/JournalError" || error instanceof DatabaseError,
      Effect.die
    )
  )

/**
 * Run decisions are lifecycle records: they take the journal's durable
 * channel so a saturated lossy queue can never drop them (issue #10).
 * They stay ownerless because several decisions — `claim-lost`,
 * `steal-refused-owner-alive`, post-transition `transitioned` — are
 * legitimately recorded by a process that does not (or no longer does)
 * own the run; the ownership fence for these paths is the run-row CAS
 * that precedes each emit.
 *
 * `meta.lineageId` is a JOURNAL lineage id (`FlowEngine.Lineage`,
 * `<runId>/root`), because that is the space a time-travel frame addresses:
 * time travel (`packages/smithers/flows/time-travel/docs/README.md`) makes a frame `(lineageId, seq)`, and
 * replay skips an entry whose `meta.lineageId` names a different lineage.
 * The run row's `lineageId` column is a different space — the TRAMPOLINE
 * lineage of `packages/smithers/flows/engine/docs/concepts/trampoline-rounds.md`, round 0's execution
 * id.
 *
 * DECIDED (2026-08-12): decisions address the journal lineage of the run
 * that records them, one per round, the same lineage that run's attempt
 * and snapshot records already carry. Reading the run row's trampoline
 * lineage here put a run's decisions in a lineage its own attempts do not
 * address, so a rewind of that run skipped them. The trampoline lineage is
 * not lost: `created` and `handed-off` carry `lineageId` and
 * `roundOrdinal` in the decision payload, which is what walks a whole
 * trampoline chain.
 */
const decisionRecord = (driver: Driver, runId: string, payload: unknown, sourceId: string) =>
  // Lifecycle decisions normally use the unfenced channel: they commit in the SAME transaction
  // as the store-level owner CAS that is its fence (`transitionOwned`,
  // `activate`, `claim`/`steal` outcomes), and by then the run is often no
  // longer `running` under this owner, which is the exact predicate the
  // journal fence asserts. Several call sites (claim-lost,
  // steal-refused-owner-alive, activation-lost) also record decisions for
  // runs this driver never owned at all — first-writer-wins evidence,
  // which is what the unfenced channel exists for. Lease reconfirmation
  // retains ownership and emits this record through the fenced channel.
  JournalRecords.runDecision({
    runId,
    lineageId: FlowEngine.Lineage.root(runId),
    sourceId,
    ...(sourceId === driver.dependencies.journalSource ? {} : { sourceSeq: 0 })
  }, payload)

/**
 * Completes every pending clock of a settled run and records each
 * completion, in the caller's transaction. A run that settles before its
 * timer fires still has to leave the journal saying the clock is done, or
 * a rebuilt deadline index would arm it again (issue #2037).
 */
const completeRunClocks = (driver: Driver, runId: string, completedAtMs: number) =>
  Effect.flatMap(
    driver.engineState.completeRunClocks(runId, completedAtMs),
    (completed) =>
      Effect.forEach(completed, (clock) =>
        driver.journal.emitDurableUnfenced(
          JournalRecords.clockCompletedFor(
            driver.dependencies.journalSource,
            FlowEngine.Lineage.root(runId),
            clock,
            completedAtMs
          )
        ), { discard: true })
  )

/**
 * Records a decision this driver's own write transaction is responsible
 * for: the `transitioned` record that commits with its run-row CAS, and
 * the `claimed-and-activated` / `stolen-and-activated` record that commits
 * with the activation CAS.
 *
 * These stay fatal. They take the driver's default source id, so the
 * journal allocates them a fresh `sourceSeq` and no address can collide;
 * a failure here is the storage layer failing under a transaction whose
 * other half is a run-row write, and the transaction has to take the
 * driver down with it rather than commit a terminal row whose decision
 * never reached the journal.
 */
const emitDecision = (
  driver: Driver,
  runId: string,
  payload: unknown,
  sourceId = driver.dependencies.journalSource
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const decision = payload as Readonly<Record<string, unknown>>
    const authoritative = sourceId === driver.dependencies.journalSource && decision.decision !== "wake-scheduled" &&
      decision.decision !== "child-policy-applied"
    const recorded = authoritative
      ? {
        ...decision,
        executionFact: yield* driver.executionFacts.fact(runId, decision.decision === "created" ? "created" : "legacy")
      }
      : payload
    yield* driver.journal.emitDurableUnfenced(decisionRecord(driver, runId, recorded, sourceId))
  }).pipe(Effect.orDie)

/**
 * Records evidence ABOUT a run this driver does not own, and never raises
 * on the drive fiber.
 *
 * `claim-lost`, `activation-lost` and `steal-refused-owner-alive` are the
 * three decisions taken about a run another process holds. They are
 * observations, not commitments: the arbitration they describe already
 * happened in the store, the caller has already lost, and the very next
 * thing every one of these call sites does is answer `false`. Routing them
 * through {@link emitDecision} put an audit write on the failure path of
 * the loop that drives every run in the process — an `idempotency_conflict`
 * on a shared refusal address killed the drive fiber, dropped the record
 * anyway, and took down any `execute` joined to that run.
 *
 * So the receipt is folded into a log, the shape `ActionPersistence`'s
 * `emitConverging` uses for the same reason on the replay branches:
 *
 * - `Accepted`: the observation is durable. Nothing to say.
 * - `Duplicate`: an identical observation is already durable — the
 *   per-heartbeat deduplication the refusal address exists for. Debug.
 * - `idempotency_conflict`: this address already holds a DIFFERENT
 *   observation, so someone (another process, an earlier evidence shape,
 *   a copied journal after a time-travel fork) said something else about
 *   the same (run, owner, lease, evidence). The durable record wins and
 *   the divergence is worth a warning, but it is still only evidence.
 *
 * Any other journal failure is folded the same way and for the same
 * reason: an audit record must never be the thing that stops a driver
 * from driving. A journal that is genuinely broken still fails the very
 * next decision write that IS a fence, which is where it belongs.
 */
const emitEvidence = (
  driver: Driver,
  runId: string,
  payload: unknown,
  sourceId = driver.dependencies.journalSource
): Effect.Effect<void> =>
  driver.journal.emitDurableUnfenced(decisionRecord(driver, runId, payload, sourceId)).pipe(
    Effect.flatMap((receipt) =>
      receipt._tag === "Duplicate"
        ? Effect.logDebug(
          `engine-store: run ${runId} already recorded this evidence`,
          { runId, sourceId, seq: receipt.seq }
        )
        : Effect.void
    ),
    Effect.catch((error) =>
      Effect.logWarning(
        `engine-store: evidence about run ${runId} was not admitted to the journal (${error.code}); the run is unaffected`,
        { runId, sourceId, code: error.code, payload }
      )
    )
  )

/**
 * Commits a run-row transition and the decision describing it in ONE write
 * transaction, reporting the store outcome.
 *
 * `RunStore` and the journal write through the same `DurableWriter`, so the CAS
 * becomes a savepoint of this transaction: a crash can no longer leave a
 * terminal run row whose `transitioned` decision never reached the
 * journal, nor a decision for a CAS that lost. Temporal commits mutable
 * state and its history events as one persistence request
 * (`reference/temporal/service/history/workflow/transaction_impl.go`);
 * this is the same unit of work for a run transition.
 *
 * The decision is emitted only for a `Transitioned` outcome: a lost CAS
 * changed nothing, and its `claim-lost`/`activation-lost` records are
 * emitted by the caller, outside the transaction, so they survive.
 *
 * `waiting` parks before the CAS releases ownership, inside this same
 * transaction. A refused park or transition FAILS the transaction, so SQL
 * rolls back and the memory state's serialized snapshot is restored too.
 * Only outside both boundaries is the refusal returned as an outcome.
 * No former owner reads or clears a replacement's waiting marker.
 *
 * `afterTransitioned` is the seam for work that must commit WITH the
 * transition or not at all: today, ending the run's linked children on a
 * terminal exit. It runs only after a successful CAS, so a lost fence
 * touches nothing, and inside the transaction, so a crash between the two
 * writes rolls both back.
 */
const transitionAndRecord = (
  driver: Driver,
  runId: string,
  toStatus: RunStore.RunStatus,
  stateJson: string,
  decision: unknown,
  guard?: RunStore.TransitionGuard | undefined,
  afterTransitioned?: Effect.Effect<void> | undefined,
  waiting?: DurableEngineState.Waiting | null | undefined
): Effect.Effect<RunStore.TransitionOutcome> =>
  driver.transactState(
    Effect.gen(function*() {
      if (waiting !== undefined && waiting !== null) {
        const parked = yield* driver.engineState.park(runId, waiting, driver.dependencies.owner)
        if (parked._tag === "NotFound") {
          return yield* Effect.fail({ _tag: "TransitionRefused" as const, outcome: parked })
        }
      }
      const transitioned = yield* driver.store.transitionOwned(
        runId,
        driver.dependencies.owner,
        toStatus,
        stateJson,
        guard
      ).pipe(Effect.orDie)
      if (transitioned._tag !== "Transitioned") {
        return yield* Effect.fail({ _tag: "TransitionRefused" as const, outcome: transitioned })
      }
      if (waiting === null) {
        yield* driver.engineState.wake(runId)
      }
      if (afterTransitioned !== undefined) {
        yield* afterTransitioned
      }
      // Every terminal round closes its own deadlines, including a
      // handoff whose successor and linked children continue separately.
      if (toStatus === "completed" || toStatus === "failed") {
        yield* completeRunClocks(driver, runId, yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor)))
      }
      // The decision carries the state it committed, so run state at a
      // frame is DERIVED by replaying decisions rather than read off the
      // run row's current `state_json`
      // (Temporal's
      // `ndc/state_rebuilder.go` is the model). Without it a fork at an
      // early frame silently inherited the parent's *latest* state.
      yield* emitDecision(driver, runId, { ...(decision as object), state: JSON.parse(stateJson) })
      return transitioned
    }),
    // The run's own rows. Ending its children (`afterTransitioned`) reads
    // the edge table, which only schema-wide writes change, and joins each
    // child's partition before it reads the child's rows (`lockedRounds`).
    { partition: runId }
  ).pipe(
    Effect.catchTag("TransitionRefused", ({ outcome }) => Effect.succeed(outcome)),
    Effect.orDie
  )

const abandon = (driver: Driver, runId: string, claimedAtMs: number): Effect.Effect<void> =>
  driver.store.abandonClaim(runId, driver.dependencies.owner, claimedAtMs).pipe(
    Effect.asVoid,
    Effect.orDie
  )

/** Whether a run is parked in quarantine, which only an operator's resume lifts. */
const isQuarantined = (driver: Driver, runId: string): Effect.Effect<boolean> =>
  Effect.map(
    driver.engineState.waiting(runId),
    (waiting) => Option.isSome(waiting) && waiting.value.reason === "quarantine"
  )

/** Each way a claim ends: the span outcome it is annotated with, by its counter. */
const claimOutcomes = {
  Activated: "activated",
  Terminal: "terminal",
  HeartbeatFresh: "heartbeat_fresh",
  StealRefusedOwnerAlive: "steal_refused_owner_alive",
  ClaimLost: "claim_lost",
  ActivationLost: "activation_lost"
} as const

/** Annotates the claim's span with how it ended and counts it. */
const recordClaim = (outcome: keyof typeof claimOutcomes): Effect.Effect<void> =>
  Effect.annotateCurrentSpan({ outcome: claimOutcomes[outcome] }).pipe(
    Effect.andThen(Metric.update(EngineStoreMetrics.claim[outcome], 1))
  )

/** A dead claimant's claim this driver released before claiming the run. */
interface RecoveredClaim {
  readonly claimant: Ownership.OwnerId
  readonly claimedAtMs: number
}

/**
 * What a claim or steal got, and what admitted it: the liveness evidence a
 * steal carried, or the dead claimant's claim a claim released first.
 */
interface Takeover {
  readonly claim: RunStore.StealOutcome
  readonly evidence?: Ownership.LivenessEvidence["kind"] | undefined
  readonly recoveredClaim?: RecoveredClaim | undefined
}

/**
 * Claims a row and activates it under this driver, answering whether the
 * run is now this driver's to execute.
 *
 * A running row is stolen only from an owner the lease and the liveness
 * check both give up; any other row is claimed. Either way the activation
 * CAS re-checks the exact snapshot the claim was taken against.
 */
const claimAndActivate: (driver: Driver, row: RunStore.RunRow) => Effect.Effect<boolean> = Effect.fn(
  "RunDriver.claimAndActivate"
)(function*(driver: Driver, row: RunStore.RunRow) {
  yield* Effect.annotateCurrentSpan({ runId: row.runId, status: row.status })
  if (!(yield* claimable(driver, row))) return false
  const expected = snapshot(row)
  const nowMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
  const takeover = row.status === "running"
    ? yield* steal(driver, row, expected, nowMs)
    : yield* claimParked(driver, row, expected, nowMs)
  if (takeover === undefined) return false
  const { claim } = takeover
  if (claim._tag !== "Claimed") {
    yield* emitEvidence(driver, row.runId, { decision: "claim-lost", outcome: claim._tag, expected })
    yield* recordClaim("ClaimLost")
    yield* Effect.logDebug("run claim lost", { runId: row.runId, outcome: claim._tag })
    return false
  }
  const activation = yield* activate(driver, row, expected, claim.claimedAtMs, takeover)
  if (activation._tag !== "Activated") {
    yield* abandon(driver, row.runId, claim.claimedAtMs)
    yield* emitEvidence(driver, row.runId, { decision: "activation-lost", outcome: activation._tag, expected })
    yield* recordClaim("ActivationLost")
    yield* Effect.logDebug("run activation lost", { runId: row.runId, outcome: activation._tag })
    return false
  }
  yield* recordClaim("Activated")
  yield* Effect.logInfo("flow.run.claimed").pipe(Effect.annotateLogs({
    "smithers.execution.id": row.runId,
    claimedAtMs: claim.claimedAtMs
  }))
  // The run is this driver's now, so whatever it was told about the
  // previous owner is spent.
  driver.stealRefusals.delete(row.runId)
  driver.waitNotices.delete(row.runId)
  return true
})

/**
 * Whether a row may be claimed at all: the deployment admits it, it has not
 * settled, and it is not parked in quarantine.
 */
const claimable = (driver: Driver, row: RunStore.RunRow): Effect.Effect<boolean> =>
  Effect.gen(function*() {
    if (driver.dependencies.canExecute !== undefined && !(yield* driver.dependencies.canExecute(row))) {
      return false
    }
    if (isSettled(row.status)) {
      yield* recordClaim("Terminal")
      return false
    }
    // Every drive, including a fresh execute or a queued wake, must
    // preserve quarantine. Cancellation still claims the row to close it.
    return row.cancelRequestedAtMs !== null || !(yield* isQuarantined(driver, row.runId))
  })

/**
 * Steals a running row whose owner is gone, or answers `undefined` when the
 * owner still holds it: its lease is fresh, or the liveness check reports
 * it alive. A dead stealer's claim left on the row is released first.
 */
const steal = (
  driver: Driver,
  row: RunStore.RunRow,
  expected: RunStore.RunSnapshot,
  nowMs: number
): Effect.Effect<Takeover | undefined> =>
  Effect.gen(function*() {
    const leaseFresh = row.heartbeatAtMs !== null &&
      row.heartbeatAtMs >= nowMs - Duration.toMillis(Ownership.heartbeatStaleAfter)
    const freshOwner = row.owner !== null && row.heartbeatAtMs !== null && leaseFresh &&
        !sameOwner(row.owner, driver.dependencies.owner)
      ? yield* probeFreshOwner(driver, row.owner, row.heartbeatAtMs, nowMs)
      : undefined
    if (row.owner === null || row.heartbeatAtMs === null || (leaseFresh && freshOwner !== "dead")) {
      yield* refuseFreshLease(driver, row, nowMs, freshOwner)
      return undefined
    }
    // An owner the probe just proved gone is not asked again.
    if (
      !leaseFresh &&
      (yield* driver.isAlive(row.owner, {
        claimant: driver.dependencies.owner,
        heartbeatAtMs: row.heartbeatAtMs,
        nowMs
      }))
    ) {
      yield* refuseLiveOwner(driver, row.runId, row.owner, row.heartbeatAtMs, nowMs)
      return undefined
    }
    const evidence = livenessEvidenceKind(driver, row.owner)
    // A stealer that died between its steal and its activation left its claim
    // on the running row, and every later steal lost to it (`AlreadyClaimed`):
    // on Cloudflare its execution retried `Undriven` every alarm, for hours
    // (production, 2026-10-22). It is released first, as a parked row's is.
    const recoveredClaim = yield* recoverDeadClaim(driver, row, nowMs)
    const claim = yield* driver.store.steal(
      row.runId,
      expected,
      driver.dependencies.owner,
      nowMs,
      {
        expectedOwner: row.owner,
        checkedAtMs: nowMs,
        kind: evidence
      }
    ).pipe(Effect.orDie)
    return { claim, evidence, recoveredClaim }
  })

/**
 * Refuses a steal because the lease is fresh.
 *
 * The lease is the refusal. Only a local pid probe is consulted for it, by
 * `probeFreshOwner`: any other probe may be a remote call, and a fresh
 * heartbeat already answers the question. It is journaled anyway — but only
 * when another owner holds the run, because refusing to steal from ourselves
 * is routine re-entry rather than arbitration — so an operator whose
 * `resume` did nothing can see that a live owner was in the way (issue #53
 * follow-up).
 */
const refuseFreshLease = (
  driver: Driver,
  row: RunStore.RunRow,
  nowMs: number,
  freshOwner: "alive" | "dead" | undefined
): Effect.Effect<void> =>
  Effect.gen(function*() {
    if (row.owner !== null && !sameOwner(row.owner, driver.dependencies.owner)) {
      deferSteal(driver, row.runId, row.heartbeatAtMs, nowMs)
      yield* emitEvidence(driver, row.runId, {
        decision: "steal-refused-owner-alive",
        evidence: "lease-fresh",
        expectedOwner: row.owner,
        heartbeatAtMs: row.heartbeatAtMs
      }, stealRefusedSourceId(driver, row.owner, row.heartbeatAtMs, "lease-fresh"))
      // `flows_runs` refuses a running row without a heartbeat (its
      // CHECK constraint), so an owner here always comes with one.
      yield* noticeWait(driver, row.runId, row.owner, row.heartbeatAtMs!, nowMs, freshOwner === "alive")
    }
    yield* recordClaim("HeartbeatFresh")
  })

/** Refuses a steal because the liveness check reports the lapsed owner alive. */
const refuseLiveOwner = (
  driver: Driver,
  runId: string,
  owner: Ownership.OwnerId,
  heartbeatAtMs: number,
  nowMs: number
): Effect.Effect<void> =>
  Effect.gen(function*() {
    yield* noticeWait(driver, runId, owner, heartbeatAtMs, nowMs, true)
    deferSteal(driver, runId, heartbeatAtMs, nowMs)
    yield* emitEvidence(driver, runId, {
      decision: "steal-refused-owner-alive",
      // Always a supplied probe. The default check is the lease, and
      // the lease already refused above for every row that could still
      // be fresh, so reaching this arm means the deployment answered
      // for the owner with something the store cannot see.
      evidence: "probe",
      expectedOwner: owner,
      heartbeatAtMs
    }, stealRefusedSourceId(driver, owner, heartbeatAtMs, "probe"))
    yield* recordClaim("StealRefusedOwnerAlive")
    yield* Effect.logDebug("run steal refused, recorded owner is alive", { runId, heartbeatAtMs })
  })

/** Claims a row nobody is running, first releasing a dead claimant's claim. */
const claimParked = (
  driver: Driver,
  row: RunStore.RunRow,
  expected: RunStore.RunSnapshot,
  nowMs: number
): Effect.Effect<Takeover> =>
  Effect.gen(function*() {
    const recoveredClaim = yield* recoverDeadClaim(driver, row, nowMs)
    const claim = yield* driver.store.claim(
      row.runId,
      expected,
      driver.dependencies.owner,
      nowMs
    ).pipe(Effect.orDie)
    return { claim, recoveredClaim }
  })

/**
 * Releases another claimant's claim older than the lease, when the liveness
 * check gives that claimant up.
 *
 * A process that died between `claim` and `activate` leaves its claim on a
 * parked or pending row, and every later claim loses to it: the run could
 * never be driven again. A claim older than the lease whose claimant is gone
 * is released first, by the same liveness rule a steal applies to a running
 * owner.
 */
const recoverDeadClaim = (
  driver: Driver,
  row: RunStore.RunRow,
  nowMs: number
): Effect.Effect<RecoveredClaim | undefined> =>
  Effect.gen(function*() {
    if (row.claim === null || row.claimedAtMs === null || sameOwner(row.claim, driver.dependencies.owner)) {
      return undefined
    }
    if (!(row.claimedAtMs < nowMs - Duration.toMillis(Ownership.heartbeatStaleAfter))) return undefined
    if (
      yield* driver.isAlive(row.claim, {
        claimant: driver.dependencies.owner,
        heartbeatAtMs: row.claimedAtMs,
        nowMs
      })
    ) return undefined
    const recovered = yield* driver.store.recoverClaim(
      row.runId,
      row.claim,
      row.claimedAtMs,
      driver.dependencies.owner,
      nowMs,
      { expectedOwner: row.claim, checkedAtMs: nowMs, kind: livenessEvidenceKind(driver, row.claim) }
    ).pipe(Effect.orDie)
    return recovered._tag === "Recovered" ? { claimant: row.claim, claimedAtMs: row.claimedAtMs } : undefined
  })

/**
 * Activates a claimed run.
 *
 * The activation CAS and the decision recording it commit together: a crash
 * between them left a run durably running under this owner with no journal
 * entry saying who took it.
 */
const activate = (
  driver: Driver,
  row: RunStore.RunRow,
  expected: RunStore.RunSnapshot,
  claimedAtMs: number,
  takeover: Takeover
) =>
  driver.transactState(
    Effect.gen(function*() {
      // Admission can change without changing the ownership snapshot
      // (a released→running→released ABA, rewind, or consent change).
      // Recheck its read-only native fence under the writer transaction;
      // loading modules and probing external hosts remain preflight work.
      if (
        driver.dependencies.canActivate !== undefined &&
        !(yield* driver.dependencies.canActivate(yield* driver.store.get(row.runId).pipe(Effect.orDie)))
      ) {
        return { _tag: "SnapshotChanged" as const }
      }
      // Another owner can quarantine and return to the same suspended
      // snapshot between preflight and claim. Fence that park in the
      // activation transaction too; the rejected claim is abandoned below.
      if (row.cancelRequestedAtMs === null && (yield* isQuarantined(driver, row.runId))) {
        return { _tag: "SnapshotChanged" as const }
      }
      const activation = yield* driver.store.activate(
        row.runId,
        driver.dependencies.owner,
        claimedAtMs,
        expected
      ).pipe(Effect.orDie)
      if (activation._tag !== "Activated") {
        return activation
      }
      yield* emitDecision(driver, row.runId, {
        decision: row.status === "running" ? "stolen-and-activated" : "claimed-and-activated",
        previousStatus: row.status,
        owner: driver.dependencies.owner,
        // What admitted the takeover, so an operator reading the journal
        // can tell a lease that simply expired from a probe that
        // positively reported the owner gone.
        ...(takeover.evidence === undefined ? {} : { evidence: takeover.evidence }),
        ...(takeover.recoveredClaim === undefined ? {} : { recoveredClaim: takeover.recoveredClaim })
      })
      return activation
    }),
    { partition: row.runId }
  ).pipe(Effect.orDie)

/**
 * Collects other rounds and transitive descendants of the logical run.
 *
 * Round membership and the edge table represent the logical job that every
 * owner process and every restart can see (issues #40/#41), which is
 * exactly why the cascade reads it instead of an in-process instance map:
 * a cross-process cancellation is observed by a driver that never spawned
 * the children and holds no `FlowInstance` for any of them.
 *
 * Deduplicated by run id, so the diamond the edge set permits is visited
 * once and a (rejected, but defensively handled) cycle terminates. Work and
 * memory are bounded by the finite durable edge set; there is deliberately
 * no arbitrary fan-out cap, because truncating a wide generation would
 * leave linked children uncancelled forever.
 */
const descendantsOf = (driver: Driver, runId: string) => driver.lifecycle.descendants(runId)

/**
 * Records a durable cancellation request against every linked descendant
 * of a cancelled run.
 *
 * `requestCancel` is unfenced and first-writer-wins, so this is idempotent
 * by construction: re-running the cascade — a re-drive, a second operator
 * cancel, a child that also cascades from its own cancellation — writes
 * nothing the second time and answers `AlreadyRequested`. A row that no
 * longer exists answers `NotFound`, which is equally fine.
 *
 * `cancelOwned` calls it inside the same transaction as the parent's
 * terminal `cancelled` transition, so a crash cannot commit a cancelled
 * parent whose children were never asked to stop.
 *
 * Both callers record the run's OWN cancellation BEFORE this walk —
 * `interrupt` writes the request, `cancelOwned` commits the terminal
 * `cancelled` transition — and that order is load-bearing rather than
 * incidental. A late admission inherits by reading the parent row after it
 * has created the child row (`inheritParentCancellation`), so a walk that
 * ran before the parent was marked could miss an edge whose admission also
 * missed the mark. Both the SQL engine state and
 * `DurableEngineState.makeMemory` serialize their transactions. The memory
 * implementation snapshots and restores its maps on failure; the shared
 * writer transaction supplies the run-store write boundary. The ordering
 * also lets a child admitted within the cascade inherit cancellation.
 */
const requestCancelDescendants = (
  driver: Driver,
  runId: string,
  nowMs: number
): Effect.Effect<ReadonlyArray<string>, RunStore.RunStoreError> =>
  Effect.gen(function*() {
    const descendants = yield* descendantsOf(driver, runId)
    yield* Effect.forEach(
      descendants,
      (childId) => requestCancellation(driver, childId, nowMs),
      { discard: true }
    )
    return descendants
  })

/** The exit policy a child recorded for itself when it was spawned. */
const exitPolicyOf = (row: RunStore.RunRow): Effect.Effect<OnParentExit> =>
  decodeState(row.stateJson).pipe(
    // A row written before the policy existed, or created outside
    // `ensureRun` (a seeded edge, an external admission), names none. It
    // is a LINKED child either way, and the contract for a linked child is
    // that it ends with the run it belongs to; `detach` is the deliberate
    // exception and has to be recorded to hold.
    Effect.map((state) => state.onParentExit ?? "cancel")
  )

/** What a run's terminal exit decided for its linked children. */
interface ChildExits {
  readonly cancelled: Array<string>
  readonly detached: Array<string>
}

/**
 * Applies the per-child exit policy when a run ends on its own terms.
 *
 * Cancellation is not this path. A cancelled run cascades to every linked
 * descendant unconditionally (`requestCancelDescendants`): an operator who
 * cancels a run is asking for the subtree to stop, and a child cannot opt
 * out of that. What this closes is the other half — a parent that
 * COMPLETED or FAILED used to leave every linked child running, so a
 * `.child()` boundary whose parent died on an unrelated branch left a
 * durable orphan nothing would ever wait for or cancel.
 *
 * Three shapes are left alone, and each for its own reason:
 *
 * - A child that recorded `detach` was spawned fire-and-forget. Outliving
 *   the parent is the whole point, so it is reported, not touched, and its
 *   own subtree is not walked — those runs hang off a run that is still
 *   going.
 * - A child that already settled has nothing to cancel, and it applied
 *   this same policy to its own children when it settled.
 * - A child whose row is gone leaves only an edge.
 *
 * The requests are written by the caller's transaction — the parent's
 * terminal compare-and-swap — so a crash cannot commit a completed parent
 * whose children were never asked to stop.
 */
const endLinkedChildren = (
  driver: Driver,
  runId: string,
  nowMs: number
): Effect.Effect<
  {
    readonly cancelled: ReadonlyArray<string>
    readonly detached: ReadonlyArray<string>
  },
  RunStore.RunStoreError
> =>
  Effect.gen(function*() {
    const roots = (yield* driver.lifecycle.rounds(runId)).map((row) => row.runId)
    const seen = new Set<string>(roots)
    const exits: ChildExits = { cancelled: [], detached: [] }
    let frontier: ReadonlyArray<string> = roots
    while (frontier.length > 0) {
      frontier = yield* endGeneration(driver, frontier, seen, exits)
    }
    yield* Effect.forEach(
      exits.cancelled,
      (childId) => requestCancellation(driver, childId, nowMs),
      { discard: true }
    )
    return exits
  })

/**
 * Decides every unseen child of one generation of the walk, answering the
 * next generation: the rounds of every child that ends with its parent.
 */
const endGeneration = (
  driver: Driver,
  parents: ReadonlyArray<string>,
  seen: Set<string>,
  exits: ChildExits
): Effect.Effect<ReadonlyArray<string>, RunStore.RunStoreError> =>
  Effect.gen(function*() {
    const next: Array<string> = []
    for (const parentId of parents) {
      for (const edge of yield* driver.engineState.runChildren(parentId)) {
        if (seen.has(edge.childId)) continue
        next.push(...(yield* endChild(driver, edge.childId, seen, exits)))
      }
    }
    return next
  })

/**
 * Decides one child: a settled child is left alone, a detached one is
 * reported, and an attached one has every unsettled round of its lineage
 * cancelled. Answers the rounds whose own children the walk visits next.
 */
const endChild = (
  driver: Driver,
  childId: string,
  seen: Set<string>,
  exits: ChildExits
): Effect.Effect<ReadonlyArray<string>, RunStore.RunStoreError> =>
  Effect.gen(function*() {
    const rounds = yield* lockedRounds(driver, childId)
    for (const round of rounds) seen.add(round.runId)
    seen.add(childId)
    if (rounds.every((round) => isSettled(round.status))) return []
    // The edge belongs to the creating round. Its ownership policy
    // survives the child's handoffs; do not infer it from a later
    // round written by a version that omitted onParentExit.
    // A nonempty lineage read includes its requested member.
    if ((yield* exitPolicyOf(rounds.find((round) => round.runId === childId)!)) === "detach") {
      exits.detached.push(childId)
      return []
    }
    for (const round of rounds) {
      if (!isSettled(round.status)) exits.cancelled.push(round.runId)
    }
    return rounds.map((round) => round.runId)
  })

/**
 * Reads the rounds of `runId`'s lineage after joining every round's
 * partition, so no round's row changes under the decision the caller makes
 * from them: a parent's transition writes its own partition, and a child's
 * status is its own run's to change. A round that appeared meanwhile, by a
 * handoff that committed before its predecessor was joined, is joined and the
 * lineage read again.
 */
const lockedRounds = (driver: Driver, runId: string) =>
  Effect.gen(function*() {
    const joined = new Set<string>()
    while (true) {
      const rounds = yield* driver.lifecycle.rounds(runId)
      const unjoined = rounds.filter((round) => !joined.has(round.runId))
      if (unjoined.length === 0) return rounds
      for (const round of unjoined) {
        yield* driver.writer.write(Effect.void, { partition: round.runId }).pipe(Effect.orDie)
        joined.add(round.runId)
      }
    }
  })

/**
 * The effect a terminal transition runs inside its own transaction to end
 * the children it is responsible for, journaling what it decided.
 *
 * The record is emitted only when there was a linked child to decide
 * about, so an ordinary childless run adds nothing to its journal.
 */
const applyChildExitPolicy = (driver: Driver, runId: string): Effect.Effect<void> =>
  Effect.gen(function*() {
    const nowMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
    const outcome = yield* endLinkedChildren(driver, runId, nowMs).pipe(Effect.orDie)
    if (outcome.cancelled.length === 0 && outcome.detached.length === 0) return
    yield* emitDecision(driver, runId, {
      decision: "child-policy-applied",
      appliedAtMs: nowMs,
      cancelled: outcome.cancelled,
      detached: outcome.detached
    })
  })

/**
 * Carries a parent's durable cancellation onto a child that was linked
 * AFTER the parent's cascade had already run.
 *
 * Admission and cancellation are two separate serialized write
 * transactions over the same store, so they interleave in both orders and
 * neither order may leak a live child (issue #83):
 *
 * - Admission first. The edge is committed before the cancellation
 *   transaction opens, so `requestCancelDescendants` sees the child and
 *   requests it. Nothing more is needed here.
 * - Cancellation first. The cascade walked `flows_run_parents` while the
 *   edge did not exist yet, so it could not have seen this child — and
 *   the parent's drive may already be gone, so nothing will walk the
 *   edge table again on its behalf. The child would be created fresh and
 *   uncancelled, and would run to completion under a cancelled parent.
 *
 * The second order is closed by reading the parent row inside the SAME
 * outer storage transaction that recorded the edge and created the child
 * row, after the child row exists. Either the cancellation transaction
 * committed before this read, in which case the request is visible here
 * and is inherited atomically with the child's own creation, or it has
 * not committed yet, in which case it commits after this transaction and
 * its own cascade sees the edge. There is no third interleaving, so no
 * ephemeral hand-off flag and no timing-based retry is involved. The
 * argument rests on the store's serialized writes and the order inside
 * `requestCancelDescendants`: a cancellation marks its own run before it
 * walks the edge table. Memory durable-state transactions also serialize
 * access and restore their snapshots on failure; they do not provide
 * persistence across process crashes.
 *
 * Nesting falls out of this: the inherited request is written to the
 * child's own row, so a grandchild admitted later reads a cancel-requested
 * parent and inherits in turn.
 *
 * `requestCancel` is unfenced and first-writer-wins, so a repeated
 * admission writes nothing the second time; a parent row that is gone,
 * or one with no rounds at all, inherits nothing. Both ways a parent can
 * exit are inherited here, and they differ in whether the child's own
 * `onParentExit` can spare it. An explicit cancellation in ANY round is
 * inherited unconditionally, whether it is a pending
 * `cancel_requested_at_ms` or a round already settled terminally
 * `cancelled` whose request column a compaction could have cleared. A
 * parent that instead stopped normally, with EVERY round `completed` or
 * `failed`, cancels a late child that was admitted attached and leaves an
 * `onParentExit === "detach"` child to outlive it.
 *
 * The child does not need its own cascade here: it was just created, so
 * it has no descendants of its own, and once it observes the inherited
 * request `cancelOwned` cascades from it like any other cancellation.
 */
const inheritParentCancellation = (driver: Driver, parentId: string, childId: string): Effect.Effect<void> =>
  Effect.gen(function*() {
    const rounds = yield* driver.lifecycle.rounds(parentId).pipe(Effect.orDie)
    if (rounds.length === 0) return
    const cancelled = rounds.find((round) => round.cancelRequestedAtMs !== null || round.status === "cancelled")
    if (cancelled !== undefined) {
      // The parent's own request timestamp, so the inherited request reads
      // as the same operator intent rather than as a later, independent one.
      const nowMs = cancelled.cancelRequestedAtMs ?? (yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor)))
      yield* requestCancellation(driver, childId, nowMs).pipe(Effect.orDie)
      return
    }
    // The same interleaving, for the other way a parent stops: a parent
    // that had already COMPLETED or FAILED ran `applyChildExitPolicy`
    // before this edge existed, so its walk could not have seen this
    // child and nothing will walk again on its behalf. The child applies
    // its own recorded policy here instead, in the transaction that made
    // it a child, so an attached child admitted a moment too late cannot
    // run on under a parent that is already gone.
    if (rounds.some((round) => round.status !== "completed" && round.status !== "failed")) return
    // Admission reads the child's recorded policy in this transaction.
    // A later caller awaiting a detached execution cannot change the
    // policy chosen by its original spawn.
    if ((yield* exitPolicyOf(yield* driver.store.get(childId).pipe(Effect.orDie))) === "detach") {
      return
    }
    yield* requestCancellation(driver, childId, yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))).pipe(
      Effect.orDie
    )
  })

/**
 * Closes an owned run `cancelled`: commits the terminal transition with
 * everything that has to commit with it, then releases the run's parked
 * scope and wakes the children and parents the cancellation reaches.
 */
const cancelOwned = (
  driver: Driver,
  runId: string,
  state: RunState
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const interruptedAtMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
    const stateJson = yield* encodeState({
      ...withoutResult(state),
      cancellation: { interruptedAtMs }
    })
    const { settled, cascaded } = yield* commitCancellation(driver, runId, stateJson, interruptedAtMs)
    if (settled) yield* recordSettled(driver, runId, state, { outcome: "cancelled", code: "cancelled" })
    // Post-commit, and only reachable after a transition that actually
    // happened. Closing the parked flow scope runs the finalizers the
    // suspension retained, with an interrupt exit so `Flow.withRollback`
    // compensations fire — cancellation is exactly the unsuccessful exit
    // they exist for. The run is durably cancelled first, so a crash
    // inside a finalizer cannot resurrect it.
    yield* releaseRetainedScope(driver, runId, Exit.failCause(Cause.interrupt()))
    // Waking a cascaded child is in-process scheduling: a child this
    // process owns or has parked re-enters claim/activate now and the
    // activation cancel guard closes it, instead of waiting out a poll
    // interval. A child owned elsewhere ignores the wake and is reached by
    // its own owner's cancel poll or by that owner's parked-run sweep.
    if (cascaded.length > 0) {
      yield* Effect.forEach(cascaded, (childId) => driver.coordinator.wake(childId), { discard: true })
    }
    // A cancelled round is a terminal settlement like a completed or
    // failed one, so every parent already parked on it — through any round
    // of its lineage — is woken to read the cancellation (#2758). Only
    // after the transition this call committed: a lost fence woke nobody.
    if (settled) {
      yield* announceSettled(driver, runId, state)
    }
  })

/**
 * Commits a run's `cancelled` transition in one transaction with its
 * cascade to linked children, its timers, its waiting row, and its
 * interruption record. Answers whether the transition happened, and which
 * children it asked to stop.
 */
const commitCancellation = (
  driver: Driver,
  runId: string,
  stateJson: string,
  interruptedAtMs: number
): Effect.Effect<{ readonly settled: boolean; readonly cascaded: ReadonlyArray<string> }> =>
  driver.transactState(
    Effect.gen(function*() {
      yield* driver.store.acknowledgeCancel(runId, driver.dependencies.owner, interruptedAtMs).pipe(Effect.orDie)
      const transitioned = yield* driver.store.transitionOwned(
        runId,
        driver.dependencies.owner,
        "cancelled",
        stateJson
      ).pipe(Effect.orDie)
      if (transitioned._tag !== "Transitioned") return { settled: false, cascaded: [] }
      // Cancellation cascades to linked children (`Flow.interrupt` is
      // documented to preserve "child-flow handling"). It is recorded
      // durably, in this transaction, off the durable edge table, so the
      // cascade is identical whether the cancellation was requested in
      // this process or observed from another one — the pre-existing
      // in-process linkage in `FlowEngine.make` fires off the ephemeral
      // `instance.interrupted` flag, which a durable observation never
      // sets and a second driver instance never has.
      const cascaded = yield* requestCancelDescendants(driver, runId, interruptedAtMs)
      // The run has no future, so neither do its timers. Completing the
      // clock rows in this transaction is what stops a durable timer
      // from outliving the run it belongs to: the sweep queries already
      // skip a settled run's rows, and this stops them being pending at
      // all — including under an in-memory state with no run view to
      // join against.
      yield* completeRunClocks(driver, runId, interruptedAtMs)
      // A cancel can race the final poll after the run already parked
      // (park precedes the guarded terminal CAS). Clear the waiting row so
      // the terminally cancelled run never surfaces to a sweeper again
      // (issue #28). It shares the transition's transaction, so a crash
      // can no longer land between them.
      yield* driver.engineState.wake(runId).pipe(Effect.asVoid)
      // Durable channel (issue #10): the interruption record must survive
      // the process exiting right after cancellation. Unfenced because the
      // `cancelled` transition above has already released ownership; the
      // fence is the transition CAS itself, which now commits with this
      // record rather than before it.
      yield* driver.journal.emitDurableUnfenced(
        JournalRecords.interrupted({
          runId,
          lineageId: FlowEngine.Lineage.root(runId),
          sourceId: driver.dependencies.journalSource
        }, {
          outcome: "cancelled",
          interruptedAtMs,
          owner: driver.dependencies.owner,
          executionFact: yield* driver.executionFacts.fact(runId),
          ...(cascaded.length === 0 ? {} : { cascadedTo: cascaded })
        })
      ).pipe(Effect.orDie)
      return { settled: true, cascaded }
    })
    // The cascade reads every descendant's row to decide, so a cancellation
    // takes the schema's lock.
  ).pipe(Effect.orDie)

/**
 * The waiting reason an interrupted round parks under.
 *
 * A flow that has ALREADY asked to suspend is parked, not released. The
 * round's own settlement derives the same three answers
 * ({@link parkReason}), and losing the race to a
 * shutdown must not lose the classification with it: a `released` row
 * carries no wake time and no token, so a run that suspended on a
 * 150-second clock came back as a run whose owner merely went away, and
 * the sweeper had to re-drive it blind instead of waking it when its
 * deadline fell due (release rehearsal).
 *
 * A flow that has NOT asked to suspend is a genuine shutdown or heartbeat
 * self-interrupt, and `released` is exactly what it is (issue #39).
 */
const interruptedWaiting = (
  driver: Driver,
  runId: string,
  instance: FlowRuntime.FlowInstance["Service"] | undefined
): Effect.Effect<DurableEngineState.Waiting> =>
  Effect.gen(function*() {
    if (instance === undefined || !instance.suspended) return { reason: "released" } as const
    const declared = instance.waiting
    if (declared !== undefined) return declared
    const pendingClocks = yield* driver.engineState.pendingClocks({ executionId: runId })
    return pendingClocks.length > 0
      ? {
        reason: "timer",
        wakeAt: Math.min(...pendingClocks.map((clock) => clock.dueAtMs))
      } as const
      : { reason: "event" } as const
  })

/**
 * Releases an interrupted run reclaimably instead of closing it
 * (issue #26). A drive-fiber interruption is not evidence of operator
 * cancellation — process shutdown closes the coordinator scope, and the
 * heartbeat loop self-interrupts on any heartbeat error — so the run
 * transitions back to `suspended` while the fence is still validly held,
 * leaving it claimable by any worker (Temporal worker-shutdown
 * semantics). On genuine fence loss the owned transition fails
 * harmlessly.
 */
const releaseOwned = (
  driver: Driver,
  runId: string,
  state: RunState,
  cause: ReleaseCause,
  round?: {
    readonly flow: Flow.Any
    readonly instance: FlowRuntime.FlowInstance["Service"]
  } | undefined
): Effect.Effect<void> =>
  Effect.gen(function*() {
    // Park atomically with releasing ownership (`park` is owner-fenced). The
    // durable waiting row is what makes a released run visible to the
    // parked-run sweeper: without it nothing ever re-drives the run and
    // a durable `requestCancel` against it is write-only forever
    // (issue #39). On genuine fence loss the park reports NotFound
    // harmlessly, exactly like the transition below.
    const waiting = yield* interruptedWaiting(driver, runId, round?.instance)
    // A run whose flow asked to suspend carries the suspension on its row,
    // exactly as the round's own settlement writes it. `poll` publishes a
    // state with no `result` as "not settled yet", so a park recorded
    // without one was invisible to every resumer: `AgentSession`'s
    // `awaitParked` polls `poll` and answers `unknown` for anything but a
    // published `Suspended`, so `smithers approve` and `smithers run
    // --resume` accepted the request and then drove nothing in the release rehearsal.
    const suspension = round !== undefined && waiting.reason !== "released"
      ? (yield* encodeResult(
        round.flow,
        new Flow.Suspended({ cause: round.instance.cause })
      )).encoded
      : undefined
    yield* transitionAndRecord(
      driver,
      runId,
      "suspended",
      yield* encodeState(
        suspension === undefined
          ? withoutResult(state)
          : { ...withoutResult(state), result: suspension }
      ),
      // Why the run was released (#3328): an operator reading a parked run
      // must be able to tell a lapsed lease on a live host from a shutdown.
      { decision: "interrupt-released", owner: driver.dependencies.owner, cause },
      undefined,
      undefined,
      waiting
    )
  })

/**
 * Discriminates an interruption cause by durable state: only an
 * interruption backed by a recorded cancel request closes the run;
 * anything else releases it for reclaim (issue #26), under the waiting
 * reason the flow had already declared for itself when it has one.
 */
const settleInterrupted = (
  driver: Driver,
  runId: string,
  state: RunState,
  cause: ReleaseCause,
  round?: {
    readonly flow: Flow.Any
    readonly instance: FlowRuntime.FlowInstance["Service"]
  } | undefined
): Effect.Effect<void> =>
  driver.store.get(runId).pipe(
    Effect.flatMap((row) => {
      // Shutdown can arrive after the claim CAS but before activation, or
      // after activation but before/after the execution race. Release only
      // this incarnation's persisted fence; a settled or foreign row stays
      // untouched, including its waiting reason.
      if (row.claim !== null && row.claimedAtMs !== null && sameOwner(row.claim, driver.dependencies.owner)) {
        return abandon(driver, runId, row.claimedAtMs)
      }
      if (row.status !== "running" || row.owner === null || !sameOwner(row.owner, driver.dependencies.owner)) {
        return Effect.void
      }
      return row.cancelRequestedAtMs !== null
        ? cancelOwned(driver, runId, state)
        : releaseOwned(driver, runId, state, cause, round)
    }),
    Effect.catch((error) => error.code === "not_found_row" ? Effect.void : Effect.die(error))
  )

/**
 * Encodes a settlement for the row, and never fails.
 *
 * The encode used to be guarded with `Effect.orDie`, which made a
 * settlement the flow's own codec rejects fatal for the drain rather than
 * terminal for the run. `agent/run` declares both channels
 * `Schema.Unknown`, so every `Data.TaggedError` an agent body fails with
 * is such a settlement, and the release validation watched the whole
 * chain: the drain died with `SchemaError: Expected JSON value at
 * ["exit"]["cause"][0]["error"]`, `engine.db` kept the run `running`
 * under a pid that had exited while `control.db` said `failed`, and the
 * next process's stale-running sweep stole the row and billed the
 * provider seat a second time. `ExitEncoding.encode` fails closed
 * instead: on rejection it answers a JSON projection of the settlement
 * and a `note`, and a noted settlement is written `failed`.
 */
const encodeResult = (
  flow: Flow.Any,
  result: Flow.Result<unknown, unknown>
): Effect.Effect<ExitEncoding.EncodedResult> => ExitEncoding.encode(flow, result)

/**
 * Re-encodes a handoff payload through the target flow's own codec, so the
 * bytes the next round's row holds are the bytes `ensureRun` would write
 * for the same invocation.
 */
const normalizePayload = (
  flow: Flow.Any,
  payload: unknown
): Effect.Effect<unknown> => {
  const codec = Schema.toCodecJson(flow.payloadSchema)
  return (Schema.decodeUnknownEffect(codec)(payload).pipe(
    Effect.orDie,
    Effect.flatMap((decoded) => Schema.encodeEffect(codec)(decoded)),
    Effect.orDie
  ) as Effect.Effect<unknown>)
}

/** One run row to create, and what to record once it exists. */
interface RunCreation {
  readonly flowName: string
  readonly executionId: string
  readonly stateJson: string
  readonly payload: unknown
  readonly lineageId: string
  readonly roundOrdinal: number
  readonly parentRunId?: string | undefined
  /** The authority the new row would persist, which a join must cover. */
  readonly capabilityCeilings: NonNullable<RunState["capabilityCeilings"]>
  /** The retry the new row would be, which a join must be too. */
  readonly retryFrom?: RunState["retryFrom"] | undefined
  readonly onCreated: Effect.Effect<void, never, never>
}

/** The field an existing row disagrees on, and how. */
type IdentityConflict = Pick<FlowEngine.ExecutionIdentityConflict, "field" | "expected" | "actual">

/**
 * Creates one run row, tolerating only an existing row with identical
 * execution identity and encoded invocation data.
 */
const ensureCreatedRun = (driver: Driver, options: RunCreation): Effect.Effect<void, never, never> =>
  Effect.gen(function*() {
    const created = yield* driver.store.create(options.executionId, options.stateJson, {
      ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
      lineageId: options.lineageId,
      roundOrdinal: options.roundOrdinal
    }).pipe(Effect.exit)
    if (Exit.isSuccess(created)) {
      return yield* options.onCreated
    }

    // A cause carrying no `Fail` reason — an interrupt-only cause, or a
    // bare defect — used to reach `Option.getOrThrow(Exit.findErrorOption(...))`,
    // which threw a raw `NoSuchElementError` defect and discarded the
    // original cause. A caller that interrupted the fiber while
    // `store.create` was inside its write transaction saw a crash rather
    // than the cancellation it asked for. `Cause.findFail` hands back
    // that residual cause typed `Cause<never>`, so re-raising it verbatim
    // keeps an interrupt an interrupt (issue #151).
    const failure = Cause.findFail(created.cause)
    if (Result.isFailure(failure)) {
      return yield* Effect.failCause(failure.failure)
    }
    const error = failure.success.error
    if (!(error instanceof RunStore.RunStoreError) || error.code !== "constraint") {
      return yield* Effect.die(error)
    }
    const existing = yield* driver.store.get(options.executionId).pipe(Effect.orDie)
    const conflict = identityConflict(options, existing, yield* decodeState(existing.stateJson))
    if (conflict === undefined) return
    return yield* Effect.die(
      new FlowEngine.ExecutionIdentityConflict({
        executionId: options.executionId,
        status: existing.status,
        ...conflict,
        message: conflict.field === "payload"
          ? `execution ${options.executionId} was started with a different input; ` +
            "choose a new executionId to run this input"
          : `execution ${options.executionId} already belongs to ${conflict.field} identity ` +
            `${conflict.expected}; it cannot be reused for ${conflict.actual}`
      })
    )
  })

/** How an identity conflict names a run's retry: its source and step, or none. */
const retryName = (retry: RunState["retryFrom"]): string =>
  retry === undefined ? "no retry" : `a retry of ${retry.source} from ${retry.step ?? "its end"}`

/** The first way an existing row's identity differs from the one requested, if any. */
const identityConflict = (
  options: RunCreation,
  existing: RunStore.RunRow,
  persisted: RunState
): IdentityConflict | undefined => {
  if (persisted.flowName !== options.flowName) {
    return { field: "flow", expected: persisted.flowName, actual: options.flowName }
  }
  // A retry joins only the retry of the same source from the same step. A
  // plain admission names no retry and joins whatever run holds the id.
  if (options.retryFrom !== undefined && retryName(persisted.retryFrom) !== retryName(options.retryFrom)) {
    return { field: "retry", expected: retryName(persisted.retryFrom), actual: retryName(options.retryFrom) }
  }
  if (!samePayload(persisted.payload, options.payload)) {
    return {
      field: "payload",
      expected: "the encoded payload the execution was admitted with",
      actual: "a different encoded payload"
    }
  }
  if (
    !FlowEngine.joinable(
      // A row with no persisted authority ran unrestricted, and is
      // refused further dispatch; only an unrestricted caller joins it.
      persisted.capabilityCeilings ?? [],
      options.capabilityCeilings
    )
  ) {
    return {
      // A join answers the result the admitted authority produced.
      field: "capabilities",
      expected: "a capability ceiling covering the one the execution was admitted with",
      actual: "a capability ceiling that does not cover it"
    }
  }
  if (existing.lineageId !== options.lineageId) {
    return { field: "lineage", expected: existing.lineageId ?? "no lineage", actual: options.lineageId }
  }
  if (existing.roundOrdinal !== options.roundOrdinal) {
    return { field: "round", expected: String(existing.roundOrdinal), actual: String(options.roundOrdinal) }
  }
  // An omitted parent is deliberately compatible with any persisted parent
  // when joining an already-created root.
  if (options.parentRunId !== undefined && existing.parentRunId !== options.parentRunId) {
    return { field: "parent", expected: existing.parentRunId ?? "no parent", actual: options.parentRunId }
  }
  return undefined
}

/**
 * Observes a durably recorded cancellation request
 * (`RunStore.requestCancel` / `cancel_requested_at_ms`) from another
 * process. Polls on the heartbeat cadence — the request is unfenced, so
 * only the owner can act on it, and it must act within a poll interval
 * (issue #11). Completes when a request is observed; races against the
 * flow like the heartbeat loop.
 */
const cancelPollLoop = (driver: Driver, executionId: string): Effect.Effect<CancelRequested> =>
  Effect.gen(function*() {
    // Check-first: a request that raced in just before activation is
    // observed without waiting out a full heartbeat (issue #27).
    while (true) {
      const requested = yield* driver.store.get(executionId).pipe(
        Effect.map((row) => row.cancelRequestedAtMs !== null),
        Effect.catch(() => Effect.succeed(false))
      )
      if (requested) {
        yield* driver.store.acknowledgeCancel(
          executionId,
          driver.dependencies.owner,
          yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
        ).pipe(Effect.orDie)
        return cancelRequested
      }
      yield* Effect.sleep(Ownership.heartbeatInterval)
    }
  })

/**
 * What one handoff has to settle: the round that produced it, the row it
 * runs under (which carries the lineage columns), the state it was
 * activated with, its declaration, and the invocation it named.
 */
interface HandoffSeam {
  readonly executionId: string
  readonly row: RunStore.RunRow
  readonly state: RunState
  readonly flow: Flow.Any
  readonly handoff: Flow.Handoff
}

/** The round a handoff opens: its place in the lineage and its execution id. */
interface Successor {
  readonly round: FlowEngine.Round.Round
  readonly executionId: string
}

/**
 * Opens the next round, and closes this one, in ONE transaction.
 *
 * `ensureRun`'s parent-edge/run-row pairing (issue #80) is the precedent
 * and the reason: a crash between the two writes would leave a terminal
 * round whose successor was never created, and nothing would ever look for
 * it again — the lineage would end silently at a round that says it handed
 * off. The stores' own writes become savepoints of this transaction, so
 * either both commit or neither.
 *
 * The next round is a run row chained through the RESERVED
 * `parent_run_id` column, not a `flows_run_parents` edge: that table is
 * the subflow DAG cycle detection walks, and a round is the same run
 * continuing rather than a child being spawned
 * (`packages/smithers/flows/engine/docs/concepts/trampoline-rounds.md`).
 */
const continueLineage = (driver: Driver, seam: HandoffSeam, advanced: Successor): Effect.Effect<void> =>
  Effect.gen(function*() {
    const target = driver.registrations.get(seam.handoff.flow)?.at(-1)
    const payload = yield* successorPayload(seam, target)
    const nextCeilings = successorCeilings(seam, target)
    const nextStateJson = yield* encodeState(successorState(seam, payload, nextCeilings))
    const settledStateJson = yield* encodeState({
      ...seam.state,
      result: (yield* encodeResult(seam.flow, seam.handoff)).encoded
    })
    const committed = yield* Effect.result(
      commitHandoff(driver, seam, advanced, { payload, nextCeilings, nextStateJson, settledStateJson })
    )
    if (Result.isFailure(committed)) {
      if (committed.failure._tag === "HandoffCancelled") {
        yield* cancelOwned(driver, seam.executionId, seam.state)
      }
      return
    }
    // The root caller follows the lineage itself, but a discarded (or
    // orphaned) one does not exist to follow it, so the successor is woken
    // here rather than left for a sweep that has no reason to look at it.
    yield* driver.coordinator.wake(advanced.executionId)
  })

/**
 * The handoff payload, as the next round's row holds it.
 *
 * The handoff payload travels encoded, and the next round's row has to
 * hold the same value `ensureRun` would write for it: the root caller
 * re-enters `execute` for this round, and its identical-create check
 * compares encoded payloads structurally, so object key order cannot
 * separate two encodings of the same value. The execution id itself
 * uses canonical RFC 8785 JSON, so the identity and payload checks
 * agree by construction.
 *
 * A target this process does not run has no codec to normalize
 * through, and the round is still created with the payload verbatim —
 * the same posture the wake path takes for an unregistered flow, and
 * the reason a lineage survives a worker that only knows some of its
 * legs.
 */
const successorPayload = (seam: HandoffSeam, target: Registration | undefined): Effect.Effect<unknown> =>
  target === undefined
    ? Effect.succeed(seam.handoff.payload)
    : normalizePayload(target.flow, seam.handoff.payload)

/** The authority the next round runs under: this round's, narrowed by the handoff and the target's declaration. */
const successorCeilings = (
  seam: HandoffSeam,
  target: Registration | undefined
): NonNullable<RunState["capabilityCeilings"]> => [
  // The execution guard rejects missing persisted authority before a handler can hand off.
  ...seam.state.capabilityCeilings!,
  ...(seam.handoff.capabilityCeilings ?? [[]]),
  // The successor records its own declaration, as admission would, so
  // a later join compares against the authority it actually runs
  // under. A target this process does not run has none here; the root
  // caller's re-entry then carries a declaration the row lacks and is
  // refused rather than trusted.
  ...(target === undefined
    ? []
    : Flow.parseCapabilityCeilings(Flow.capabilityCeilings(target.flow.annotations)))
]

/** The next round's opening state: the lineage's settings, carried forward. */
const successorState = (
  seam: HandoffSeam,
  payload: unknown,
  capabilityCeilings: NonNullable<RunState["capabilityCeilings"]>
): RunState => ({
  version: 1,
  flowName: seam.handoff.flow,
  payload,
  capabilityCeilings,
  ...(seam.state.parentExecutionId === undefined
    ? {}
    : { parentExecutionId: seam.state.parentExecutionId }),
  ...(seam.state.onParentExit === undefined ? {} : { onParentExit: seam.state.onParentExit }),
  ...(seam.state.maxRounds === undefined ? {} : { maxRounds: seam.state.maxRounds }),
  ...(seam.handoff.deadline === undefined ? {} : { deadline: seam.handoff.deadline }),
  // The lineage keeps its first round's origin, so its settlement is
  // labelled and timed from the first admission.
  ...(seam.state.origin === undefined ? {} : { origin: seam.state.origin })
})

/** What a handoff writes: the successor's row and this round's settlement. */
interface HandoffWrite {
  readonly payload: unknown
  readonly nextCeilings: NonNullable<RunState["capabilityCeilings"]>
  readonly nextStateJson: string
  readonly settledStateJson: string
}

/**
 * Creates the successor and settles this round `completed`, failing with
 * `HandoffCancelled` when a cancellation won the race and `HandoffFenceLost`
 * when the round is no longer this driver's.
 */
const commitHandoff = (driver: Driver, seam: HandoffSeam, advanced: Successor, write: HandoffWrite) =>
  driver.transactState(
    Effect.gen(function*() {
      // The next round's id is DERIVED from (lineage, ordinal), so a
      // re-drive finds the exact row it already opened. Only an
      // identical create is tolerated; a collision in flow, payload,
      // parent, lineage, or ordinal is a defect.
      yield* ensureCreatedRun(driver, {
        flowName: seam.handoff.flow,
        executionId: advanced.executionId,
        stateJson: write.nextStateJson,
        payload: write.payload,
        lineageId: advanced.round.rootExecutionId,
        roundOrdinal: advanced.round.ordinal,
        parentRunId: seam.executionId,
        capabilityCeilings: write.nextCeilings,
        onCreated: emitDecision(driver, advanced.executionId, {
          decision: "created",
          state: JSON.parse(write.nextStateJson),
          lineageId: advanced.round.rootExecutionId,
          roundOrdinal: advanced.round.ordinal,
          parentExecutionId: seam.executionId
        })
      })
      // DECIDED (2026-08-11, pending review): a handed-off round settles
      // `completed`. The round did finish, and adding a `Continued`
      // status would widen every status reader for a distinction the
      // `handed-off` decision and lineage columns already record.
      //
      // DECIDED (2026-08-11, pending review): cancellation guards the
      // handoff transition. If it raced the last poll, failing the outer
      // transaction rolls successor creation back before the ordinary
      // cancellation path closes the owned round.
      const transitioned = yield* transitionAndRecord(
        driver,
        seam.executionId,
        "completed",
        write.settledStateJson,
        {
          decision: "handed-off",
          status: "completed",
          flow: seam.handoff.flow,
          lineageId: advanced.round.rootExecutionId,
          roundOrdinal: advanced.round.ordinal,
          nextExecutionId: advanced.executionId,
          owner: driver.dependencies.owner
        },
        { cancelRequested: "absent" }
      )
      if (transitioned._tag === "Transitioned") return
      return yield* Effect.fail(
        transitioned._tag === "GuardFailed"
          ? { _tag: "HandoffCancelled" } as const
          : { _tag: "HandoffFenceLost" } as const
      )
    }),
    { partition: seam.executionId }
  ).pipe(Effect.catchTag("@smthrs/journal/JournalError", Effect.die))

/**
 * Announces a committed terminal settlement: to any in-process caller
 * parked on this run's poll loop, and to every parent attached to the
 * logical run, which is runnable now. That wake is the only thing that
 * says so: a child settlement never passes through `scheduleResume`.
 *
 * A diamond's second parent lives only in its durable edge (issue #2500),
 * and `ensureRun` records an edge under the round the parent joined, so
 * the edges are gathered from every round of the lineage, deduplicated
 * with the creating parent `state_json` carries. Each is recorded for the
 * same reason `scheduleResume` records: the round this wake schedules is
 * the one a host's park guard has to recognize.
 */
const announceSettled = (driver: Driver, executionId: string, state: RunState): Effect.Effect<void> =>
  Effect.gen(function*() {
    yield* driver.wakeBus.wake(executionId)
    const parents = new Set<string>()
    if (state.parentExecutionId !== undefined) parents.add(state.parentExecutionId)
    const rounds = yield* driver.lifecycle.rounds(executionId).pipe(Effect.orDie)
    for (const roundId of new Set([executionId, ...rounds.map((round) => round.runId)])) {
      for (const edge of yield* driver.engineState.runParents(roundId)) parents.add(edge.parentId)
    }
    if (parents.size === 0) return
    for (const parentId of parents) {
      yield* recordParentResume(driver, parentId, executionId)
      yield* driver.coordinator.wake(parentId)
      yield* driver.wakeBus.wake(parentId)
    }
  })

/**
 * {@link announceSettled} again, for a settled run that is the last round
 * of its lineage. See {@link Service.reannounce}.
 */
const reannounce = (driver: Driver, executionId: string): Effect.Effect<void> =>
  Effect.gen(function*() {
    const latest = yield* driver.store.latestRound(executionId).pipe(Effect.orDie)
    // A round that handed off is not the lineage's settlement: its
    // successor's is.
    if (latest.runId !== executionId) return
    yield* announceSettled(driver, executionId, yield* decodeState(latest.stateJson))
  })

/**
 * Ends a lineage that asked for one round past its declared budget.
 *
 * The round itself ran to completion; what is refused is the handoff, so
 * the round settles `failed` carrying the typed refusal and no successor
 * is created (`packages/smithers/flows/engine/docs/concepts/trampoline-rounds.md`).
 */
const endLineage = (driver: Driver, seam: HandoffSeam, error: Flow.MaxRoundsExceeded): Effect.Effect<void> =>
  Effect.gen(function*() {
    const stateJson = yield* encodeState({
      ...seam.state,
      result: (yield* encodeResult(seam.flow, new Flow.Complete({ exit: Exit.die(error) }))).encoded
    })
    const transitioned = yield* transitionAndRecord(
      driver,
      seam.executionId,
      "failed",
      stateJson,
      {
        decision: "lineage-exhausted",
        status: "failed",
        lineageId: error.lineageId,
        maxRounds: error.maxRounds,
        owner: driver.dependencies.owner
      },
      { cancelRequested: "absent" },
      // The lineage is over, not continuing: this round is the last one,
      // so it ends its children like any other terminal exit. A round that
      // HANDS OFF settles through `continueLineage` instead and deliberately
      // does not, because the lineage — and therefore the parent the
      // children are linked to — carries on.
      applyChildExitPolicy(driver, seam.executionId)
    )
    if (transitioned._tag === "GuardFailed") {
      yield* cancelOwned(driver, seam.executionId, seam.state)
    } else if (transitioned._tag === "Transitioned") {
      yield* recordSettled(driver, seam.executionId, seam.state, RunMetrics.settlement(Exit.die(error)))
      yield* announceSettled(driver, seam.executionId, seam.state)
    }
  })

/**
 * Settles an owned run `failed` with `defect`, a refusal no later round of
 * it can get past, recording `decision` with the transition. A
 * cancellation requested meanwhile cancels the run instead.
 */
const failRefused = (
  driver: Driver,
  executionId: string,
  flow: Flow.Any,
  state: RunState,
  defect: unknown,
  decision: Readonly<Record<string, unknown>>
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const stateJson = yield* encodeState({
      ...state,
      result: (yield* encodeResult(flow, new Flow.Complete({ exit: Exit.die(defect) }))).encoded
    })
    const transitioned = yield* transitionAndRecord(
      driver,
      executionId,
      "failed",
      stateJson,
      { ...decision, status: "failed", owner: driver.dependencies.owner },
      { cancelRequested: "absent" },
      applyChildExitPolicy(driver, executionId)
    )
    if (transitioned._tag === "GuardFailed") {
      yield* cancelOwned(driver, executionId, state)
    } else if (transitioned._tag === "Transitioned") {
      yield* recordSettled(driver, executionId, state, {
        outcome: "refused",
        code: RunMetrics.settlement(Exit.die(defect)).code
      })
      yield* announceSettled(driver, executionId, state)
    }
  })

/** Fails a run whose persisted round identity or budget is malformed. */
const endInvalidRound = (
  driver: Driver,
  seam: HandoffSeam,
  error: FlowEngine.Round.InvalidRound
): Effect.Effect<void> =>
  failRefused(driver, seam.executionId, seam.flow, seam.state, error, {
    decision: "round-invalid",
    message: error.message
  })

/**
 * Fails a run whose recorded payload the resuming build's payload schema
 * no longer decodes, as a deploy that added a required field leaves it.
 *
 * No build of this flow can resume it, so it settles `failed` with the
 * interpreter's `payload_changed` refusal as its defect, the way a changed
 * plan settles `plan_changed`, instead of dying in the decoder on every
 * wake. The refusal and its log line name the run and the flow, never the
 * payload or the decoder's message, which can quote it.
 */
const refuseChangedPayload = (
  driver: Driver,
  executionId: string,
  flow: Flow.Any,
  state: RunState
): Effect.Effect<void> =>
  Effect.gen(function*() {
    // A round of this run that parked in this process retained its scope;
    // no round replaces it now. `Exit.void`, as a supersede releases it.
    yield* releaseRetainedScope(driver, executionId, Exit.void)
    const refusal = new Interpreter.InterpreterError({
      code: "payload_changed",
      flow: flow._tag,
      node: "root",
      message: "The recorded payload does not decode with this build's payload schema; start a new execution"
    })
    yield* Effect.logWarning(
      `engine-store: refusing run ${executionId} of flow ${flow._tag}: its recorded payload does not decode with this build's payload schema`,
      { runId: executionId, flowName: flow._tag, code: refusal.code }
    )
    yield* failRefused(driver, executionId, flow, state, refusal, { decision: "payload-changed", code: refusal.code })
  })

/**
 * The handoff seam: the one place a round's terminal settlement and its
 * successor are decided together.
 */
const handOff = (driver: Driver, seam: HandoffSeam): Effect.Effect<void, never, Crypto.Crypto> =>
  FlowEngine.Round.next(
    {
      // The row's lineage_id was written from a round's rootExecutionId,
      // so this rehydrates the brand; `Round.next` still validates it.
      rootExecutionId: seam.row.lineageId! as FlowEngine.Round.RootExecutionId,
      ordinal: seam.row.roundOrdinal!
    },
    // The origin persisted its budget into every round's state, so a
    // multi-flow handoff cannot reset the lineage by changing targets.
    { flowName: seam.flow._tag, maxRounds: seam.state.maxRounds }
  ).pipe(
    Effect.flatMap((advanced) => continueLineage(driver, seam, advanced)),
    Effect.catch((error) =>
      error instanceof FlowEngine.Round.InvalidRound
        ? endInvalidRound(driver, seam, error)
        : endLineage(driver, seam, error)
    )
  )

/** The flow and instance of the round a drive is executing. */
interface DrivenRound {
  readonly flow: Flow.Any
  readonly instance: FlowRuntime.FlowInstance["Service"]
}

/**
 * What one drive learns as it goes, which its interruption and exit
 * handlers act on.
 */
interface Drive {
  readonly executionId: string
  /** The state the run was read with; an interruption settles against it. */
  state: RunState | undefined
  round: DrivenRound | undefined
  /**
   * Set when a suspension's guarded transition commits: the only thing that
   * lets the round's retained flow scope outlive the drive.
   */
  durableParkAccepted: boolean
  /**
   * Set by the heartbeat loop when this round's lease lapses, so the
   * release it causes records why (#3328).
   */
  lapsedMs: number | undefined
}

/**
 * Drives one run: reads it, takes it, and executes and settles one round.
 *
 * The coordinator runs one drive per run at a time. Every ending of the
 * drive, an interruption included, goes through the cleanup it installs
 * before the claim.
 */
const drive = (driver: Driver, executionId: string): Effect.Effect<void, never, Crypto.Crypto> =>
  Effect.suspend(() => {
    const attempt: Drive = {
      executionId,
      state: undefined,
      round: undefined,
      durableParkAccepted: false,
      lapsedMs: undefined
    }
    return driveRun(driver, attempt).pipe(
      // Install ownership cleanup before the claim itself. Limiting it to
      // the execution race strands an activated row if shutdown lands in
      // setup or settlement; a replacement host in the same process then
      // correctly refuses to steal from the still-live PID forever.
      Effect.onInterrupt(() => releaseInterrupted(driver, attempt)),
      Effect.onExit(() => endDrive(driver, attempt)),
      Effect.annotateLogs({ runId: executionId })
    )
  })

const driveRun = (driver: Driver, attempt: Drive): Effect.Effect<void, never, Crypto.Crypto> =>
  Effect.gen(function*() {
    const executionId = attempt.executionId
    const initial = yield* findRun(driver, executionId)
    if (initial === undefined) return
    const state = yield* decodeState(initial.stateJson)
    attempt.state = state
    const registration = driver.registrations.get(state.flowName)?.at(-1)
    if (registration === undefined) return yield* driveUnregistered(driver, executionId, initial, state)
    if (!(yield* claimAndActivate(driver, initial))) return
    yield* Effect.logDebug("run activated", { flowName: state.flowName })
    const activeState = yield* enterRunning(driver, executionId, initial, state)
    if (activeState === undefined) return
    // The payload was recorded with the codec of the build that admitted
    // the run. One this build's codec refuses can never resume here.
    const payload = yield* decodePayload(registration.flow, activeState.payload)
    if (Option.isNone(payload)) {
      return yield* refuseChangedPayload(driver, executionId, registration.flow, activeState)
    }
    yield* runRound(driver, attempt, initial, registration, activeState, payload.value)
  })

/**
 * Answers a wake for a run whose flow this process has not registered: it
 * can still close a run whose cancellation was requested, and otherwise
 * leaves the run for a worker that registers the flow.
 */
const driveUnregistered = (
  driver: Driver,
  executionId: string,
  initial: RunStore.RunRow,
  state: RunState
): Effect.Effect<void> =>
  Effect.gen(function*() {
    // A coalesced wake can outlive terminal settlement. There is no
    // parked work left for a handler to reclaim.
    if (isSettled(initial.status)) return
    // Cancelling needs no handler. A parked run whose cancellation was
    // durably requested used to be dropped here with everything else,
    // and nothing else could ever reach it: the sweep woke the row every
    // heartbeat and every wake bailed at this line, so a cancel written
    // by a control-only process — the operator CLI, a second engine that
    // registers other flows — stayed write-only forever while the run's
    // linked children kept going. The terminal transition, the cascade
    // over the durable edge table, and the interruption record are all
    // written from the run ROW, so a process that could never execute
    // this flow can still close it. Claiming first is what makes the
    // close fenced: `cancelOwned` is owner-fenced, so exactly one of the
    // sweeping processes wins and the rest see a lost CAS.
    //
    // `running` is here for the same reason `suspended` is. The row a
    // hard-killed owner leaves behind is `running` with a frozen
    // heartbeat and no waiting row, so the stale-running sweep is the
    // only thing that reaches it, and it arrives through this same
    // function: without this arm a control-only process could close a
    // PARKED run of an unregistered flow and not a hard-killed one,
    // though the two closes are the identical durable write. Nothing is
    // weakened by admitting it, because the arbitration is
    // `claimAndActivate`'s and not this guard's: a fresh lease or a live
    // owner refuses the takeover and the run is left exactly as it was.
    if (
      (initial.status === "pending" || initial.status === "suspended" || initial.status === "running") &&
      initial.cancelRequestedAtMs !== null
    ) {
      if (!(yield* claimAndActivate(driver, initial))) return
      return yield* cancelOwned(driver, executionId, withoutResult(state))
    }
    // A wake for a flow this process has not registered — after a full
    // restart the sweep re-drives released rows before (or without)
    // the flow ever registering here. Dropping the wake silently made
    // the #39 reclaim guarantee invisibly conditional on registration
    // (issue #62): warn (once per run, the sweep retries every
    // heartbeat) and leave the durable waiting row untouched so any
    // process that does register the flow still reclaims the run.
    if (driver.warnedUnregistered.has(executionId)) return
    driver.warnedUnregistered.add(executionId)
    yield* Effect.logWarning(
      `engine-store: run ${executionId} woke for flow ${state.flowName}, which is not registered in this process; leaving it parked for a worker that registers the flow`,
      { runId: executionId, flowName: state.flowName }
    )
  })

/**
 * Moves an activated run to `running`, answering the state its round runs
 * with, or `undefined` when the run cancels or loses its fence instead.
 */
const enterRunning = (
  driver: Driver,
  executionId: string,
  initial: RunStore.RunRow,
  state: RunState
): Effect.Effect<RunState | undefined> =>
  Effect.gen(function*() {
    yield* consumeActivationWakes(driver, state.flowName, executionId)
    const { parked, ...unparked } = withoutResult(state)
    const activeState: RunState = unparked
    // The activation transition carries the cancel guard: a run whose
    // cancellation was durably requested while it was parked must cancel
    // here instead of re-executing flow side effects (issue #27).
    const cleared = yield* transitionAndRecord(
      driver,
      executionId,
      "running",
      yield* encodeState(activeState),
      { decision: "resumed", status: "running" },
      { cancelRequested: "absent" },
      undefined,
      null
    )
    if (cleared._tag === "GuardFailed") {
      yield* cancelOwned(driver, executionId, withoutResult(state))
      return undefined
    }
    if (cleared._tag !== "Transitioned") return undefined
    yield* recordActivation(driver, initial, state, parked)
    return activeState
  })

/** Activation consumes child and clock wakes; their durable results remain readable by later awaits. */
const consumeActivationWakes = (driver: Driver, flowName: string, executionId: string): Effect.Effect<void> =>
  Effect.gen(function*() {
    for (const wake of yield* driver.engineState.completedDeferreds(flowName, executionId)) {
      if (wake.deferredName.startsWith(parentWakePrefix) || wake.deferredName.startsWith("DurableClock/")) {
        yield* driver.engineState.consumeDeferred(wake, yield* Clock.currentTimeMillis)
      }
    }
  })

/**
 * Usage metrics: the first activation of a lineage's first round is
 * when its first step can start, and a resume from a park ends the
 * durable wait it parked on.
 */
const recordActivation = (
  driver: Driver,
  initial: RunStore.RunRow,
  state: RunState,
  parked: RunState["parked"]
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const activatedAtMs = yield* Clock.currentTimeMillis
    if (initial.startedAtMs === null && (initial.roundOrdinal ?? 0) === 0 && state.origin !== undefined) {
      yield* RunMetrics.recordFirstStep({
        flow: state.flowName,
        placement: driver.placement,
        delayMs: activatedAtMs - state.origin.admittedAtMs
      })
    }
    if (parked !== undefined) {
      yield* RunMetrics.recordWaitEnded({
        flow: state.flowName,
        kind: RunMetrics.waitKind(parked.kind),
        durationMs: activatedAtMs - parked.atMs
      })
    }
  })

/** Decodes a recorded payload with this build's codec, or answers none when the codec refuses it. */
const decodePayload = (flow: Flow.Any, payload: unknown): Effect.Effect<Option.Option<unknown>> =>
  Schema.decodeUnknownEffect(
    Schema.toCodecJson(flow.payloadSchema)
  )(payload).pipe(Effect.option) as Effect.Effect<Option.Option<unknown>>

/** Executes one round of an activated run under a fresh instance, and settles it. */
const runRound = (
  driver: Driver,
  attempt: Drive,
  initial: RunStore.RunRow,
  registration: Registration,
  activeState: RunState,
  payload: unknown
): Effect.Effect<void, never, Crypto.Crypto> =>
  Effect.gen(function*() {
    const executionId = attempt.executionId
    // A previous round of this run may have parked and retained its flow
    // scope. That instance is now superseded — this round runs under the
    // fresh instance below, with a scope of its own — so release the old
    // one instead of orphaning it. `Exit.void`: a re-drive is a successful
    // continuation, so ordinary finalizers release resources while
    // `Flow.withRollback` compensations correctly stay out.
    yield* releaseRetainedScope(driver, executionId, Exit.void)
    const instance = FlowEngine.makeInstance(
      registration.flow,
      executionId,
      activeState.deadline
    )
    attempt.round = { flow: registration.flow, instance }
    const flowEngine = yield* driver.dependencies.engine
    // Published inside the drive's cleanup region for the same reason: the
    // entry used to be written before `dependencies.engine` was awaited, one
    // interruptible step ahead of the `ensuring` that removes it, so an
    // interrupt landing there left this round's instance in the map for
    // the driver's lifetime — a slow leak, and a stale instance for
    // `interrupt` to mark interrupted.
    driver.liveInstances.set(executionId, instance)
    const result = yield* raceRound(driver, attempt, registration, activeState, payload, instance, flowEngine)
    yield* settleRound(driver, attempt, initial, registration.flow, activeState, instance, result)
  })

/**
 * Races the flow body against the lease heartbeat and the cancel-request
 * poll, and takes ownership of the flow scope the instant a suspension
 * surfaces.
 */
const raceRound = (
  driver: Driver,
  attempt: Drive,
  registration: Registration,
  activeState: RunState,
  payload: unknown,
  instance: FlowRuntime.FlowInstance["Service"],
  flowEngine: FlowRuntime.FlowRuntime["Service"]
) =>
  Effect.scoped(Effect.flatMap(Effect.scope, (receiptScope) =>
    Effect.raceFirst(
      Effect.raceFirst(
        executeBody(attempt.executionId, registration, activeState, payload, instance, flowEngine),
        heartbeat(driver, attempt, heartbeatReceipt(attempt.executionId, instance, receiptScope))
      ),
      cancelPollLoop(driver, attempt.executionId)
    ))).pipe(
      Effect.ensuring(Effect.sync(() => driver.liveInstances.delete(attempt.executionId))),
      // A suspension is the ONE settlement `Flow.intoResult` leaves the
      // flow scope open for, so from the instant it surfaces the scope
      // needs an owner. Retention is taken HERE, inside the race's own
      // exit processing — `Effect.onExit` finalizers run uninterruptibly —
      // because taking it any later crosses an interruptible boundary: an
      // interrupt landing there would end the drive with the scope never
      // retained, unreachable, and its finalizers never run at all. The
      // entry is inserted into a cleanup region that was registered before
      // this race started, so it is owned from this instant on: every
      // ending, including an interrupt observed at the boundary between
      // this finalizer and the settlement below, releases it there.
      Effect.onExit((exit) =>
        Effect.suspend(() => {
          if (!(Exit.isSuccess(exit) && exit.value._tag === "Suspended")) return Effect.void
          driver.retainedScopes.set(attempt.executionId, instance.scope)
          return driver.dependencies.unsafeOnScopeRetained?.(attempt.executionId) ?? Effect.void
        })
      )
    )

/** The flow body, under the authority its run was admitted with. */
const executeBody = (
  executionId: string,
  registration: Registration,
  activeState: RunState,
  payload: unknown,
  instance: FlowRuntime.FlowInstance["Service"],
  flowEngine: FlowRuntime.FlowRuntime["Service"]
) =>
  Effect.suspend(() =>
    activeState.capabilityCeilings === undefined
      ? Effect.die(new Error("Missing persisted capabilityCeilings; execution cannot safely resume"))
      : registration.execute(payload as object, executionId)
  ).pipe(
    CapabilitySet.attenuateGroups(activeState.capabilityCeilings ?? [[]]),
    Flow.intoResult,
    Effect.provideService(FlowRuntime.FlowInstance, instance),
    Effect.provideService(FlowRuntime.FlowRuntime, flowEngine),
    // A run this run starts came through door `flow`, started
    // by the same kind of actor, unless its starter says
    // otherwise (an agent's tool call is door `agent`).
    RunMetrics.withOrigin({ door: "flow", actor: activeState.origin?.actor ?? "unknown" })
  )

/**
 * The round's external heartbeat receipt, one bounded receipt at a time. Each
 * is forked under the round's race scope, so a terminal settlement, a cancel or
 * a lost lease interrupts it, and the ownership writer never awaits HTTP. The
 * dynamic execution identity reaches clients.
 */
const heartbeatReceipt = (
  executionId: string,
  instance: FlowRuntime.FlowInstance["Service"],
  scope: Scope.Scope
): () => Effect.Effect<void> => {
  let pending = false
  return () =>
    Effect.suspend(() => {
      if (instance.heartbeat === undefined) return Effect.void
      if (pending) {
        return Metric.update(
          Metric.withAttributes(EngineStoreMetrics.heartbeatReceipts, { outcome: "skipped" }),
          1
        )
      }
      pending = true
      return instance.heartbeat.pipe(
        Effect.provideService(FlowRuntime.FlowInstance, instance),
        Effect.timeout(Ownership.heartbeatWriteTolerance),
        Effect.tap(() =>
          Metric.update(
            Metric.withAttributes(EngineStoreMetrics.heartbeatReceipts, { outcome: "completed" }),
            1
          )
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.andThen(
              Metric.update(
                Metric.withAttributes(EngineStoreMetrics.heartbeatReceipts, { outcome: "failed" }),
                1
              ),
              Effect.logWarning("run heartbeat receipt failed").pipe(
                Effect.annotateLogs({ runId: executionId })
              )
            )
        ),
        Effect.ensuring(Effect.sync(() => {
          pending = false
        })),
        Effect.forkIn(scope),
        Effect.asVoid
      )
    })
}

/**
 * Renews the round's lease while it runs. A hosted round renews no lease:
 * the host's liveness check reclaims a crashed incarnation, and every fenced
 * write of a superseded one changes nothing.
 */
const heartbeat = (driver: Driver, attempt: Drive, onPulse: () => Effect.Effect<void>) =>
  driver.hosted ? Effect.never : Ownership.heartbeatLoop(attempt.executionId, driver.dependencies.owner, {
    onPulse,
    onReconfirm: (unconfirmedMs) => {
      const record = decisionRecord(driver, attempt.executionId, {
        decision: "lease-reconfirmed",
        detail: { unconfirmedMs }
      }, driver.dependencies.journalSource)
      return driver.journal.emitDurable(record, driver.dependencies.owner).pipe(Effect.asVoid, Effect.orDie)
    },
    onLapse: (unconfirmedMs) =>
      Effect.sync(() => {
        attempt.lapsedMs = unconfirmedMs
      })
  }).pipe(
    Effect.provideService(RunStore.RunStore, driver.store)
  )

/**
 * Settles this round durably.
 *
 * A suspension that the guarded terminal transition durably accepts
 * sets `durableParkAccepted`, and that flag is the only thing that lets
 * a retained flow scope outlive this round. Every other ending — an
 * alternative settlement, a cancellation, a lost fence, a defect, an
 * interruption — leaves it unset, so the cleanup region registered
 * around the round releases the scope.
 */
const settleRound = (
  driver: Driver,
  attempt: Drive,
  initial: RunStore.RunRow,
  flow: Flow.Any,
  activeState: RunState,
  instance: FlowRuntime.FlowInstance["Service"],
  result: Flow.Result<unknown, unknown> | CancelRequested
): Effect.Effect<void, never, Crypto.Crypto> =>
  Effect.gen(function*() {
    const executionId = attempt.executionId
    if (result._tag === "CancelRequested") return yield* cancelOwned(driver, executionId, activeState)
    // Corrupt evidence on a SUCCEEDED attempt row is an operator-visible
    // event, not a terminal run failure (issue #171): the row cannot be
    // evicted and re-executed like a corrupt cache row (#164) without
    // breaking exactly-once. ActionPersistence has already journalled
    // the corruption and quarantined only its boundary evidence off the
    // row. Park this first strict detection so it remains visible; the
    // next explicit resume returns the durable outcome without replaying
    // the poison or re-executing the action.
    const quarantine = result._tag === "Complete" && Exit.isFailure(result.exit)
      ? ActionPersistence.evidenceQuarantined(result.exit.cause)
      : undefined
    if (quarantine !== undefined) return yield* parkQuarantined(driver, executionId, activeState, quarantine)
    // A round that handed off settles through the seam instead: its
    // terminal transition and its successor's creation are one write, so
    // it cannot share the ordinary terminal path below.
    if (result._tag === "Handoff") {
      return yield* handOff(driver, { executionId, row: initial, state: activeState, flow, handoff: result })
    }
    yield* settleResult(driver, attempt, flow, activeState, instance, result)
  })

/** Parks a round whose attempt evidence was quarantined, until an operator resumes it. */
const parkQuarantined = (
  driver: Driver,
  executionId: string,
  activeState: RunState,
  quarantine: ActionPersistence.AttemptEvidenceQuarantined
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const parked = yield* transitionAndRecord(
      driver,
      executionId,
      "suspended",
      yield* encodeState(withoutResult(activeState)),
      {
        decision: "quarantined",
        status: "suspended",
        keyDigest: quarantine.keyDigest,
        owner: driver.dependencies.owner
      },
      { cancelRequested: "absent" },
      undefined,
      { reason: "quarantine", token: quarantine.keyDigest }
    )
    if (parked._tag === "GuardFailed") {
      yield* cancelOwned(driver, executionId, activeState)
    }
  })

/**
 * The status a settlement writes. A settlement the flow's codec rejected
 * is written `failed` whatever it claimed to be: the row must reach a
 * terminal status in this process, because the alternative — the
 * `running` row the release validation found — is re-executed by the
 * next one.
 */
const settledStatus = (
  encodedResult: ExitEncoding.EncodedResult,
  result: Flow.Complete<unknown, unknown> | Flow.Suspended
): RunStore.RunStatus =>
  encodedResult.note !== undefined
    ? "failed"
    : result._tag === "Suspended"
    ? "suspended"
    : Exit.isSuccess(result.exit)
    ? "completed"
    : "failed"

/**
 * Why a suspended round parks.
 *
 * Park atomically with the suspended transition while this process still
 * owns the row (`park` is owner-fenced). The reason is derived from durable
 * state: a pending clock row means a timer wake with a known deadline;
 * anything else waits on an external event (deferred completion). This is
 * what makes `waitingRuns` sweepers and the 0004 partial index match real
 * suspensions (issue #12). A flow-declared classification
 * (FlowRuntime.annotateWaiting) wins: it is the only way an approval or
 * quota wait — and its wake token — reaches the parked row (issue #31). The
 * durable-state derivation stays the fallback.
 */
const parkReason = (
  driver: Driver,
  executionId: string,
  instance: FlowRuntime.FlowInstance["Service"]
): Effect.Effect<DurableEngineState.Waiting> =>
  Effect.gen(function*() {
    const declared = instance.waiting
    const pendingClocks = yield* driver.engineState.pendingClocks({ executionId })
    return declared !== undefined
      ? declared
      : pendingClocks.length > 0
      ? {
        reason: "timer",
        wakeAt: Math.min(...pendingClocks.map((clock) => clock.dueAtMs))
      }
      : { reason: "event" }
  })

/** Writes a round's own settlement: a terminal status, or a park. */
const settleResult = (
  driver: Driver,
  attempt: Drive,
  flow: Flow.Any,
  activeState: RunState,
  instance: FlowRuntime.FlowInstance["Service"],
  result: Flow.Complete<unknown, unknown> | Flow.Suspended
): Effect.Effect<void> =>
  Effect.gen(function*() {
    const executionId = attempt.executionId
    const encodedResult = yield* encodeResult(flow, result)
    const nextState: RunState = { ...activeState, result: encodedResult.encoded }
    const status = settledStatus(encodedResult, result)
    const waiting = status === "suspended" ? yield* parkReason(driver, executionId, instance) : null
    // Finalize is guarded on `cancel_requested_at_ms` inside the same
    // CAS: a cancellation request that raced past the last poll turns
    // the terminal transition into GuardFailed, and the run cancels
    // instead of finalizing (issue #11).
    // How a terminal status settles, for the usage metrics: a settlement
    // the codec rejected is `result_unencodable`, whatever it claimed.
    // A suspension settles nothing, and records none of this.
    const settledAs = encodedResult.note !== undefined || result._tag === "Suspended"
      ? { outcome: "failed" as const, code: "result_unencodable" }
      : RunMetrics.settlement(result.exit)
    // A park records when it began and what it waits on, so the
    // resume that ends it measures the wait (`RunMetrics.waitDuration`).
    const parked = waiting === null
      ? undefined
      : { atMs: yield* Clock.currentTimeMillis, kind: RunMetrics.waitKind(waiting.reason) }
    const transitioned = yield* transitionAndRecord(
      driver,
      executionId,
      status,
      yield* encodeState(parked === undefined ? nextState : { ...nextState, parked }),
      { decision: "transitioned", status, owner: driver.dependencies.owner },
      { cancelRequested: "absent" },
      // A suspension is not an exit: the run is parked and will settle
      // later, so its children keep going and its timers stay armed. A
      // `completed` or `failed` run is done, so its attached children
      // end with it. The transition closes its own clock rows.
      status === "suspended" ? undefined : applyChildExitPolicy(driver, executionId),
      waiting
    ).pipe(
      // The park becomes durable the instant this transition commits, so
      // the flag that records it is set in the transition's own exit
      // processing. `Effect.onExit` finalizers run uninterruptibly and
      // before the fiber can observe an interruption again, so no
      // interrupt can land between the durable commit and the flag and
      // make the cleanup region discard a scope the park still needs.
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (status === "suspended" && Exit.isSuccess(exit) && exit.value._tag === "Transitioned") {
            attempt.durableParkAccepted = true
          }
        })
      )
    )
    if (transitioned._tag === "GuardFailed") {
      // `cancelOwned` closes the retained scope itself, with the
      // interrupt exit cancellation compensations exist for. Leaving
      // `durableParkAccepted` unset therefore releases nothing a second
      // time: the entry is already gone from the map.
      return yield* cancelOwned(driver, executionId, activeState)
    }
    // A lost fence (`NotFound`, a mismatched CAS) settles nothing: the
    // run is someone else's now, so a suspension holds no durable park
    // and the cleanup region releases the scope rather than holding it
    // until shutdown.
    if (transitioned._tag !== "Transitioned") return
    if (parked !== undefined) {
      yield* RunMetrics.recordWait({ flow: activeState.flowName, kind: parked.kind })
    }
    if (status === "suspended") return
    yield* recordSettled(driver, executionId, activeState, settledAs)
    // The settle is durable; tell any in-process caller parked on this
    // run's poll loop, so a run driven to completion by a sweep or a
    // coordinator wake is observed now rather than on the next tick.
    yield* announceSettled(driver, executionId, activeState)
  })

/**
 * Settles an interrupted drive against the state it read, saying why: the
 * lease lapsed, the drive yielded its budget, or it was simply interrupted.
 */
const releaseInterrupted = (driver: Driver, attempt: Drive): Effect.Effect<void> =>
  attempt.state === undefined
    ? Effect.void
    : settleInterrupted(
      driver,
      attempt.executionId,
      attempt.state,
      attempt.lapsedMs !== undefined
        ? { kind: "lease-lapsed", unconfirmedMs: Math.max(0, Math.floor(attempt.lapsedMs)) }
        : driver.yielding.has(attempt.executionId)
        ? { kind: "yielded" }
        : { kind: "interrupted" },
      attempt.round
    )

/**
 * Ends the active drive of `executionId`, recording its release as
 * `yielded`. See {@link Service.yieldDrive}.
 */
const yieldDrive = (driver: Driver, executionId: string): Effect.Effect<void> =>
  Effect.acquireUseRelease(
    Effect.sync(() => driver.yielding.add(executionId)),
    () => driver.coordinator.interrupt(executionId),
    () => Effect.sync(() => driver.yielding.delete(executionId))
  )

/**
 * The drive's ONE cleanup region, registered before the race starts and
 * spanning everything that can retain a scope or make its park durable: the
 * suspension surfacing, the retention insertion in the race's exit,
 * `encodeResult`, the pending-clock read, `engineState.park`, the guarded
 * transition and the journal write it commits with, and the durable-park
 * decision itself. Registering it there is what closes the last window:
 * retention is inserted by an uninterruptible finalizer, and the fiber
 * becomes interruptible again the instant that finalizer returns, so any
 * cleanup piped onto the settlement alone would never be registered when an
 * interrupt is already pending at that boundary — the scope would stay
 * retained until the driver's own scope closed, which for a long-lived
 * driver is not a release at all.
 *
 * `Exit.void` is the release exit, for the reason shutdown and a supersede
 * use it (issue #26): a park that never committed leaves the run
 * owned-but-stale or already re-owned, so it is reclaimed and replayed, and
 * the replay re-registers its `Flow.withRollback` compensations under the
 * reclaiming owner. Compensating here would undo work the journal still
 * reports as done — and would then do it twice. Only a cancellation closes
 * with an interrupt exit, and only `cancelOwned` does that.
 */
const endDrive = (driver: Driver, attempt: Drive): Effect.Effect<void> =>
  Effect.suspend(() => {
    driver.liveInstances.delete(attempt.executionId)
    // Cancellation settles first so its compensations still see the
    // retained scope. A successful durable park alone retains it.
    return attempt.round === undefined || attempt.durableParkAccepted
      ? Effect.void
      : releaseRetainedScope(driver, attempt.executionId, Exit.void)
  })

/**
 * Delivers cancellation to parked runs (issue #27). A suspended run has
 * no owner and therefore no cancel poll, so `requestCancel` against it
 * is write-only until something re-drives the run — a run parked on a
 * deferred that never completes could otherwise never be cancelled. The
 * sweep lists parked rows, and wakes any whose cancel was durably
 * requested; the re-activation cancel guard then closes the run without
 * re-executing the flow.
 *
 * The same sweep reclaims interrupt-released runs (issue #39): a run
 * parked with reason `released` was interrupted mid-action by shutdown
 * or a heartbeat self-interrupt, has no pending clock and no completed
 * deferred, and would otherwise never be re-driven. Waking it re-enters
 * the ordinary claim/activate path, which also delivers any pending
 * cancel via the activation guard.
 */
const sweepCancelRequested = (driver: Driver): Effect.Effect<void> =>
  Effect.gen(function*() {
    // Fetch only actionable rows (issue #68): the sweep acts solely on
    // released rows and rows whose cancellation was durably requested, so
    // a large quota/event-parked fleet must cost it nothing per tick. The
    // per-row `store.get` below is a status guard over the (small)
    // actionable set, not a probe over every parked run — the in-memory
    // implementation without a `runs` view stays permissive on the cancel
    // predicate and relies on exactly this guard.
    const released = yield* driver.engineState.waitingRuns({ reason: "released" })
    const cancelRequestedRows = yield* driver.engineState.waitingRuns({ cancelRequested: true })
    const candidates = new Map<string, DurableEngineState.WaitingRow>()
    for (const waiting of released) candidates.set(waiting.runId, waiting)
    for (const waiting of cancelRequestedRows) candidates.set(waiting.runId, waiting)
    for (const waiting of candidates.values()) {
      const row = yield* driver.store.get(waiting.runId).pipe(
        Effect.catch(() => Effect.succeed(undefined))
      )
      if (
        row !== undefined &&
        row.status === "suspended" &&
        (row.cancelRequestedAtMs !== null || waiting.reason === "released")
      ) {
        // A released run is resumed in the lane; a cancellation is delivered at once.
        yield* driver.coordinator.wake(row.runId, { resumed: row.cancelRequestedAtMs === null })
      }
    }
  })

/**
 * A timer can fire while a dead control owner is still inside its stale
 * cutoff. The clock completion is durable, but that first coordinator
 * wake cannot claim yet (#3408). Revisit only due timer waits with an
 * unconsumed completion; the normal drive still checks admission and CAS.
 * Released actions, future timers and ordinary event waits are excluded.
 */
const sweepReadyTimers = (driver: Driver): Effect.Effect<void> =>
  Effect.gen(function*() {
    const nowMs = yield* Clock.currentTimeMillis
    const due = yield* driver.engineState.waitingRuns({ reason: "timer", dueBeforeMs: nowMs })
    const completions = new Map<string, ReadonlySet<string>>()
    for (const waiting of due) {
      const row = yield* driver.store.get(waiting.runId).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (row === undefined || row.status !== "suspended") continue
      const state = yield* decodeState(row.stateJson)
      if (!driver.registrations.has(state.flowName)) continue
      let ready = completions.get(state.flowName)
      if (ready === undefined) {
        ready = new Set(
          (yield* driver.engineState.completedDeferreds(state.flowName)).map((address) => address.executionId)
        )
        completions.set(state.flowName, ready)
      }
      if (!ready.has(row.runId)) continue
      yield* driver.coordinator.schedule(row.runId, { resumed: true })
    }
  })

/**
 * A swept row, or `undefined` for a row that is gone or unreadable. An
 * unreadable row is logged and skipped; any other read failure is a defect,
 * so the sweep retries the slot next tick.
 */
const readSweptRow = (
  driver: Driver,
  runId: string,
  skipped: string,
  annotations: Readonly<Record<string, unknown>>
): Effect.Effect<RunStore.RunRow | undefined> =>
  driver.store.get(runId).pipe(
    Effect.catch((error) =>
      error.code === "not_found_row" ? Effect.succeed(undefined) : error.code === "decode_failed"
        ? Effect.logWarning(skipped, { ...annotations, error }).pipe(Effect.as(undefined))
        : Effect.die(error)
    )
  )

/**
 * Schedules a pending run's drive, unless one is already active, the
 * deployment does not admit the row, or `current` says the sweep's reason
 * for it has gone.
 */
const schedulePending = (
  driver: Driver,
  runId: string,
  row: RunStore.RunRow,
  current: () => boolean = () => true
): Effect.Effect<void> =>
  Effect.gen(function*() {
    // An admission nobody drove is resumed in the lane. A cancellation is
    // delivered at once, including to a run still waiting its turn there.
    const resumed = row.cancelRequestedAtMs === null
    if ((yield* driver.coordinator.active).has(runId)) {
      // A no-op for a drive under way, which already sees the request; a
      // cancellation starts the drive of a run still waiting its turn.
      yield* driver.coordinator.schedule(runId, { resumed })
      return
    }
    if (driver.dependencies.canExecute !== undefined && !(yield* driver.dependencies.canExecute(row))) return
    if (!current() || (yield* driver.coordinator.active).has(runId)) return
    yield* driver.coordinator.schedule(runId, { resumed })
  })

/**
 * The pending-cancellation sweep's current cycle, starting one at the
 * backlog's present tail when none is open; `undefined` when nothing waits.
 */
const cancellationCycle = (driver: Driver): Effect.Effect<CancellationCycle | undefined> =>
  Effect.gen(function*() {
    if (driver.pendingCancellationCycle !== undefined) return driver.pendingCancellationCycle
    const tail = yield* driver.engineState.pendingCancellationTail()
    if (Option.isNone(tail)) return undefined
    driver.pendingCancellationCycle = { through: tail.value }
    return driver.pendingCancellationCycle
  })

// Explicit cancellation needs no registration or admission grace. A finite
// tail and cursor keep a denied prefix from starving eligible later rows,
// even when new cancellations arrive continuously.
const sweepPendingCancellation = (driver: Driver): Effect.Effect<void> =>
  Effect.gen(function*() {
    const cycle = yield* cancellationCycle(driver)
    if (cycle === undefined) return
    const candidates = yield* driver.engineState.pendingCancellationRuns(
      staleRunningSweepBatch,
      cycle.after,
      cycle.through
    )
    for (const cursor of candidates) {
      const row = yield* readSweptRow(driver, cursor.runId, "engine-store: unreadable pending cancellation skipped", {
        runId: cursor.runId
      })
      // Permanent misses advance; a transient read failure retries this slot.
      cycle.after = cursor
      if (row === undefined || row.status !== "pending" || row.cancelRequestedAtMs === null) continue
      yield* schedulePending(driver, cursor.runId, row)
    }
    if (
      candidates.length < staleRunningSweepBatch ||
      candidates.at(-1)?.runId === cycle.through.runId
    ) driver.pendingCancellationCycle = undefined
  })

/**
 * Re-drives pending admissions, up to one batch per tick shared across the
 * registered flows, starting from a different flow each tick.
 */
const sweepPending = (driver: Driver): Effect.Effect<void> =>
  Effect.gen(function*() {
    let remaining = staleRunningSweepBatch
    const allNames = Array.from(driver.registrations.keys())
    const offset = allNames.length === 0 ? 0 : driver.pendingFlowOffset % allNames.length
    const names = [...allNames.slice(offset), ...allNames.slice(0, offset)]
    driver.pendingFlowOffset++
    for (const name of names) {
      const registration = driver.registrations.get(name)?.at(-1)
      if (registration === undefined || remaining === 0) continue
      remaining = yield* sweepPendingFlow(driver, name, registration, remaining)
    }
  })

/**
 * The pending-admission sweep's current cycle through one flow's backlog,
 * starting one at the backlog's present tail when none is open; `undefined`
 * when nothing waits.
 */
const pendingCycle = (driver: Driver, name: string): Effect.Effect<PendingCycle | undefined> =>
  Effect.gen(function*() {
    const open = driver.pendingCycles.get(name)
    if (open !== undefined) return open
    const eligibleBeforeMs = (yield* Clock.currentTimeMillis) - Duration.toMillis(Ownership.heartbeatStaleAfter)
    const tail = yield* driver.engineState.pendingRunTail(name, eligibleBeforeMs)
    if (Option.isNone(tail)) return undefined
    const cycle: PendingCycle = { through: tail.value, eligibleBeforeMs }
    driver.pendingCycles.set(name, cycle)
    return cycle
  })

/**
 * Schedules up to `remaining` of one flow's pending admissions while
 * `registration` still serves the flow, answering how much of the tick's
 * batch is left.
 */
const sweepPendingFlow = (
  driver: Driver,
  name: string,
  registration: Registration,
  remaining: number
): Effect.Effect<number> =>
  Effect.gen(function*() {
    const cycle = yield* pendingCycle(driver, name)
    if (cycle === undefined) return remaining
    const current = () => driver.registrations.get(name)?.at(-1) === registration
    const requested = remaining
    const pending = yield* driver.engineState.pendingRuns(
      name,
      requested,
      cycle.after,
      cycle.through,
      cycle.eligibleBeforeMs
    )
    for (const cursor of pending) {
      if (remaining === 0 || !current()) break
      remaining--
      const row = yield* readSweptRow(driver, cursor.runId, "engine-store: unreadable pending admission skipped", {
        runId: cursor.runId,
        flowName: name
      })
      // Advance after successful reads or permanent row errors; transient failures retry this
      // position, while a retained query cursor skips deleted rows safely.
      cycle.after = cursor
      if (row === undefined || row.status !== "pending") continue
      yield* schedulePending(driver, cursor.runId, row, current)
    }
    const last = pending.at(-1)
    if (pending.length < requested || (last !== undefined && last.runId === cycle.through.runId)) {
      driver.pendingCycles.delete(name)
    }
    return remaining
  })

/**
 * Reclaims hard-killed runs (issue #53). An owner that dies without
 * releasing (SIGKILL, OOM, power loss) leaves a `running` row with a
 * frozen heartbeat and no waiting row, so the parked-run sweep above
 * never sees it, and the steal path — reachable only through `drive()` —
 * is never entered. Enumerate stale-running rows and re-drive them: the
 * ordinary claim/steal path (liveness check, exact-snapshot steal CAS)
 * then decides whether the owner is genuinely dead — the analog of
 * Temporal's task-timeout re-dispatch. A pending durable cancel is
 * delivered by the re-activation guard, same as for parked runs.
 */
const sweepStaleRunning = (driver: Driver): Effect.Effect<void> =>
  Effect.gen(function*() {
    const nowMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
    // Rows this driver has already arbitrated and been refused. They are the
    // oldest heartbeats in the window, so they sort first and would fill the
    // batch every tick; the read asks for enough extra rows to see past
    // exactly the ones it is going to skip.
    const deferred = Array.from(driver.stealRefusals.values()).filter((entry) => entry.nextProbeAtMs > nowMs).length
    // Capped per tick (issue #79): oldest heartbeats come back first, so a
    // mass owner death drains across successive ticks — batch after batch
    // as each stolen run's heartbeat leaves the stale window — instead of
    // every surviving driver waking every stale run every second and
    // contending N-drivers × M-runs on the claim/steal CAS.
    const stale = yield* driver.engineState.staleRunningRuns(
      nowMs - Duration.toMillis(Ownership.heartbeatStaleAfter),
      staleRunningSweepBatch + deferred
    )
    // A refusal is remembered only while its row is still in the window this
    // read covers. A run that was stolen, released, or settled leaves the
    // stale set, and its entry leaves with it, so the map cannot outgrow the
    // backlog it describes.
    const visible = new Set(stale.map((row) => row.runId))
    for (const runId of driver.stealRefusals.keys()) {
      if (!visible.has(runId)) driver.stealRefusals.delete(runId)
    }
    let woken = 0
    for (const { heartbeatAtMs, runId } of stale) {
      if (woken >= staleRunningSweepBatch) break
      // A refusal defers only the lease it was refused against. An owner
      // that pulsed and stalled again between two ticks never left this
      // read's window, so the lease is what says the stall is a new one.
      const refusal = driver.stealRefusals.get(runId)
      if (refusal !== undefined && refusal.heartbeatAtMs === heartbeatAtMs && refusal.nextProbeAtMs > nowMs) continue
      woken = woken + 1
      yield* driver.coordinator.wake(runId, { resumed: true })
    }
  })

const resilientSweep = (sweep: Effect.Effect<void>, name: string) =>
  sweep.pipe(
    Effect.sandbox,
    Effect.catchCause((cause) => Effect.logWarning(`engine-store: ${name} sweep failed; retrying next tick`, cause))
  )

/** One execution a caller asks to admit. */
interface Admission {
  readonly executionId: string
  readonly payload: object
  /**
   * Whether the caller discarded this execution's result. It is what
   * separates the two child shapes: a caller that waits for the child's
   * value holds it attached, and a caller that threw the value away
   * spawned it detached. See {@link RunState.OnParentExit}.
   */
  readonly discard?: boolean | undefined
  readonly parent?: FlowRuntime.FlowInstance["Service"] | undefined
  readonly round?:
    | (FlowEngine.Round.Round & {
      readonly previousExecutionId?: string | undefined
    })
    | undefined
}

/** The door, actor kind, and admission time a run's usage metrics label it with. */
type Origin = NonNullable<RunState["origin"]>

/**
 * Admits an execution: records its parent edge and creates its run row, or
 * joins the identical row already admitted.
 */
const ensureRun = (driver: Driver, flow: Flow.Any, options: Admission): Effect.Effect<void, FlowCycleDetected> =>
  Effect.gen(function*() {
    const payload = yield* (Schema.encodeEffect(
      Schema.toCodecJson(flow.payloadSchema)
    )(
      options.payload
    ).pipe(Effect.orDie) as Effect.Effect<unknown>)
    // The caller's door and actor kind, kept with the run for its usage
    // metrics. A run this call creates is counted once its row commits.
    const requestedOrigin = yield* RunMetrics.CurrentOrigin
    const origin: Origin = {
      door: RunMetrics.door(requestedOrigin.door),
      actor: RunMetrics.actor(requestedOrigin.actor),
      admittedAtMs: yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
    }
    if (!(yield* admit(driver, flow, options, payload, origin))) return
    yield* Effect.logInfo("flow.run.created").pipe(Effect.annotateLogs({
      "smithers.execution.id": options.executionId,
      "smithers.flow": flow._tag,
      createdAtMs: yield* Clock.currentTimeMillis
    }))
    yield* RunMetrics.recordStarted({
      flow: flow._tag,
      door: origin.door,
      actor: origin.actor,
      placement: driver.placement,
      executionId: options.executionId
    }).pipe(Effect.provideService(RunMetrics.LineLevel, driver.lineLevel))
  })

/**
 * Records the parent edge and creates the run row in one storage
 * transaction, answering whether this call opened a new lineage.
 *
 * Every requested parent — first (creating) parent and a diamond's
 * second parent alike — is recorded as a durable edge BEFORE the run
 * row is created. `recordRunParent` inserts the edge and checks for
 * a cycle inside one storage transaction (issues #29/#40/#54/#56),
 * so a rejected request fails here and never creates a run row — no
 * `state_json` parent can outlive a rejected edge (issue #55). The
 * edge table is the single source of truth for cycle detection in
 * every owner process and across restarts (issues #40/#41).
 *
 * The edge record and the run-row creation share one outer storage
 * transaction (issue #80): a crash between them used to commit a
 * durable orphan edge for a child run that never existed — never
 * GC'd, permanently walked by cycle detection, and able to force a
 * false FlowCycleDetected if the execution id was later reused
 * under an inverted topology. The stores' own writes become
 * savepoints of this transaction, so either both commit or neither.
 */
const admit = (
  driver: Driver,
  flow: Flow.Any,
  options: Admission,
  payload: unknown,
  origin: Origin
): Effect.Effect<boolean, FlowCycleDetected> =>
  driver.transactState(
    Effect.gen(function*() {
      let opened = false
      const parentRecorded = yield* recordParentEdge(driver, options)
      const round = options.round ?? FlowEngine.Round.initial(options.executionId)
      const previousExecutionId = options.round?.previousExecutionId
      const carried = yield* carriedChild(driver, flow, options)
      const state = yield* admittedState(flow, options, payload, origin, carried)
      const createdStateJson = yield* encodeState(state)
      yield* ensureCreatedRun(driver, {
        flowName: flow._tag,
        capabilityCeilings: state.capabilityCeilings!,
        executionId: options.executionId,
        stateJson: createdStateJson,
        payload,
        lineageId: round.rootExecutionId,
        roundOrdinal: round.ordinal,
        ...(previousExecutionId === undefined
          ? {}
          : { parentRunId: previousExecutionId }),
        onCreated: Effect.suspend(() => {
          opened = round.ordinal === 0
          return recordCreated(driver, flow, options, createdStateJson).pipe(
            Effect.andThen(carried === undefined ? Effect.void : seedCarried(driver, options.executionId, carried))
          )
        })
      })
      // The row already exists; the durable edge recorded above is the
      // only place a diamond's second parent lives (issues #41/#48): a
      // driver-local side table would be invisible to other owners over
      // the same store, lost across restart, and would grow without
      // bound for the driver's lifetime.
      //
      // Which is also why the parent's cancellation is inherited HERE,
      // last and inside this same transaction: the child row must already
      // exist for `requestCancel` to have anything to write to, and the
      // inheritance must commit or roll back with the edge that made this
      // run a child in the first place. The inherited request is what the
      // activation guard reads, so the child cancels instead of executing
      // the flow body.
      if (options.parent !== undefined) {
        yield* inheritParentCancellation(driver, options.parent.executionId, options.executionId)
        if (parentRecorded) {
          yield* emitDecision(driver, options.executionId, {
            decision: "parent-recorded",
            parentExecutionId: options.parent.executionId
          })
        }
      }
      return opened
    }),
    { partition: options.executionId }
  ).pipe(
    Effect.catchIf((error) => error instanceof Journal.JournalError || error instanceof DatabaseError, Effect.die)
  )

/**
 * Records the edge from the caller's parent, refusing one that closes a
 * cycle; answers whether the edge is new.
 */
const recordParentEdge = (driver: Driver, options: Admission): Effect.Effect<boolean, FlowCycleDetected> =>
  options.parent === undefined
    ? Effect.succeed(false)
    : driver.engineState.recordRunParent(options.executionId, options.parent.executionId).pipe(
      Effect.catch((error) =>
        Effect.fail(
          new FlowCycleDetected({ code: "flow_cycle_detected", path: error.path })
        )
      ),
      Effect.map((edge) => edge._tag === "Recorded")
    )

/** The state an admitted run opens with. */
const admittedState = (
  flow: Flow.Any,
  options: Admission,
  payload: unknown,
  origin: Origin,
  carried?: Carried | undefined
): Effect.Effect<RunState> =>
  Effect.gen(function*() {
    // Decided once, at spawn, from what the caller did with the result:
    // a caller waiting for the value keeps the child attached, and a
    // caller that discarded it detached the child on purpose. Nothing
    // later rewrites this.
    const onParentExit: OnParentExit = options.discard === true ? "detach" : "cancel"
    return {
      version: 1,
      flowName: flow._tag,
      payload,
      capabilityCeilings: yield* FlowEngine.requestedAuthority(flow),
      onParentExit,
      ...(options.parent === undefined
        ? {}
        : { parentExecutionId: options.parent.executionId }),
      ...(flow.maxRounds === undefined ? {} : { maxRounds: flow.maxRounds }),
      origin,
      // A carried child replays the child its source opened at this
      // boundary, whole: its keys resolve to the copied attempts.
      ...(carried === undefined ? {} : {
        forkKeyRunIds: [carried.source, ...(carried.state.forkKeyRunIds ?? [])],
        retryFrom: { source: carried.source, boundaries: carried.seed.boundaries }
      })
    }
  })

/**
 * Records the run's opening frame and, for a child, the spawn that made it.
 *
 * `store.create` used to be the one durable write with no journal record
 * at all, which left the replay-derived state projection with no base to
 * fold onto — `flowName` and `payload` exist nowhere else in the journal.
 * The state travels ENCODED, exactly as every later decision carries it:
 * `stateAt` folds these payloads and hands the winner back as the run
 * row's own `state_json`, so a base recorded in the decoded shape would be
 * a schema the caller cannot decode.
 */
const recordCreated = (
  driver: Driver,
  flow: Flow.Any,
  options: Admission,
  createdStateJson: string
): Effect.Effect<void> =>
  Effect.gen(function*() {
    yield* emitDecision(driver, options.executionId, {
      decision: "created",
      state: JSON.parse(createdStateJson),
      ...(options.parent === undefined ? {} : { parentExecutionId: options.parent.executionId })
    })
    if (options.parent !== undefined) {
      yield* recordSpawn(driver, flow, options.parent.executionId, options.executionId)
    }
  })

/**
 * Records a child's spawn in its parent's journal.
 *
 * A spawn is a lineage edge, and a DETACHED spawn is a tier-3 effect:
 * nothing the parent's rewind can undo, because the child is its own claim
 * and its own journal. The record is boundary-shaped so the same assessment
 * that classifies a sent webhook classifies an orphaned child, and it is
 * emitted at `succeeded` because by this point the child run durably
 * exists. Unfenced: the creator of a detached child is not necessarily the
 * parent's current owner (an external spawn admission creates child rows
 * without holding the parent's fence), so this lineage-edge record is
 * first-writer-wins evidence keyed by its spawn identity.
 */
const recordSpawn = (
  driver: Driver,
  flow: Flow.Any,
  parentExecutionId: string,
  executionId: string
): Effect.Effect<void> =>
  driver.journal.emitDurableUnfenced(
    EffectRecords.boundary(
      {
        id: `${parentExecutionId}:spawn:${executionId}`,
        kind: spawnEffectKind,
        tier: "irreversible",
        runId: parentExecutionId,
        lineageId: FlowEngine.Lineage.root(parentExecutionId),
        sourceId: driver.dependencies.journalSource,
        attempt: 1,
        residue: `Child run ${executionId} exists and keeps its own journal; rewinding past its spawn orphans it.`
      },
      "succeeded",
      // `attached` is written even though it is always false: the
      // lineage-tree bridge in `@smthrs/time-travel` reads it off
      // this payload, and an absent field there would make "this
      // spawn is detached" indistinguishable from "this producer
      // predates the field". A run created with a parent is a
      // separate run row with its own claim, which is what detached
      // means; attached nesting
      // never reaches `create` because it is one journal.
      { childRunId: executionId, flowName: flow._tag, attached: false }
    )
  ).pipe(Effect.orDie, Effect.asVoid)

/** A child carried from a retry's source: the child the source opened at the same boundary, and its seed. */
interface Carried {
  readonly source: string
  readonly state: RunState
  readonly seed: RetrySource.Seed
}

/** The retry a running round's run is, read once per round. */
const retryOf = (driver: Driver, parent: FlowRuntime.FlowInstance["Service"]) =>
  Effect.gen(function*() {
    const cached = driver.retries.get(parent)
    if (cached !== undefined) return cached ?? undefined
    // A parent the store holds no row for, as a direct driver caller's can be, retries nothing.
    const row = yield* findRun(driver, parent.executionId)
    const retry = row === undefined ? undefined : (yield* decodeState(row.stateJson)).retryFrom
    driver.retries.set(parent, retry ?? null)
    return retry
  })

/**
 * The child a retry's new execution carries instead of running again: when a
 * round of a retry opens a `.child()` boundary its source settled before the
 * retried step, under the same input, the child is the one the source opened
 * there, replayed whole. The boundary is recognized by deriving the child id
 * `Interpreter.childExecutionId` would give each such node in this run; the
 * source's child is the same derivation under the source's id, so a boundary
 * whose input changed derives an id the source never opened and runs afresh.
 *
 * A child that already exists is joined as it is. Storage that cannot copy
 * attempts carries nothing.
 */
const carriedChild = (driver: Driver, flow: Flow.Any, options: Admission) =>
  Effect.gen(function*() {
    if (options.parent === undefined || driver.engineState.copyAttempts === undefined) return undefined
    const retry = yield* retryOf(driver, options.parent)
    if (retry === undefined || (yield* findRun(driver, options.executionId)) !== undefined) return undefined
    for (const node of retry.boundaries) {
      const opened = yield* Interpreter.childExecutionId(options.parent.executionId, node, flow._tag, options.payload)
      if (opened !== options.executionId) continue
      // Derived from the source's id, the node and the callee, the id names the
      // source's own child of this flow, or nothing when retention removed it.
      const source = yield* Interpreter.childExecutionId(retry.source, node, flow._tag, options.payload)
      const row = yield* findRun(driver, source)
      if (row === undefined) return undefined
      const state = yield* decodeState(row.stateJson)
      const seed = yield* RetrySource.resolveWhole(driver.journal, source).pipe(Effect.orDie)
      return { source, state, seed } satisfies Carried
    }
    return undefined
  }).pipe(Effect.provide(driver.crypto))

/** Copies a carried child's attempts into the new child and records the retry it is. */
const seedCarried = (driver: Driver, executionId: string, carried: Carried) =>
  Effect.gen(function*() {
    const replayed = yield* driver.engineState.copyAttempts!({
      from: carried.source,
      to: executionId,
      attempts: carried.seed.attempts
    })
    yield* emitDecision(driver, executionId, {
      decision: "retry-from",
      source: carried.source,
      replayed,
      boundaries: carried.seed.boundaries.length
    })
    yield* recordRetry("carried", replayed)
  })

/** What a retry from a step was asked for. */
interface RetryRequest {
  readonly source: string
  readonly step: string
  readonly executionId: string
}

/** Counts a retry's outcome, and the attempts it seeded. Ids, codes and counts only. */
const recordRetry = (outcome: string, replayed = 0) =>
  Effect.andThen(
    Metric.update(Metric.withAttributes(EngineStoreMetrics.retriesFrom, { outcome }), 1),
    Metric.update(EngineStoreMetrics.retrySeededAttempts, replayed)
  )

/** Refuses a retry before anything is written, counted and logged. */
const refuseRetry = (options: RetryRequest, code: FlowRuntime.RetryFromRefusalCode) =>
  recordRetry(code).pipe(
    Effect.andThen(
      Effect.logInfo("flow.run.retry-from").pipe(Effect.annotateLogs({
        "smithers.execution.id": options.executionId,
        source: options.source,
        outcome: code
      }))
    ),
    Effect.andThen(
      Effect.fail(new FlowRuntime.RetryFromRefused({ code, executionId: options.source, step: options.step }))
    )
  )

/**
 * Retries the settled run `source` from its node `step` as the new root run
 * `executionId`: refuses what it cannot retry, admits the new run seeded with
 * the source's attempts that finished before the step, and schedules it.
 */
const retryFrom = Effect.fn("FlowEngine.retryFrom")(
  function*(driver: Driver, flow: Flow.Any, options: RetryRequest) {
    yield* Effect.annotateCurrentSpan({ executionId: options.executionId, source: options.source, flow: flow._tag })
    yield* requireRegistration(driver, flow)
    const copyAttempts = driver.engineState.copyAttempts
    if (copyAttempts === undefined) return yield* refuseRetry(options, "unsupported")
    const row = yield* findRun(driver, options.source)
    if (row === undefined) return yield* refuseRetry(options, "not_found")
    const source = yield* decodeState(row.stateJson)
    if (source.flowName !== flow._tag) return yield* refuseRetry(options, "other_flow")
    if (!isSettled(row.status)) return yield* refuseRetry(options, "not_settled")
    // A settled run's journal no longer moves, so it is read before the
    // admission's write transaction rather than inside it.
    const resolved = yield* RetrySource.resolve(driver.journal, options.source, options.step).pipe(Effect.orDie)
    if (resolved._tag === "Refused") return yield* refuseRetry(options, resolved.code)
    yield* Effect.uninterruptible(
      admitRetry(driver, flow, options, source, resolved.seed, copyAttempts).pipe(
        Effect.andThen(driver.coordinator.schedule(options.executionId))
      )
    )
  }
)

/**
 * Admits a retry's new run in one transaction: its row, with the source's
 * stored payload, the source as its first key origin and the retry it is;
 * its opening frame; the source's attempts that finished before the step; and
 * the `retry-from` decision that counts them. A repeated request joins the
 * run the first one admitted.
 */
const admitRetry = (
  driver: Driver,
  flow: Flow.Any,
  options: RetryRequest,
  source: RunState,
  seed: RetrySource.Seed,
  copyAttempts: NonNullable<DurableEngineState.Service["copyAttempts"]>
) =>
  Effect.gen(function*() {
    const requestedOrigin = yield* RunMetrics.CurrentOrigin
    const origin: Origin = {
      door: RunMetrics.door(requestedOrigin.door),
      actor: RunMetrics.actor(requestedOrigin.actor),
      admittedAtMs: yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
    }
    const retry = { source: options.source, step: options.step, boundaries: seed.boundaries }
    let replayed: number | undefined
    yield* driver.transactState(
      Effect.gen(function*() {
        const state: RunState = {
          version: 1,
          flowName: flow._tag,
          payload: source.payload,
          capabilityCeilings: yield* FlowEngine.requestedAuthority(flow),
          onParentExit: "detach",
          ...(flow.maxRounds === undefined ? {} : { maxRounds: flow.maxRounds }),
          origin,
          forkKeyRunIds: [options.source, ...(source.forkKeyRunIds ?? [])],
          retryFrom: retry
        }
        const createdStateJson = yield* encodeState(state)
        yield* ensureCreatedRun(driver, {
          flowName: flow._tag,
          capabilityCeilings: state.capabilityCeilings!,
          executionId: options.executionId,
          stateJson: createdStateJson,
          payload: source.payload,
          lineageId: options.executionId,
          roundOrdinal: 0,
          retryFrom: retry,
          onCreated: Effect.gen(function*() {
            yield* recordCreated(driver, flow, { executionId: options.executionId, payload: {} }, createdStateJson)
            replayed = yield* copyAttempts({ from: options.source, to: options.executionId, attempts: seed.attempts })
            yield* emitDecision(driver, options.executionId, {
              decision: "retry-from",
              source: options.source,
              step: options.step,
              replayed,
              boundaries: seed.boundaries.length
            })
          })
        })
      }),
      { partition: options.executionId }
      // The admission fails only as storage does, which the caller can't mend.
    ).pipe(Effect.orDie)
    yield* recordRetry(replayed === undefined ? "joined" : "admitted", replayed)
    yield* Effect.logInfo("flow.run.retry-from").pipe(Effect.annotateLogs({
      "smithers.execution.id": options.executionId,
      "smithers.flow": flow._tag,
      source: options.source,
      outcome: replayed === undefined ? "joined" : "admitted",
      replayed: replayed ?? 0,
      boundaries: seed.boundaries.length
    }))
    if (replayed === undefined) return
    yield* RunMetrics.recordStarted({
      flow: flow._tag,
      door: origin.door,
      actor: origin.actor,
      placement: driver.placement,
      executionId: options.executionId
    }).pipe(Effect.provideService(RunMetrics.LineLevel, driver.lineLevel))
  })

/**
 * Reads an execution's settlement and its row's status from one snapshot:
 * the round itself, or with `followLineage` the latest round of its lineage.
 */
const readResult = (driver: Driver, flow: Flow.Any, executionId: string, followLineage = false) =>
  Effect.gen(function*() {
    yield* Effect.annotateCurrentSpan({ executionId, flow: flow._tag })
    const requested = yield* FlowEngine.requestedAuthority(flow)
    const row = yield* (followLineage ? driver.store.latestRound(executionId) : driver.store.get(executionId)).pipe(
      Effect.catch((error) =>
        error.code === "not_found_row"
          ? Effect.succeed(undefined)
          : Effect.die(error)
      )
    )
    if (row === undefined) {
      // No run row at all is a typed not-found; `Option.none` is
      // reserved for a known run that has not settled yet.
      return yield* Effect.fail(
        new FlowRuntime.FlowExecutionNotFound({
          code: "execution_not_found",
          executionId
        })
      )
    }
    const state = yield* decodeState(row.stateJson)
    const result = (!followLineage && state.flowName !== flow._tag) || state.result === undefined
      ? Option.none()
      : yield* decodeSettlement(driver, flow, executionId, state, requested)
    return { result, status: row.status }
  })

/** Decodes a settled run's result for a caller whose authority covers it. */
const decodeSettlement = (
  driver: Driver,
  flow: Flow.Any,
  executionId: string,
  state: RunState,
  requested: CapabilitySet.CapabilitySet["groups"]
): Effect.Effect<Option.Option<Flow.Result<unknown, unknown>>> => {
  // A result is what the admitted authority produced; a caller
  // whose authority does not cover it never reads it.
  if (!FlowEngine.joinable(state.capabilityCeilings ?? [], requested)) {
    return Effect.die(FlowEngine.capabilityConflict(executionId))
  }
  const resultFlow = state.flowName === flow._tag ? flow : driver.registrations.get(state.flowName)?.at(-1)?.flow
  if (resultFlow === undefined) {
    // Direct nested callers must register the terminal flow's
    // codec here, even when another worker executed that flow.
    // This is the typed Trampoline's fail-fast wiring contract:
    // terminal work has no future wake to justify Suspended.
    return Effect.die(
      new FlowEngine.FlowNotRegistered({
        flowName: state.flowName,
        message: `Flow ${state.flowName} is not registered`
      })
    )
  }
  return Schema.decodeUnknownEffect(
    Schema.toCodecJson(Flow.Result({
      success: resultFlow.successSchema,
      error: resultFlow.errorSchema
    }))
  )(state.result).pipe(
    Effect.orDie,
    Effect.map(Option.some)
  ) as Effect.Effect<Option.Option<Flow.Result<unknown, unknown>>>
}

/**
 * Whether a resume of `executionId` for `flow` may drive anything: only an
 * admitted row of this declaration whose recorded authority the caller's
 * covers. An unknown id or a row another declaration owns drives nothing,
 * so a row admitted after this read is never woken on this request; a
 * caller whose authority does not cover the row is refused.
 */
const authorizeControl = (
  driver: Driver,
  flow: Flow.Any,
  executionId: string
): Effect.Effect<boolean, RunStore.RunStoreError> =>
  Effect.gen(function*() {
    const row = yield* driver.store.get(executionId).pipe(
      Effect.catch((error) => error.code === "not_found_row" ? Effect.succeed(undefined) : Effect.fail(error))
    )
    if (row === undefined) return false
    const state = yield* decodeState(row.stateJson)
    if (state.flowName !== flow._tag) return false
    if (!FlowEngine.joinable(state.capabilityCeilings ?? [], yield* FlowEngine.requestedAuthority(flow))) {
      return yield* Effect.die(FlowEngine.capabilityConflict(executionId))
    }
    return true
  })

const poll = Effect.fn("FlowEngine.poll")((driver: Driver, flow: Flow.Any, executionId: string) =>
  Effect.map(readResult(driver, flow, executionId), (observed) => observed.result)
)

/** What `execute` admits, and how its caller waits. */
type ExecuteOptions<Discard extends boolean> = Admission & {
  readonly discard: Discard
  readonly follow?: boolean | undefined
}

/** Admission must never create work the current host has no implementation for. */
const requireRegistration = (driver: Driver, flow: Flow.Any) =>
  driver.registrations.has(flow._tag)
    ? Effect.void
    : Effect.die(
      new FlowEngine.FlowNotRegistered({ flowName: flow._tag, message: `Flow ${flow._tag} is not registered` })
    )

const execute = Effect.fn("FlowEngine.execute")(
  function*<const Discard extends boolean>(driver: Driver, flow: Flow.Any, options: ExecuteOptions<Discard>) {
    yield* Effect.annotateCurrentSpan({ executionId: options.executionId, flow: flow._tag })
    yield* requireRegistration(driver, flow)
    // Cycle rejection happens atomically inside `ensureRun`'s call to
    // `DurableEngineState.recordRunParent`: the storage transaction that
    // inserts the edge also walks the parent chain and rolls back on a
    // hit, so no in-process gate, cross-owner arbitration, or withdrawal
    // protocol is needed here (issues #29/#40/#54/#55/#56) and the
    // mutual `coordinator.run` deadlock cannot form.
    if (options.discard) {
      // Keep durable admission and scheduling together across caller cancellation.
      // The coordinator owns the drive in the engine scope, so a
      // detached child outlives the caller's action and execution.
      yield* Effect.uninterruptible(
        ensureRun(driver, flow, options).pipe(Effect.andThen(driver.coordinator.schedule(options.executionId)))
      )
      return undefined as Discard extends true ? void : never
    }
    yield* ensureRun(driver, flow, options)
    yield* awaitDrive(driver, options.executionId, options.follow)
    // `ensureRun` created the row above, so a not-found here is a broken
    // store invariant, not a caller-recoverable state.
    // The trampoline supplies `round` and consumes each raw handoff itself.
    // A nested direct caller instead needs the child's current lineage row,
    // including its own codec and cancellation status. `follow` schedules an
    // undriven pending row before joining; it does not select the result's scope.
    const observed = yield* Effect.orDie(
      readResult(driver, flow, options.executionId, options.parent !== undefined && options.round === undefined)
    )
    return settlementOf(observed) as Discard extends true ? void : Flow.Result<unknown, unknown>
  }
)

/**
 * Runs or joins an admitted run's drive until it ends.
 *
 * Admission, handoff, or a wake normally scheduled this drive. A
 * replacement host may instead find an admitted pending row with no
 * drive, so schedule that row before joining. An idle suspended row
 * stays passive until its actual wake or elapsed poll resumes it.
 */
const awaitDrive = (driver: Driver, executionId: string, follow: boolean | undefined): Effect.Effect<void> =>
  follow === true
    ? driver.coordinator.scheduleIf(
      executionId,
      driver.store.get(executionId).pipe(
        Effect.orDie,
        Effect.map((row) => row.status === "pending")
      )
    ).pipe(Effect.andThen(driver.coordinator.join(executionId)))
    : driver.coordinator.run(executionId)

/**
 * What a caller is told about a run its drive has left: the settlement on
 * its row, or, for a row without one, that it was cancelled or is still
 * suspended.
 *
 * A cancelled run has no `Flow.Result` on its row — cancellation is
 * recorded as `cancellation`, not as a settlement — so answering the
 * absence with `Suspended` told the caller to wait for a run that was
 * over. The engine's suspended-retry loop then did what that answer
 * means: slept, resumed, re-drove, and asked again, for as long as the
 * caller lived. A run cancelled underneath its caller interrupts the
 * caller instead, which is what the memory engine already does
 * (`layerMemory.ts` `interrupt` settles the round `Complete` with an
 * interrupt cause) and what a cancellation means: the work the caller
 * asked for is not going to happen.
 * Result and cancellation status come from the same row snapshot.
 */
const settlementOf = (observed: {
  readonly result: Option.Option<Flow.Result<unknown, unknown>>
  readonly status: RunStore.RunStatus
}): Flow.Result<unknown, unknown> =>
  Option.isSome(observed.result)
    ? observed.result.value
    : observed.status === "cancelled"
    ? new Flow.Complete({ exit: Exit.failCause(Cause.interrupt()) })
    : new Flow.Suspended({})

const interrupt = Effect.fn("FlowEngine.interrupt")((
  driver: Driver,
  flow: Flow.Any,
  executionId: string
): Effect.Effect<void, FlowRuntime.CancelRequestFailed> =>
  Effect.gen(function*() {
    yield* Effect.annotateCurrentSpan({ executionId })
    // Operator intent is recorded durably before the fiber interrupt so
    // the interruption handler can tell cancellation apart from shutdown
    // (issue #26), and so the request survives if this process dies
    // before the interrupt lands.
    //
    // The write used to be `Effect.ignore`d, which answered success for a
    // cancellation that was never recorded: the fiber interrupt that
    // follows is then read as a shutdown by `settleInterrupted`, the run
    // is RELEASED for reclaim rather than cancelled, another worker picks
    // it up, and the caller was told the run was cancelled. The failure is
    // typed instead, so the caller can retry against a state that is still
    // truthful — the run is still running and still cancellable.
    const nowMs = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
    const requested = yield* requestCancelTree(driver, flow, executionId, nowMs)
    // Only after the durable write succeeds may the ephemeral surface say
    // this instance was interrupted or stop its drive fiber. If the write
    // failed, changing either would make a typed failure observably mutate
    // the run (and could spuriously trigger the in-process child path).
    // The transaction above records the parent and every durable
    // descendant together. A run this process does not drive — parked
    // here, owned elsewhere, or already settled — therefore receives the
    // same child-flow handling without a partial-cascade state if any
    // request write fails. `requestCancel` is first-writer-wins, so the
    // owning driver's own cascade later writes nothing.
    yield* driver.journal.whenCommitted(interruptRequested(driver, requested))
  })
)

/**
 * Records a cancellation request against an authorized run and every
 * linked descendant in one transaction, answering the runs it covers.
 *
 * The package's one lock order, the same one every settlement takes:
 * engine state first, then the journal. The descendant walk reads
 * engine state while holding the SQL writer, so the alternative would
 * deadlock against any fiber that ordered the two boundaries the
 * other way.
 */
const requestCancelTree = (
  driver: Driver,
  flow: Flow.Any,
  executionId: string,
  nowMs: number
): Effect.Effect<ReadonlyArray<string>, FlowRuntime.CancelRequestFailed> =>
  driver.transactState(
    Effect.gen(function*() {
      if (!(yield* authorizeControl(driver, flow, executionId))) return []
      yield* requestCancellation(driver, executionId, nowMs)
      return [executionId, ...yield* requestCancelDescendants(driver, executionId, nowMs)]
    }),
    // Capture the shared writer directly. SqlJournal.transact catches a
    // selected failure and can discard the rest of a composite cause. The
    // cascade writes every descendant's row, so it names no partition.
    { transact: (write) => Effect.flatMap(Effect.exit(driver.writer.write(write)), (exit) => exit) }
  ).pipe(Effect.catchCause((cause) => cancelRequestFailure(executionId, cause)))

/**
 * Types a failed cancellation request as `CancelRequestFailed` when one
 * storage failure caused it. A composite is never a retryable
 * CancelRequestFailed: retain every original reason, including defect
 * identity and interruption.
 */
const cancelRequestFailure = <E extends { readonly message: string }>(
  executionId: string,
  cause: Cause.Cause<E>
): Effect.Effect<never, FlowRuntime.CancelRequestFailed> => {
  const failure = (error: { readonly message: string }) =>
    new FlowRuntime.CancelRequestFailed({
      code: "cancel_request_failed",
      executionId,
      reason: error.message
    })
  if (cause.reasons.length === 1) {
    const reason = cause.reasons[0]!
    if (Cause.isDieReason(reason) && reason.defect instanceof DatabaseError) {
      return Effect.fail(failure(reason.defect))
    }
    // The typed channel is the normalized writer/store/journal union.
    if (Cause.isFailReason(reason)) {
      return Effect.fail(failure(reason.error))
    }
  }
  // A composite is not the retryable request failure the typed
  // channel promises, so every typed reason is re-channelled as a
  // defect rather than cast through `CancelRequestFailed`. The error
  // objects, the accompanying defects and the interruptions all
  // survive; only the channel changes, and it changes to the one the
  // declared type actually admits.
  return Effect.failCause(asDefects(cause))
}

/** Marks each cancelled run's live instance interrupted and asks its drive to stop. */
const interruptRequested = (driver: Driver, requested: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.gen(function*() {
    for (const targetId of requested) {
      const instance = driver.liveInstances.get(targetId)
      if (instance !== undefined) instance.interrupted = true
      // Publication only sends the request. Awaiting user finalizers
      // here would make an outer commit uninterruptibly wait on them.
      yield* driver.coordinator.requestInterrupt(targetId)
    }
  })

const scheduleResume = Effect.fn("FlowEngine.scheduleResume")((
  driver: Driver,
  flowName: string,
  executionId: string,
  reason: ScheduledResumeReason,
  sourceId?: string | undefined
) =>
  recordWake(driver, flowName, executionId, reason, sourceId).pipe(
    Effect.orDie,
    // A host can write a separate database. Release the engine transaction
    // before calling it, but record its request before publishing the wake.
    Effect.flatMap((scheduled) =>
      scheduled === undefined ? Effect.void : publishWake(driver, executionId, reason, scheduled.parked)
    )
  )
)

/**
 * Records a wake for a run that can still take one, answering whether the
 * run was parked, or `undefined` when nothing was scheduled.
 */
const recordWake = (
  driver: Driver,
  flowName: string,
  executionId: string,
  reason: ScheduledResumeReason,
  sourceId: string | undefined
) =>
  driver.transactState(
    Effect.gen(function*() {
      yield* Effect.annotateCurrentSpan({ executionId, flow: flowName, reason })
      const row = yield* findRun(driver, executionId)
      if (row === undefined) return
      // A settled run is not woken and then refused: it is not woken. The
      // terminal reject used to live one layer down, in `claimAndActivate`,
      // so a timer armed before its run was cancelled and an external
      // trigger arriving after the run finished both wrote a
      // `wake-scheduled` decision into the journal of a run that can never
      // wake again — one per event, forever, on a durable channel.
      if (isSettled(row.status)) return
      const state = yield* decodeState(row.stateJson)
      if (state.flowName !== flowName) return
      if (yield* isQuarantined(driver, executionId)) {
        if (reason !== "operator") return
        // Recovery consent and its journal receipt commit together. A
        // queued drive cannot consume quarantined evidence before consent.
        yield* driver.engineState.wake(executionId)
      }
      yield* emitDecision(driver, executionId, {
        decision: "wake-scheduled",
        reason
      }, sourceId)
      return { parked: row.status === "suspended" }
    }),
    { partition: executionId }
  )

/**
 * Says a run is runnable: to the host when the engine itself asked (see
 * {@link recordResume}), then to this process's coordinator and wake bus.
 */
const publishWake = (
  driver: Driver,
  executionId: string,
  reason: ScheduledResumeReason,
  parked: boolean
): Effect.Effect<void> =>
  (reason === "operator" || reason === "delegated"
    ? Effect.void
    : recordResume(driver, executionId, parked, reason)).pipe(
      // A hosted wake is durable work for the next explicit drive. Starting
      // an idle drain here would run during registration or signal delivery,
      // before the host applies admission, cancellation and its drive budget.
      Effect.andThen(
        driver.hosted
          ? driver.coordinator.wakeIfActive(executionId)
          : driver.coordinator.wake(executionId)
      ),
      Effect.andThen(driver.wakeBus.wake(executionId))
    )

const register = Effect.fn("FlowEngine.register")((
  driver: Driver,
  flow: Flow.Any,
  handler: Registration["execute"]
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const registration = { flow, execute: handler }
      const entries = driver.registrations.get(flow._tag) ?? []
      entries.push(registration)
      driver.registrations.set(flow._tag, entries)
      driver.pendingCycles.delete(flow._tag)
      driver.warnedUnregistered.clear()
      return { registration, entries }
    }),
    ({ registration, entries }) =>
      Effect.sync(() => {
        const wasLatest = entries.at(-1) === registration
        entries.splice(entries.indexOf(registration), 1)
        if (entries.length === 0) driver.registrations.delete(flow._tag)
        if (wasLatest) {
          driver.pendingCycles.delete(flow._tag)
          // Restoring a live predecessor changes which handler may
          // drive pending work, just like a fresh registration does.
          if (entries.length > 0) driver.warnedUnregistered.clear()
        }
      })
  ).pipe(Effect.asVoid)
)

/**
 * The durable engine has ONE cancellation path (the release policy). The
 * port promises forced cancellation without cleanup; nothing here can
 * deliver that — a durable run is closed by a fenced transition whose
 * finalizers, cascade, and interruption record are the point — and
 * answering with `interrupt` silently reinterpreted the caller's
 * request as the safe one. Refusing is what keeps the excluded feature
 * from appearing to half-work; `interrupt` is the supported request and
 * is still available to the same caller. The memory engine, which does
 * have two behaviors, is unchanged.
 *
 * The reason is the release policy "Durable interruptUnsafe" verbatim, not a
 * paraphrase of it: the release note and the failure a caller catches
 * are the same statement, so an operator who reads one and a developer
 * who logs the other are reading the same sentence.
 */
const interruptUnsafe = Effect.fn("FlowEngine.interruptUnsafe")((
  _flow: Flow.Any,
  executionId: string
) =>
  Effect.fail(
    new FlowRuntime.CancelRequestFailed({
      code: "unsafe_interrupt_unsupported",
      executionId,
      reason:
        "The durable engine has one cancellation path, interrupt, which is durable and cascades to linked children. FlowRuntime.interruptUnsafe on the durable engine fails with unsafe_interrupt_unsupported instead of forcing cancellation without cleanup."
    })
  )
)

const resume = Effect.fn("FlowEngine.resume")((
  driver: Driver,
  flow: Flow.Any,
  executionId: string,
  options: Parameters<Service["resume"]>[2],
  ask?: RunCoordinator.Ask
) =>
  Effect.gen(function*() {
    yield* Effect.annotateCurrentSpan({ executionId, flow: flow._tag })
    if (!(yield* authorizeControl(driver, flow, executionId).pipe(Effect.orDie))) return
    if (options?.poll === true) {
      const row = yield* driver.store.get(executionId).pipe(Effect.orDie)
      if (row.status === "suspended" && row.cancelRequestedAtMs === null) {
        const waiting = yield* driver.engineState.waiting(executionId)
        if (Option.isSome(waiting) && waiting.value.reason === "quarantine") return
        if (
          (Option.isNone(waiting) || waiting.value.reason !== "released") &&
          !(yield* driver.engineState.hasDueWake(executionId, yield* Clock.currentTimeMillis))
        ) return
      }
    } else {
      yield* scheduleResume(driver, flow._tag, executionId, options?.delegated === true ? "delegated" : "operator")
    }
    yield* driver.coordinator.run(executionId, ask)
  })
)

const active = (driver: Driver) => Effect.fn("FlowEngine.active")(() => driver.coordinator.active)()

/** The encoded engine operations a driver answers, each bound to it. */
const service = (driver: Driver): Service => ({
  admit: (flow, options) => requireRegistration(driver, flow).pipe(Effect.andThen(ensureRun(driver, flow, options))),
  register: (flow, handler) => register(driver, flow, handler),
  execute: (flow, options) => execute(driver, flow, options),
  poll: (flow, executionId) => poll(driver, flow, executionId),
  retryFrom: (flow, options) => retryFrom(driver, flow, options),
  interrupt: (flow, executionId) => interrupt(driver, flow, executionId),
  interruptUnsafe,
  resume: (flow, executionId, options) => resume(driver, flow, executionId, options),
  resumeHosted: (flow, executionId) => resume(driver, flow, executionId, { poll: true }, { resumed: true }),
  scheduleResume: (flowName, executionId, reason, sourceId) =>
    scheduleResume(driver, flowName, executionId, reason, sourceId),
  active: active(driver),
  retainedRuns: retainedRuns(driver),
  reannounce: (executionId) => reannounce(driver, executionId),
  yieldDrive: (executionId) => yieldDrive(driver, executionId)
})

/**
 * Releases every flow scope still retained when the driver's own scope
 * closes.
 *
 * Process shutdown must not strand parked scopes either: closing the
 * driver's own scope releases every scope still retained. `Exit.void`,
 * because a shutdown is a reclaimable release (issue #26) and not a
 * cancellation, so compensations must not fire.
 */
const releaseRetainedScopes = (retainedScopes: Map<string, Scope.Closeable>): Effect.Effect<void> =>
  Effect.forEach(
    Array.from(retainedScopes.keys()),
    (runId) => releaseRetainedScope({ retainedScopes }, runId, Exit.void),
    { discard: true }
  )

/**
 * The heartbeat-paced sweeps of a process-woken store.
 *
 * One transient defect (a `SQLITE_BUSY` escaping `waitingRuns()`'s
 * `orDie`, a wake failure) must not kill the sweeper for the rest of the
 * process lifetime (issue #44) — that would silently revert to pre-#27
 * behavior where cancel of parked runs is never delivered. Mirror
 * `armClock`'s hardening: expose the full cause, log it, and keep ticking.
 */
const sweepForever = (driver: Driver): Effect.Effect<never, never, never> =>
  Effect.forever(
    Effect.sleep(Ownership.heartbeatInterval).pipe(
      Effect.andThen(
        resilientSweep(sweepCancelRequested(driver), "parked-run cancel").pipe(
          Effect.andThen(resilientSweep(sweepStaleRunning(driver), "stale-running")),
          Effect.andThen(resilientSweep(sweepReadyTimers(driver), "ready timer")),
          Effect.andThen(resilientSweep(sweepPendingCancellation(driver), "pending cancellation")),
          Effect.andThen(resilientSweep(sweepPending(driver), "pending admission"))
        )
      )
    )
  )

/**
 * Constructs a scoped run driver.
 *
 * Every start and wake enters the same keyed coordinator and then the same
 * exact-snapshot claim/activation path.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (
  dependencies: Dependencies
): Effect.Effect<
  Service,
  never,
  | Crypto.Crypto
  | DurableEngineState.DurableEngineState
  | DurableWriter
  | Journal.Journal
  | RunStore.RunStore
  | Scope.Scope
> =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    const writer = yield* DurableWriter
    const store = yield* RunStore.RunStore
    const engineState = yield* DurableEngineState.DurableEngineState
    const lineLevel = yield* RunMetrics.LineLevel
    const crypto = yield* Effect.context<Crypto.Crypto>()
    const retainedScopes = new Map<string, Scope.Closeable>()
    yield* Effect.addFinalizer(() => releaseRetainedScopes(retainedScopes))
    const coordinator = yield* RunCoordinator.make<string, never, Crypto.Crypto>({
      drain: (executionId) => drive(driver, executionId),
      resumeConcurrency: dependencies.resumeConcurrency
    })
    const driver: Driver = {
      dependencies,
      journal,
      writer,
      store,
      engineState,
      lifecycle: RunLifecycle.make(store, engineState),
      executionFacts: ExecutionFacts.make({
        runs: store,
        state: engineState,
        journal,
        sourceId: dependencies.journalSource
      }),
      transactState: StateTransaction.make(engineState, journal),
      wakeBus: dependencies.wakeBus ?? WakeBus.makeNoop(),
      coordinator,
      placement: RunMetrics.placement(dependencies.placement ?? "local"),
      lineLevel,
      hosted: typeof dependencies.sweep === "object",
      suppliedIsAlive: dependencies.isAlive,
      isAlive: dependencies.isAlive ?? Ownership.leaseLiveness(Ownership.heartbeatStaleAfter),
      registrations: new Map(),
      warnedUnregistered: new Set(),
      stealRefusals: new Map(),
      waitNotices: new Map(),
      liveInstances: new Map(),
      yielding: new Set(),
      retainedScopes,
      pendingCycles: new Map(),
      pendingCancellationCycle: undefined,
      pendingFlowOffset: 0,
      crypto,
      retries: new WeakMap()
    }
    // A hosted store is woken by its host, so it runs no sweep of its own.
    if (!driver.hosted) yield* Effect.forkScoped(sweepForever(driver))
    return service(driver)
  })
