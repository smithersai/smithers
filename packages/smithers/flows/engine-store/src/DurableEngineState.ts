/**
 * Durable deferred-completion and clock-deadline state used by the flow
 * engine adapter.
 *
 * A parked run keeps the `suspended` status the run store admits; there is
 * no `waiting` status. The waiting taxonomy lives beside it on the run row
 * in the `waiting_reason`, `waiting_wake_at_ms`, `waiting_token`, and
 * `waiting_request` columns, written by `park` and cleared by `wake`. See
 * `docs/concepts/durable-waits.md`.
 *
 * @since 0.1.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import { afterCommit, DatabaseError, DurableWriter } from "@smthrs/database/DurableWriter"
import { contentDigest } from "@smthrs/journal/JournalEvent"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as SqlClient from "effect/sql/SqlClient"
import * as SqlError from "effect/sql/SqlError"
import * as AttemptProbe from "./internal/AttemptProbe.ts"
import * as EngineStateSchema from "./internal/EngineStateSchema.ts"
import { compareText } from "./internal/Ordering.ts"
import type { OnParentExit } from "./RunState.ts"

/**
 * A position in pending admission creation order.
 *
 * @since 1.0.0
 * @category models
 */
export interface PendingRunCursor {
  readonly runId: string
  readonly createdAtMs: number
}

const pendingCancellationLimit = (limit: number): Effect.Effect<void> =>
  Number.isSafeInteger(limit) && limit >= 0
    ? Effect.void
    : Effect.die(new RangeError("Pending cancellation limit must be a non-negative safe integer"))

/** JSON text carrying an arbitrary decoded value. */
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown)

/** @private */
const NonNegativeSafeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * The durable address of a deferred result.
 *
 * @since 0.1.0
 * @category models
 */
export const DeferredAddress = Schema.Struct({
  flowName: Schema.NonEmptyString,
  executionId: Schema.NonEmptyString,
  deferredName: Schema.NonEmptyString
})

/**
 * The durable address of a deferred result.
 *
 * @category models
 * @since 0.1.0
 */
export type DeferredAddress = typeof DeferredAddress.Type

/**
 * The first durable completion recorded for a deferred.
 *
 * Correlation data remains opaque at this boundary. A future external-event
 * layer owns its schema and authorization policy.
 *
 * @since 0.1.0
 * @category models
 */
export const DeferredRow = Schema.Struct({
  ...DeferredAddress.fields,
  exit: Schema.Unknown,
  metadata: Schema.optionalKey(Schema.Unknown),
  completedAtMs: NonNegativeSafeInt
})

/**
 * The first durable completion recorded for a deferred.
 *
 * @category models
 * @since 0.1.0
 */
export type DeferredRow = typeof DeferredRow.Type

/**
 * Result of a first-writer-wins deferred completion.
 *
 * @since 0.1.0
 * @category models
 */
export type CompleteDeferredOutcome =
  | { readonly _tag: "Completed"; readonly row: DeferredRow; readonly digest: DeferredDigest }
  | { readonly _tag: "Existing"; readonly row: DeferredRow; readonly digest: DeferredDigest }

/**
 * The `JournalEvent.contentDigest` of a stored completion's encoded `exit`
 * and `metadata` text. The journal fact that announces a completion carries
 * these digests instead of the values, which stay in the row.
 *
 * @since 1.0.0
 * @category models
 */
export interface DeferredDigest {
  readonly exit: string
  readonly metadata: string | null
}

/**
 * The durable address of a clock.
 *
 * @since 0.1.0
 * @category models
 */
export const ClockAddress = Schema.Struct({
  flowName: Schema.NonEmptyString,
  executionId: Schema.NonEmptyString,
  clockName: Schema.NonEmptyString
})

/**
 * The durable address of a clock.
 *
 * @category models
 * @since 0.1.0
 */
export type ClockAddress = typeof ClockAddress.Type

/**
 * A durable absolute clock deadline.
 *
 * @since 0.1.0
 * @category models
 */
export const ClockRow = Schema.Struct({
  ...ClockAddress.fields,
  deferredName: Schema.NonEmptyString,
  dueAtMs: NonNegativeSafeInt,
  completedAtMs: Schema.NullOr(NonNegativeSafeInt)
})

/**
 * A durable absolute clock deadline.
 *
 * @category models
 * @since 0.1.0
 */
export type ClockRow = typeof ClockRow.Type

/**
 * Result of scheduling a durable clock.
 *
 * @since 0.1.0
 * @category models
 */
export type ScheduleClockOutcome =
  | { readonly _tag: "Scheduled"; readonly row: ClockRow }
  | { readonly _tag: "Existing"; readonly row: ClockRow }

/**
 * Result of completing a durable clock.
 *
 * @since 0.1.0
 * @category models
 */
export type CompleteClockOutcome =
  | { readonly _tag: "Completed"; readonly row: ClockRow }
  | { readonly _tag: "AlreadyCompleted"; readonly row: ClockRow }
  | { readonly _tag: "NotFound" }

/**
 * The core wait-reason vocabulary a supervisor understands for wake policy.
 *
 * - `approval` — parked until a human (or policy) approves; woken by token.
 * - `event` — parked on an external event / deferred completion.
 * - `timer` — parked until `wakeAt`; woken by the durable clock sweep.
 * - `quota` — parked on provider quota; woken at `wakeAt` when known.
 * - `released` — the owning process released the run without settling it
 *   (shutdown, heartbeat self-interrupt; issue #39). A released row has no
 *   held lease and no `wakeAt`: any supervisor/sweeper MUST scan for this
 *   reason explicitly and re-drive the run through the claim path, or
 *   released runs are stranded forever (issue #67).
 * - `quarantine` — parked because a SUCCEEDED attempt row's recorded
 *   evidence measured corrupt under the strict verdict (issue #171). The
 *   row cannot be evicted/re-executed like a cache row (its side effects
 *   already ran), so the corrupt boundary evidence is quarantined off the
 *   row while its durable outcome stays intact. No sweeper auto-wakes this
 *   reason: the strict integrity verdict remains visible until an explicit
 *   resume, which completes from the recorded outcome without re-execution.
 *
 * Left open (`string & {}`) so a plugin can park on a reason the core
 * taxonomy has not named yet — the store persists whatever it is given
 * rather than rejecting unknown reasons.
 *
 * @since 0.1.0
 * @category models
 */
export const WaitingReason = Schema.NonEmptyString

/**
 * The open wait-reason vocabulary.
 *
 * @category models
 * @since 0.1.0
 */
export type WaitingReason = typeof WaitingReason.Type

/**
 * The payload recorded when a run parks.
 *
 * `reason` and `wakeAt` earn columns because a supervisor sweeper queries
 * them (`WHERE waiting_reason = 'quota' AND waiting_wake_at_ms <= ?`);
 * `token` is compare-and-swap/lookup material a wake handler matches
 * against.
 *
 * @since 0.1.0
 * @category models
 */
export const Waiting = Schema.Struct({
  reason: WaitingReason,
  wakeAt: Schema.optional(NonNegativeSafeInt),
  token: Schema.optional(Schema.NonEmptyString),
  /**
   * What the wait declared about itself: for a `HumanTask` park, the kind of
   * answer it wants, the prompt, and the attempt budget.
   *
   * `reason` and `token` say that a person owes the run an answer and which
   * wait point holds it. Neither says what was asked, and the question lives
   * in an action payload of an execution that has released its owner, so a
   * reader had nothing to render but the wait's own name. This is the question
   * itself, as the JSON TEXT the declaring flow wrote, stored and cleared with
   * the other waiting columns.
   */
  request: Schema.optional(Schema.String)
})

/**
 * The payload recorded when a run parks.
 *
 * @category models
 * @since 0.1.0
 */
export type Waiting = typeof Waiting.Type

/**
 * A decoded waiting row for a parked run.
 *
 * @since 0.1.0
 * @category models
 */
export const WaitingRow = Schema.Struct({
  runId: Schema.NonEmptyString,
  reason: WaitingReason,
  wakeAt: Schema.NullOr(NonNegativeSafeInt),
  token: Schema.NullOr(Schema.NonEmptyString),
  /** The question {@link Waiting} declared, absent on a park that declared none. */
  request: Schema.optionalKey(Schema.Json)
})

/**
 * A decoded waiting row for a parked run.
 *
 * @category models
 * @since 0.1.0
 */
export type WaitingRow = typeof WaitingRow.Type

/**
 * A `running` row whose owner stopped heartbeating, and the lease it froze on.
 *
 * The heartbeat identifies the lease: a sweep that remembers a refusal against
 * one heartbeat must not apply it to a later stall of the same run.
 *
 * @category models
 * @since 1.0.0
 */
export interface StaleRunningRow {
  readonly runId: string
  readonly heartbeatAtMs: number
}

/**
 * A predicate over `waitingRuns` — omitted fields are unconstrained.
 *
 * @since 0.1.0
 * @category models
 */
export interface WaitingRunsFilter {
  readonly reason?: string
  readonly dueBeforeMs?: number
  /**
   * When `true`, only parked runs whose cancellation was durably requested
   * (`flows_runs.cancel_requested_at_ms IS NOT NULL`). Lets the parked-run
   * sweep fetch actionable rows instead of scanning every parked run and
   * probing each with a `store.get` (issue #68). The in-memory
   * implementation reads the flag from the `runs` view
   * (`MemoryRunView.cancelRequestedAtMs`); without a view it stays
   * permissive and the sweeper's own per-row guard decides.
   */
  readonly cancelRequested?: boolean
}

/**
 * Result of recording that a run parked on a waiting reason.
 *
 * @since 0.1.0
 * @category models
 */
export type ParkOutcome =
  | { readonly _tag: "Parked"; readonly row: WaitingRow }
  | { readonly _tag: "NotFound" }

/**
 * Result of clearing a run's waiting payload on wake.
 *
 * @since 0.1.0
 * @category models
 */
export type WakeOutcome =
  | { readonly _tag: "Woken"; readonly row: WaitingRow }
  | { readonly _tag: "NotWaiting" }
  | { readonly _tag: "NotFound" }

/**
 * A durable parent edge in the run DAG.
 *
 * The run row's `state_json` carries only the first (creating) parent; a
 * diamond gives a run a second parent the row cannot express. Cycle
 * detection must see every edge from every owner process and across
 * restarts (issues #40/#41), so edges are persisted here. `seq` is a
 * store-global insertion order used only to list a run's parents oldest
 * first (and to make the cycle walk deterministic); it no longer arbitrates
 * anything, so duplicate values would be harmless (issues #54/#66).
 *
 * @since 0.1.0
 * @category models
 */
export const RunParentEdge = Schema.Struct({
  childId: Schema.NonEmptyString,
  parentId: Schema.NonEmptyString,
  seq: NonNegativeSafeInt
})

/**
 * A durable parent edge in the run DAG.
 *
 * @category models
 * @since 0.1.0
 */
export type RunParentEdge = typeof RunParentEdge.Type

/**
 * The surviving attempt rows of one action key: the earliest surviving
 * row's start time and the highest attempt number contiguous from it.
 *
 * @since 0.1.0
 * @category models
 */
export const AttemptSurvivors = Schema.Struct({
  /**
   * The lowest surviving attempt number. Anything above 1 means the prune
   * job removed a leading run of attempts; the engine store applies the
   * pruned-prefix tolerance to it so both survivor paths agree (issue #96).
   */
  earliestAttempt: NonNegativeSafeInt,
  earliestStartedAtMs: NonNegativeSafeInt,
  latest: NonNegativeSafeInt
})

/**
 * The surviving attempt range of one action key.
 *
 * @category models
 * @since 0.1.0
 */
export type AttemptSurvivors = typeof AttemptSurvivors.Type

/**
 * Recording a parent edge would close a cycle in the run DAG.
 *
 * Raised from inside the same transaction that inserted the edge, which is
 * rolled back: a rejected edge leaves no durable trace anywhere (issues
 * #54/#55/#56). `path` lists execution ids from the child back to itself
 * through its would-be ancestors, matching the engine's
 * `FlowCycleDetected.path` shape.
 *
 * @since 0.1.0
 * @category errors
 */
export class RunParentCycleError extends Schema.TaggedError<RunParentCycleError>()(
  "@smthrs/engine-store/RunParentCycleError",
  {
    path: Schema.Array(Schema.String)
  }
) {}

/**
 * A durable engine-state invariant broke: a defect (a bug), never a typed
 * failure.
 *
 * `value_not_serializable` and `value_not_decodable` name the JSON column
 * (`field`) whose value could not be written or read back.
 * `deferred_completion_missing` and `run_parent_edge_missing` mean a row a
 * first-writer transaction just lost to was gone when read.
 *
 * @since 1.0.0
 * @category errors
 */
export class EngineStateFault extends Schema.TaggedError<EngineStateFault>()(
  "@smthrs/engine-store/EngineStateFault",
  {
    reason: Schema.Literals([
      "value_not_serializable",
      "value_not_decodable",
      "deferred_completion_missing",
      "run_parent_edge_missing"
    ]),
    field: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect())
  }
) {
  override get message(): string {
    switch (this.reason) {
      case "value_not_serializable":
        return `${this.field} must be JSON-serializable`
      case "value_not_decodable":
        return `could not decode ${this.field}`
      case "deferred_completion_missing":
        return "deferred completion disappeared during first-writer transaction"
      case "run_parent_edge_missing":
        return "run parent edge disappeared during first-writer transaction"
    }
  }
}

/**
 * Result of recording a durable parent edge (idempotent).
 *
 * @since 0.1.0
 * @category models
 */
export type RecordRunParentOutcome =
  | { readonly _tag: "Recorded"; readonly edge: RunParentEdge }
  | { readonly _tag: "Existing"; readonly edge: RunParentEdge }

/**
 * Minimal durable state missing from the current `@smthrs/journal` contract.
 *
 * A successful mutation means the row is durable. Callers may therefore
 * journal and schedule a wake only after the mutation returns. Deferred and
 * clock state belong to this package for 1.0.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  readonly deferred: (address: DeferredAddress) => Effect.Effect<Option.Option<DeferredRow>>
  /**
   * Marks an existing result observed without removing its replay evidence.
   * Returns whether this call consumed it: false when there is no result or
   * it was already consumed.
   */
  readonly consumeDeferred: (address: DeferredAddress, consumedAtMs: number) => Effect.Effect<boolean>
  readonly completeDeferred: (row: DeferredRow) => Effect.Effect<CompleteDeferredOutcome>
  readonly clock: (address: ClockAddress) => Effect.Effect<Option.Option<ClockRow>>
  /**
   * Schedules a clock while the execution is running under the supplied owner.
   * An existing clock wins unchanged, even after ownership is lost. If no
   * clock exists and the ownership fence fails, the effect self-interrupts.
   */
  readonly scheduleClock: (row: ClockRow, owner: OwnerId) => Effect.Effect<ScheduleClockOutcome>
  readonly completeClock: (
    address: ClockAddress,
    completedAtMs: number
  ) => Effect.Effect<CompleteClockOutcome>
  readonly dueClocks: (nowMs: number) => Effect.Effect<ReadonlyArray<ClockRow>>
  /**
   * Completes every uncompleted clock row of one run in a single statement.
   *
   * A run that settled has no future: a timer that fires against it can only
   * schedule a resume nothing will drive. Terminal transitions call this in
   * their own transaction, so the rows stop being pending with the run rather
   * than lingering as durable work no sweep will ever finish.
   *
   * It takes the run id rather than a clock address because the caller is
   * closing a RUN, and it does not read the run row, so it composes with a
   * terminal transition in either order.
   */
  readonly completeRunClocks: (
    executionId: string,
    completedAtMs: number
  ) => Effect.Effect<ReadonlyArray<ClockRow>>
  /**
   * Lists uncompleted clock rows scoped to an execution or flow, with no
   * due-time bound. Suspension-reason derivation and registration-time
   * recovery use this instead of abusing `dueClocks` as an all-clocks
   * listing (issue #35): `dueClocks` is a due-timer sweeper query and may
   * grow a result cap without affecting park correctness.
   *
   * Rows belonging to a settled run are never listed. Registration sweeps
   * this to re-arm timers, so without the run-status join every restart armed
   * one timer per clock row a flow ever wrote, for runs that ended long ago.
   */
  readonly pendingClocks: (scope: {
    readonly executionId?: string
    readonly flowName?: string
  }) => Effect.Effect<ReadonlyArray<ClockRow>>
  /** Whether one execution has an unconsumed completion or a due clock. */
  readonly hasDueWake: (executionId: string, nowMs: number) => Effect.Effect<boolean>
  /**
   * Lists unconsumed completed deferred addresses for registration-time wake recovery:
   * `flowName`'s, or every flow's when it is `undefined`, as one recovery for
   * many registrations reads them.
   * Observed results remain readable through `deferred` but cannot re-drive a
   * run that has moved on to a later wait.
   *
   * Rows belonging to a settled run are never listed, for the reason
   * {@link Service.pendingClocks} gives: this is swept on every registration,
   * and one resume per completion in a flow's whole history is unbounded work
   * that can wake nothing.
   */
  readonly completedDeferreds: (
    flowName: string | undefined,
    executionId?: string
  ) => Effect.Effect<ReadonlyArray<DeferredAddress>>
  /**
   * Records the waiting-reason payload for a parked run, fenced to the
   * current owner so a stale process cannot park a run it no longer runs.
   */
  readonly park: (
    runId: string,
    waiting: Waiting,
    owner: OwnerId
  ) => Effect.Effect<ParkOutcome>
  /**
   * Clears a run's waiting payload on wake or resume. Idempotent: waking a
   * run that is not waiting reports `NotWaiting` rather than failing.
   */
  readonly wake: (runId: string) => Effect.Effect<WakeOutcome>
  /**
   * Reads the current waiting payload for a run, if any.
   */
  readonly waiting: (runId: string) => Effect.Effect<Option.Option<WaitingRow>>
  /**
   * Reads the waiting payloads of a run AND of every execution beneath it.
   *
   * A flow that calls another flow parks the CHILD execution, not the run an
   * operator named: `coding/request` sat at `waiting_reason = 'event'` while
   * the `HumanTask` a person actually had to answer was three executions down,
   * on `coding/PreparePlan`. Reading one row therefore answered "nothing is
   * waiting on you" about a run tree that was waiting on a person, which is
   * how run-3 parked forever with an empty approvals inbox.
   *
   * The walk follows every `flows_run_parents` spawn edge and `parent_run_id`
   * link, so it sees shared children, forks, and trampoline rounds alike.
   * Each run appears once, ordered by minimum depth, creation time, then run
   * ID; the named run comes first. Rows of a settled execution are never
   * listed — a wait a finished execution left behind is not one a person
   * can answer.
   *
   * A DETACHED child and everything under it are skipped. `onParentExit:
   * "detach"` is a fire-and-forget spawn whose whole point is to outlive the
   * run that started it, so its question is not one the run that started it is
   * waiting on, and reporting it here would tell a reader that a run which can
   * proceed cannot. Every other edge is attached: the run is waiting for that
   * child's value, whether its own row has flipped to `suspended` yet or not.
   * Trampoline links continue the same run, so an inherited detach policy
   * does not hide later rounds from that run's own tree.
   *
   * `{ detached: "include" }` walks detached subtrees too, for a caller asking
   * what an explicit resume of the run would restart rather than what the run
   * itself waits on.
   */
  readonly waitingTree: (
    runId: string,
    options?: WaitingTreeOptions | undefined
  ) => Effect.Effect<ReadonlyArray<WaitingRow>>
  /**
   * Lists parked runs matching an optional reason/due-before filter, ordered
   * for sweeper consumption (earliest wake first, untimed waits last, then
   * run id to break ties).
   */
  readonly waitingRuns: (
    filter?: WaitingRunsFilter
  ) => Effect.Effect<ReadonlyArray<WaitingRow>>
  /** Pending admissions ordered by creation, strictly after and through optional cursors. */
  readonly pendingRuns: (
    flowName: string,
    limit?: number | undefined,
    after?: PendingRunCursor | undefined,
    through?: PendingRunCursor | undefined,
    eligibleBeforeMs?: number | undefined
  ) => Effect.Effect<ReadonlyArray<PendingRunCursor>>
  /** Latest pending admission, bounding one finite recovery scan cycle. */
  readonly pendingRunTail: (
    flowName: string,
    eligibleBeforeMs?: number | undefined
  ) => Effect.Effect<Option.Option<PendingRunCursor>>
  /** Pending cancellation requests in bounded creation order; limit is zero or a positive safe integer. */
  readonly pendingCancellationRuns: (
    limit: number,
    after?: PendingRunCursor | undefined,
    through?: PendingRunCursor | undefined
  ) => Effect.Effect<ReadonlyArray<PendingRunCursor>>
  /** Latest pending cancellation, bounding one finite cleanup scan cycle. */
  readonly pendingCancellationTail: () => Effect.Effect<Option.Option<PendingRunCursor>>
  /**
   * Lists the runs whose row is `running` with a heartbeat strictly older
   * than `staleBeforeMs`, each with that heartbeat — an owner that stopped heartbeating without
   * releasing the run (SIGKILL, OOM, power loss). Nothing else ever
   * revisits such a run: it has no waiting row for the parked-run sweep,
   * no pending clock, and no future deferred completion. A periodic
   * sweeper re-drives these through the ordinary claim/steal path — the
   * analog of Temporal's task-timeout re-dispatch (issue #53).
   *
   * `limit` caps one enumeration (issue #79): the rows come back oldest
   * heartbeat first, so a capped sweep drains a mass owner death across
   * ticks instead of waking every stale run in every driver every tick.
   */
  readonly staleRunningRuns: (
    staleBeforeMs: number,
    limit?: number | undefined
  ) => Effect.Effect<ReadonlyArray<StaleRunningRow>>
  /**
   * Copies the step attempts `attempts` of execution `from` into execution
   * `to` as recorded, and answers how many rows it wrote. A retry from a step
   * seeds its new execution with them, so their recorded outcomes replay
   * instead of their bodies running again. A ref with no row in `from`, or
   * one `to` already holds, writes nothing.
   *
   * Optional because only storage that holds `flows_attempts` implements it;
   * an engine over storage without it refuses a retry from a step.
   */
  readonly copyAttempts?:
    | ((options: {
      readonly from: string
      readonly to: string
      readonly attempts: ReadonlyArray<AttemptRef>
    }) => Effect.Effect<number>)
    | undefined
  /**
   * The surviving attempt rows for an action key, in one range read: the
   * earliest surviving row's start time (the durable retry origin when
   * attempt 1 itself was pruned, issue #69) and the highest attempt number
   * contiguous from it (the resumed attempt counter, issue #59).
   * `Option.none()` means no attempt row survives.
   *
   * Optional because only storage that can range-scan `flows_attempts`
   * implements it; when absent the engine store falls back to per-attempt
   * point reads against `AttemptStore` (issue #77).
   */
  readonly attemptSurvivors?:
    | ((
      runId: string,
      stepKeyDigest: string
    ) => Effect.Effect<Option.Option<AttemptSurvivors>>)
    | undefined
  /**
   * Durably records a parent edge in the run DAG, first-writer-wins per
   * `(child, parent)` pair.
   *
   * The cycle check happens inside the same transaction as the insert: the
   * edge is inserted, the child's ancestor chain is walked over the durable
   * edges, and on a hit the transaction rolls back and the call fails with
   * `RunParentCycleError`. There is no window between insert and check, no
   * arbitration, and no withdrawal protocol — concurrent writers that
   * jointly close a cycle serialize on the write transaction and exactly
   * one of them fails (issues #29/#40/#54/#55/#56).
   */
  readonly recordRunParent: (
    childId: string,
    parentId: string
  ) => Effect.Effect<RecordRunParentOutcome, RunParentCycleError>
  /**
   * Removes every parent edge touching a run — both the edges naming it as
   * child and the edges naming it as parent. The cleanup half of run
   * deletion (issue #66): a lane that deletes run rows (time-travel,
   * retention) must call this so `runParents` and the cycle walk stop
   * seeing edges of runs that no longer exist.
   */
  readonly removeRunParentsForRun: (runId: string) => Effect.Effect<void>
  /**
   * Lists the durably recorded parent edges of a run, oldest first.
   */
  readonly runParents: (childId: string) => Effect.Effect<ReadonlyArray<RunParentEdge>>
  /**
   * Lists the durably recorded child edges of a run, oldest first.
   *
   * The reverse direction of `runParents`, and the only instance-independent
   * way to find the runs a cancelled parent linked to itself. Cancellation
   * cascade reads it rather than an in-process instance map, so a
   * cross-process cancel observed by a driver that never spawned the children
   * still reaches them (`docs/concepts/durable-waits.md`, "The run DAG").
   * Served by the
   * `flows_run_parents_parent_idx` index.
   */
  readonly runChildren: (parentId: string) => Effect.Effect<ReadonlyArray<RunParentEdge>>
  /**
   * Runs `effect` inside one storage write transaction, so a caller can make
   * several store operations atomic — the run driver wraps the parent-edge
   * record and the run-row creation it guards, closing the crash window that
   * left a durable orphan edge for a run that was never created (issue #80).
   * Nested store writes become savepoints of this transaction. Storage
   * failures are defects, matching the store methods' own posture.
   *
   * The in-memory twin honors the same contract: it serializes every store
   * operation behind one permit, snapshots its state maps on entry, restores
   * them when the effect fails or dies, and treats a nested call on the same
   * fiber as a savepoint of the outer one. What it cannot offer is
   * durability: a process crash mid-transaction loses the whole state, not
   * only the uncommitted part.
   *
   * **Lock order.** A caller that needs this transaction AND the journal's
   * write transaction opens this one OUTSIDE. The SQL implementation cannot
   * tell the difference, because both are the same `DurableWriter`
   * transaction and either nests as a savepoint of the other; the memory twin
   * has a permit of its own, and a fiber that holds the journal's writer
   * while waiting for that permit deadlocks against a fiber doing the
   * opposite. Interruption is not a way out of that cycle: both boundaries
   * are acquired at the caller's own interruptibility, so a settlement that
   * masked interruption to finish its write keeps waiting. The same
   * rule applies to every single operation above, each of which takes the
   * permit for itself: inside an open journal transaction, call them only
   * under an enclosing `transaction` on the same fiber.
   */
  readonly transaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    options?: {
      /**
       * Receives an idempotent memory commit effect. A coordinating durable
       * transaction may run it after COMMIT, before publishing or capturing
       * state. This accepts the snapshot and releases its gate; subsequent
       * publication failures cannot restore the old snapshot. Without an
       * external boundary, returning successfully commits as usual. SQL owns
       * its commit boundary and does not need this callback.
       */
      readonly onCommit?: ((commit: Effect.Effect<void>) => void) | undefined
      /**
       * The execution whose rows the transaction reads and changes, when it
       * touches no other's: it then waits only for that execution's writers
       * (`DurableWriter.WriteOptions`). Omitted, it waits for every writer.
       * The memory twin serializes everything and ignores it.
       */
      readonly partition?: string | undefined
    }
  ) => Effect.Effect<A, E, R>
  /**
   * Runs `effect` as one read snapshot: every read in it agrees with the
   * others, and it takes neither the writer permit nor the store's write lock.
   * Keep writes out of it.
   *
   * A read that needs one snapshot used `transaction`, a write transaction.
   * On SQLite that is `BEGIN IMMEDIATE` behind the process's one write permit,
   * so every health beat of every open run took the engine's write lock, and a
   * run's lease heartbeat queued behind those reads until its lease lapsed
   * (docs-sync, 2026-10-20).
   *
   * @since 1.0.0
   */
  readonly readTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

/**
 * One step attempt of a run: its step key digest and attempt number, the key
 * of a `flows_attempts` row within the run.
 *
 * @category models
 * @since 1.0.0
 */
export interface AttemptRef {
  readonly stepKeyDigest: string
  readonly attempt: number
}

/**
 * Service tag for durable deferred completions and absolute clock deadlines.
 *
 * @since 0.1.0
 * @category services
 */
export class DurableEngineState extends Context.Service<DurableEngineState, Service>()(
  "@smthrs/engine-store/DurableEngineState"
) {}

/** @private */
const deferredKey = (address: DeferredAddress): string =>
  JSON.stringify([address.flowName, address.executionId, address.deferredName])

/** @private */
const clockKey = (address: ClockAddress): string =>
  JSON.stringify([address.flowName, address.executionId, address.clockName])

/** @private */
const DeferredDatabaseRow = Schema.Struct({
  ...DeferredAddress.fields,
  exitJson: Schema.String,
  metadataJson: Schema.NullOr(Schema.String),
  completedAtMs: NonNegativeSafeInt
})

type DeferredDatabaseRow = typeof DeferredDatabaseRow.Type

/** @private */
const ClockDatabaseRow = Schema.Struct({
  ...ClockAddress.fields,
  deferredName: Schema.NonEmptyString,
  dueAtMs: NonNegativeSafeInt,
  completedAtMs: Schema.NullOr(NonNegativeSafeInt)
})

type ClockDatabaseRow = typeof ClockDatabaseRow.Type

/** @private */
const WaitingDatabaseRow = Schema.Struct({
  runId: Schema.NonEmptyString,
  waitingReason: WaitingReason,
  waitingWakeAtMs: Schema.NullOr(NonNegativeSafeInt),
  waitingToken: Schema.NullOr(Schema.NonEmptyString),
  /** Absent rather than null on a database written before `0004_waiting_request`. */
  waitingRequest: Schema.optional(Schema.NullOr(Schema.String))
})

type WaitingDatabaseRow = typeof WaitingDatabaseRow.Type

/**
 * The declared question of a waiting row, or absence.
 *
 * The column is the wait's own JSON, so text that does not parse is text the
 * writer never wrote: it is reported as no declared question rather than
 * failing the read of a park that is otherwise intact.
 */
const decodeWaitingRequest = (value: string | null | undefined): { readonly request?: unknown } => {
  if (value === null || value === undefined) return {}
  try {
    return { request: JSON.parse(value) as unknown }
  } catch {
    return {}
  }
}

const decodeWaitingRow = (input: unknown): Effect.Effect<WaitingRow> => decodeWaitingRowResult(input).pipe(Effect.orDie)

/** {@link decodeWaitingRow} with its parse failure left in the error channel. */
const decodeWaitingRowResult = (input: unknown): Effect.Effect<WaitingRow, unknown> =>
  Schema.decodeUnknownEffect(WaitingDatabaseRow)(input).pipe(
    Effect.map((row) => ({
      runId: row.runId,
      reason: row.waitingReason,
      wakeAt: row.waitingWakeAtMs,
      token: row.waitingToken,
      ...decodeWaitingRequest(row.waitingRequest)
    } as WaitingRow))
  )

/** @private */
const RunParentDatabaseRow = Schema.Struct({
  childId: Schema.NonEmptyString,
  parentId: Schema.NonEmptyString,
  seq: NonNegativeSafeInt
})

type RunParentDatabaseRow = typeof RunParentDatabaseRow.Type

const decodeRunParentEdge = (input: unknown): Effect.Effect<RunParentEdge> =>
  decodeRunParentEdgeResult(input).pipe(Effect.orDie)

/** {@link decodeRunParentEdge} with its parse failure left in the error channel. */
const decodeRunParentEdgeResult = (input: unknown): Effect.Effect<RunParentEdge, unknown> =>
  Schema.decodeUnknownEffect(RunParentDatabaseRow)(input)

/**
 * Walks the parent chain upward from `parentId` over the durable edges,
 * looking for `childId`. Returns the cycle path the new `(childId,
 * parentId)` edge would close — ids from the child back to itself, matching
 * the engine's `FlowCycleDetected.path` shape — or `undefined` when the
 * edge is safe. A repeated id (pre-existing corrupt cycle written outside
 * this API) terminates that branch instead of looping forever.
 */
const findCyclePath = (
  childId: string,
  parentId: string,
  parentsOf: (id: string) => Effect.Effect<ReadonlyArray<string>>
): Effect.Effect<ReadonlyArray<string> | undefined> =>
  Effect.suspend(() => {
    if (parentId === childId) {
      return Effect.succeed<ReadonlyArray<string> | undefined>([childId])
    }
    const seen = new Set<string>([parentId])
    const walk = (
      current: string,
      chain: ReadonlyArray<string>
    ): Effect.Effect<ReadonlyArray<string> | undefined> =>
      Effect.gen(function*() {
        const parents = yield* parentsOf(current)
        for (const parent of parents) {
          if (parent === childId) return [...chain, parent].reverse()
          if (seen.has(parent)) continue
          seen.add(parent)
          const found = yield* walk(parent, [...chain, parent])
          if (found !== undefined) return found
        }
        return undefined
      })
    return walk(parentId, [parentId])
  })

/** @private */
const DeferredAddressDatabaseRow = DeferredAddress

/** The digests of a stored completion row's encoded text. */
const deferredDigest = (row: {
  readonly exitJson: string
  readonly metadataJson: string | null
}): DeferredDigest => ({
  exit: contentDigest(row.exitJson),
  metadata: row.metadataJson === null ? null : contentDigest(row.metadataJson)
})

/** The digests of a memory completion row, over the text the SQL store would keep. */
const memoryDigest = (row: DeferredRow): Effect.Effect<DeferredDigest> =>
  Effect.gen(function*() {
    const exitJson = yield* encodeJson(row.exit, "exit")
    const metadataJson = row.metadata === undefined ? null : yield* encodeJson(row.metadata, "metadata")
    return deferredDigest({ exitJson, metadataJson })
  })

const encodeJson = (value: unknown, field: string): Effect.Effect<string> =>
  Schema.encodeEffect(UnknownFromJsonString)(value).pipe(
    Effect.mapError((cause) => new EngineStateFault({ reason: "value_not_serializable", field, cause })),
    Effect.orDie
  )

const decodeJson = (value: string, field: string): Effect.Effect<unknown> =>
  Schema.decodeUnknownEffect(UnknownFromJsonString)(value).pipe(
    Effect.mapError((cause) => new EngineStateFault({ reason: "value_not_decodable", field, cause })),
    Effect.orDie
  )

/**
 * Rehydrates Effect's JSON representation after a storage round-trip.
 *
 * `Exit` and `Cause` deliberately serialize as plain JSON objects. Leaving a
 * failure in that form is unsafe: the success branch happens to be rebuilt by
 * `Exit.map`, while a plain failure is not an Exit and the deferred's schema
 * rejects it after restart. Unknown non-Exit payloads remain untouched for
 * the generic durable-state contract.
 */
const restoreJsonExit = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value
  const record = value as Record<string, unknown>
  if (record["_id"] !== "Exit") return value
  if (record["_tag"] === "Success") return Exit.succeed(record["value"])
  if (record["_tag"] !== "Failure") return value
  const cause = record["cause"]
  if (typeof cause !== "object" || cause === null) return value
  const failures = (cause as Record<string, unknown>)["failures"]
  if (!Array.isArray(failures)) return value
  const reasons: Array<Cause.Reason<unknown>> = []
  for (const failure of failures) {
    if (typeof failure !== "object" || failure === null) return value
    const reason = failure as Record<string, unknown>
    switch (reason["_tag"]) {
      case "Fail":
        reasons.push(Cause.makeFailReason(reason["error"]))
        break
      case "Die":
        reasons.push(Cause.makeDieReason(reason["defect"]))
        break
      case "Interrupt":
        reasons.push(Cause.makeInterruptReason(
          typeof reason["fiberId"] === "number" ? reason["fiberId"] : undefined
        ))
        break
      default:
        return value
    }
  }
  return Exit.failCause(Cause.fromReasons(reasons))
}

const decodeDeferredRow = (input: unknown): Effect.Effect<DeferredRow> =>
  Schema.decodeUnknownEffect(DeferredDatabaseRow)(input).pipe(
    Effect.orDie,
    Effect.flatMap((row) =>
      Effect.all({
        exit: decodeJson(row.exitJson, "exit_json").pipe(Effect.map(restoreJsonExit)),
        metadata: row.metadataJson === null
          ? Effect.succeed(undefined)
          : decodeJson(row.metadataJson, "metadata_json")
      }).pipe(
        Effect.map(({ exit, metadata }) => ({
          flowName: row.flowName,
          executionId: row.executionId,
          deferredName: row.deferredName,
          exit,
          ...(metadata === undefined ? {} : { metadata }),
          completedAtMs: row.completedAtMs
        }))
      )
    )
  )

const decodeClockRow = (input: unknown): Effect.Effect<ClockRow> => decodeClockRowResult(input).pipe(Effect.orDie)

/** {@link decodeClockRow} with its parse failure left in the error channel. */
const decodeClockRowResult = (input: unknown): Effect.Effect<ClockRow, unknown> =>
  Schema.decodeUnknownEffect(ClockDatabaseRow)(input).pipe(
    Effect.map((row) => ({
      flowName: row.flowName,
      executionId: row.executionId,
      clockName: row.clockName,
      deferredName: row.deferredName,
      dueAtMs: row.dueAtMs,
      completedAtMs: row.completedAtMs
    }))
  )

/** The primary key of a clock row, read defensively off a row that may not decode. */
const clockRowKey = (row: Record<string, unknown>): string =>
  JSON.stringify([row["flowName"], row["executionId"], row["clockName"]])

/** The primary key of a deferred completion, read the same way. */
const deferredAddressRowKey = (row: Record<string, unknown>): string =>
  JSON.stringify([row["flowName"], row["executionId"], row["deferredName"]])

/** The primary key of a run-parent edge, read the same way. */
const runParentRowKey = (row: Record<string, unknown>): string => JSON.stringify([row["childId"], row["parentId"]])

/**
 * How far {@link Service.waitingTree} walks: detached subtrees are skipped
 * unless `detached` is `"include"`.
 *
 * @since 1.0.0
 * @category models
 */
export interface WaitingTreeOptions {
  readonly detached?: "skip" | "include" | undefined
}

/**
 * The deepest nesting {@link Service.waitingTree} walks.
 *
 * A run tree is authored, not generated: `agent/run` → `coding/request` →
 * `coding/Request` → `coding/PrepareWithWiki` → `coding/PreparePlan` is five,
 * and the deepest composition in this repository is well inside this. The cap
 * exists so a tree whose edges were corrupted outside the engine costs a
 * bounded read rather than the whole table.
 *
 * @since 1.0.0
 * @category constants
 */
export const waitingTreeMaxDepth = 64

/** The primary key of a parked run's waiting payload, read the same way. */
const waitingRowKey = (row: Record<string, unknown>): string => JSON.stringify([row["runId"]])

/**
 * Decodes the rows one durable-state sweep read, skipping — with a
 * storage-integrity warning naming the row's key — any row that will not
 * decode.
 *
 * Decoding the batch through `Effect.orDie` made one malformed row fatal for
 * every row beside it: `completedDeferreds` and `pendingClocks` are what
 * `register` sweeps, so a single unreadable row anywhere in a flow's history
 * killed every registration of that flow, and no run of it ever resumed again.
 * The blast radius of a corrupt row must be that row. The key is logged
 * because it is what an operator needs to find and repair it, and it is read
 * field by field off the raw row so a row that failed to decode can still name
 * itself.
 *
 * Every enumeration goes through here for that reason, not just the two the
 * outage named: `dueClocks`, `waitingRuns`, `runParents`, and `runChildren`
 * each had their own version of it — no timer in the store fires, no parked
 * run is ever swept, no cycle check can read a run's ancestry, no
 * cancellation reaches a child.
 *
 * The point reads (`deferred`, `clock`, `waiting`) deliberately stay on
 * `Effect.orDie`. They answer a question about ONE row, and their callers
 * read "no row" as "this never happened": silently reporting that for a
 * completion or deadline that is durably recorded but unreadable would
 * re-run work whose side effects already ran. There the corrupt row IS the
 * blast radius, so dying is the correct-sized failure.
 */
const decodeSweep = <A>(
  rows: ReadonlyArray<Record<string, unknown>>,
  kind: string,
  keyOf: (row: Record<string, unknown>) => string,
  decode: (row: Record<string, unknown>) => Effect.Effect<A, unknown>
): Effect.Effect<ReadonlyArray<A>> =>
  Effect.gen(function*() {
    const decoded: Array<A> = []
    for (const row of rows) {
      const result = yield* Effect.result(decode(row))
      if (Result.isSuccess(result)) {
        decoded.push(result.success)
        continue
      }
      yield* Effect.logWarning(
        `engine-store: skipping a malformed ${kind} row ${keyOf(row)}`,
        result.failure
      )
    }
    return decoded
  })

/**
 * Demotes a write boundary's storage failures to defects, reason by reason.
 *
 * `transaction` declares the BODY's error type, and the shared writer adds
 * `DatabaseError` to it. A sole storage failure is already a defect; a
 * composite one used to be cast back through the declared channel, which let
 * a raw `DatabaseError` surface as a typed failure of a type that never
 * admits one. Re-channelling keeps the error object, its annotations, the
 * other reasons and the interruptions intact while making the declared type
 * true. Every other reason is passed through UNCHANGED rather than rebuilt,
 * so a body failure keeps its own identity and spans.
 */
const dieOnDatabaseError = <E>(cause: Cause.Cause<E | DatabaseError>): Cause.Cause<E> =>
  Cause.fromReasons(
    cause.reasons.map((reason) =>
      Cause.isFailReason(reason) && reason.error instanceof DatabaseError
        ? Cause.makeDieReason(reason.error).annotate(Cause.reasonAnnotations(reason))
        // Narrowing a generic union by `instanceof` is beyond the checker, but
        // the guard above is the proof: what is left is a defect, an
        // interruption, or a failure whose error is not a `DatabaseError`.
        : reason as Cause.Reason<E>
    )
  )

/**
 * What every statement of the database-backed state runs against: the
 * connection, the shared writer, and the gate that orders this store's
 * write transactions.
 */
interface Database {
  readonly sql: SqlClient.SqlClient
  readonly writer: DurableWriter["Service"]
  /**
   * Keep state-first ordering. This gate and DurableWriter's shared permit are
   * both taken at the caller's interruptibility, so an interruptible caller can
   * still be cancelled while queued, including behind a journal-only write that
   * skips this gate.
   * A nested SQL transaction already owns the connection and bypasses this gate.
   */
  readonly transactionGate: Semaphore.Semaphore
}

const selectDeferred = (db: Database, address: DeferredAddress) =>
  db.sql<DeferredDatabaseRow>`
      SELECT
        flow_name AS "flowName",
        execution_id AS "executionId",
        deferred_name AS "deferredName",
        exit_json AS "exitJson",
        metadata_json AS "metadataJson",
        completed_at_ms AS "completedAtMs"
      FROM flows_deferred_completions
      WHERE flow_name = ${address.flowName}
        AND execution_id = ${address.executionId}
        AND deferred_name = ${address.deferredName}
    `

const selectClock = (db: Database, address: ClockAddress) =>
  db.sql<ClockDatabaseRow>`
      SELECT
        flow_name AS "flowName",
        execution_id AS "executionId",
        clock_name AS "clockName",
        deferred_name AS "deferredName",
        due_at_ms AS "dueAtMs",
        completed_at_ms AS "completedAtMs"
      FROM flows_clock_deadlines
      WHERE flow_name = ${address.flowName}
        AND execution_id = ${address.executionId}
        AND clock_name = ${address.clockName}
    `

const deferred = (db: Database): Service["deferred"] =>
  Effect.fn("DurableEngineState.deferred")((address) =>
    selectDeferred(db, address).pipe(
      Effect.orDie,
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeedNone
          : Effect.map(decodeDeferredRow(rows[0]), Option.some)
      )
    )
  )

const consumeDeferred = (db: Database): Service["consumeDeferred"] =>
  Effect.fn("DurableEngineState.consumeDeferred")((
    address,
    consumedAtMs
  ) =>
    writeRun(
      db,
      address.executionId,
      db.sql<{ readonly flowName: string }>`
      UPDATE flows_deferred_completions
      SET consumed_at_ms = ${consumedAtMs}
      WHERE flow_name = ${address.flowName}
        AND execution_id = ${address.executionId}
        AND deferred_name = ${address.deferredName}
        AND consumed_at_ms IS NULL
      RETURNING flow_name AS "flowName"
    `
    ).pipe(Effect.orDie, Effect.map((rows) => rows.length > 0))
  )

const completeDeferred = (db: Database): Service["completeDeferred"] =>
  Effect.fn(
    "DurableEngineState.completeDeferred"
  )((row) =>
    Effect.gen(function*() {
      const exitJson = yield* encodeJson(row.exit, "exit")
      const metadataJson = row.metadata === undefined
        ? null
        : yield* encodeJson(row.metadata, "metadata")
      return yield* writeRun(
        db,
        row.executionId,
        Effect.gen(function*() {
          const inserted = yield* db.sql<DeferredDatabaseRow>`
            INSERT INTO flows_deferred_completions (
              flow_name,
              execution_id,
              deferred_name,
              exit_json,
              metadata_json,
              completed_at_ms
            ) VALUES (
              ${row.flowName},
              ${row.executionId},
              ${row.deferredName},
              ${exitJson},
              ${metadataJson},
              ${row.completedAtMs}
            )
            ON CONFLICT (flow_name, execution_id, deferred_name) DO NOTHING
            RETURNING
              flow_name AS "flowName",
              execution_id AS "executionId",
              deferred_name AS "deferredName",
              exit_json AS "exitJson",
              metadata_json AS "metadataJson",
              completed_at_ms AS "completedAtMs"
          `
          if (inserted[0] !== undefined) {
            return {
              _tag: "Completed" as const,
              row: yield* decodeDeferredRow(inserted[0]),
              digest: deferredDigest(inserted[0])
            }
          }
          const existing = yield* selectDeferred(db, row)
          if (existing[0] === undefined) {
            return yield* Effect.die(new EngineStateFault({ reason: "deferred_completion_missing" }))
          }
          return {
            _tag: "Existing" as const,
            row: yield* decodeDeferredRow(existing[0]),
            digest: deferredDigest(existing[0])
          }
        })
      ).pipe(Effect.orDie)
    })
  )

const clock = (db: Database): Service["clock"] =>
  Effect.fn("DurableEngineState.clock")((address) =>
    selectClock(db, address).pipe(
      Effect.orDie,
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeedNone
          : Effect.map(decodeClockRow(rows[0]), Option.some)
      )
    )
  )

const scheduleClock = (db: Database): Service["scheduleClock"] =>
  Effect.fn("DurableEngineState.scheduleClock")((row, owner) =>
    writeRun(
      db,
      row.executionId,
      Effect.gen(function*() {
        const inserted = yield* db.sql<ClockDatabaseRow>`
          INSERT INTO flows_clock_deadlines (
            flow_name,
            execution_id,
            clock_name,
            deferred_name,
            due_at_ms,
            completed_at_ms
          )
          SELECT
            ${row.flowName},
            ${row.executionId},
            ${row.clockName},
            ${row.deferredName},
            ${row.dueAtMs},
            ${row.completedAtMs}
          WHERE EXISTS (
            SELECT 1
            FROM flows_runs
            WHERE run_id = ${row.executionId}
              AND status = 'running'
              AND owner_host_id = ${owner.hostId}
              AND owner_pid = ${owner.pid}
              AND owner_nonce = ${owner.nonce}
          )
          ON CONFLICT (flow_name, execution_id, clock_name) DO NOTHING
          RETURNING
            flow_name AS "flowName",
            execution_id AS "executionId",
            clock_name AS "clockName",
            deferred_name AS "deferredName",
            due_at_ms AS "dueAtMs",
            completed_at_ms AS "completedAtMs"
        `
        if (inserted[0] !== undefined) {
          return {
            _tag: "Scheduled" as const,
            row: yield* decodeClockRow(inserted[0])
          }
        }
        const existing = yield* selectClock(db, row)
        if (existing[0] !== undefined) {
          return {
            _tag: "Existing" as const,
            row: yield* decodeClockRow(existing[0])
          }
        }
        return yield* Effect.interrupt
      })
    ).pipe(Effect.orDie)
  )

const completeClock = (db: Database): Service["completeClock"] =>
  Effect.fn("DurableEngineState.completeClock")((
    address,
    completedAtMs
  ) =>
    writeRun(
      db,
      address.executionId,
      Effect.gen(function*() {
        const updated = yield* db.sql<ClockDatabaseRow>`
          UPDATE flows_clock_deadlines
          SET completed_at_ms = ${completedAtMs}
          WHERE flow_name = ${address.flowName}
            AND execution_id = ${address.executionId}
            AND clock_name = ${address.clockName}
            AND completed_at_ms IS NULL
          RETURNING
            flow_name AS "flowName",
            execution_id AS "executionId",
            clock_name AS "clockName",
            deferred_name AS "deferredName",
            due_at_ms AS "dueAtMs",
            completed_at_ms AS "completedAtMs"
        `
        if (updated[0] !== undefined) {
          return {
            _tag: "Completed" as const,
            row: yield* decodeClockRow(updated[0])
          }
        }
        const existing = yield* selectClock(db, address)
        return existing[0] === undefined
          ? { _tag: "NotFound" as const }
          : {
            _tag: "AlreadyCompleted" as const,
            row: yield* decodeClockRow(existing[0])
          }
      })
    ).pipe(Effect.orDie)
  )

const dueClocks = (db: Database): Service["dueClocks"] =>
  Effect.fn("DurableEngineState.dueClocks")((nowMs) =>
    db.sql<ClockDatabaseRow>`
      SELECT
        flow_name AS "flowName",
        execution_id AS "executionId",
        clock_name AS "clockName",
        deferred_name AS "deferredName",
        due_at_ms AS "dueAtMs",
        completed_at_ms AS "completedAtMs"
      FROM flows_clock_deadlines
      WHERE completed_at_ms IS NULL
        AND due_at_ms <= ${nowMs}
      ORDER BY due_at_ms, execution_id, clock_name
    `.pipe(
      Effect.orDie,
      // This is the whole store's due-timer sweep: dying on one unreadable
      // deadline stopped every timer in every flow from firing.
      Effect.flatMap((rows) => decodeSweep(rows, "clock deadline", clockRowKey, decodeClockRowResult))
    )
  )

const pendingClocks = (db: Database): Service["pendingClocks"] =>
  Effect.fn("DurableEngineState.pendingClocks")((scope) =>
    (scope.executionId !== undefined
      ? db.sql<ClockDatabaseRow>`
      SELECT
        flow_name AS "flowName",
        execution_id AS "executionId",
        clock_name AS "clockName",
        deferred_name AS "deferredName",
        due_at_ms AS "dueAtMs",
        completed_at_ms AS "completedAtMs"
      FROM flows_clock_deadlines
      WHERE completed_at_ms IS NULL
        AND execution_id = ${scope.executionId}
        AND ${scope.flowName === undefined ? db.sql`1 = 1` : db.sql`flow_name = ${scope.flowName}`}
        AND EXISTS (
          SELECT 1 FROM flows_runs
          WHERE flows_runs.run_id = flows_clock_deadlines.execution_id
            AND flows_runs.status NOT IN ('completed', 'failed', 'cancelled')
        )
      ORDER BY due_at_ms, execution_id, clock_name
    `
      : scope.flowName !== undefined
      ? db.sql<ClockDatabaseRow>`
      SELECT
        flow_name AS "flowName",
        execution_id AS "executionId",
        clock_name AS "clockName",
        deferred_name AS "deferredName",
        due_at_ms AS "dueAtMs",
        completed_at_ms AS "completedAtMs"
      FROM flows_clock_deadlines
      WHERE completed_at_ms IS NULL
        AND flow_name = ${scope.flowName}
        AND EXISTS (
          SELECT 1 FROM flows_runs
          WHERE flows_runs.run_id = flows_clock_deadlines.execution_id
            AND flows_runs.status NOT IN ('completed', 'failed', 'cancelled')
        )
      ORDER BY due_at_ms, execution_id, clock_name
    `
      : db.sql<ClockDatabaseRow>`
      SELECT
        flow_name AS "flowName",
        execution_id AS "executionId",
        clock_name AS "clockName",
        deferred_name AS "deferredName",
        due_at_ms AS "dueAtMs",
        completed_at_ms AS "completedAtMs"
      FROM flows_clock_deadlines
      WHERE completed_at_ms IS NULL
        AND EXISTS (
          SELECT 1 FROM flows_runs
          WHERE flows_runs.run_id = flows_clock_deadlines.execution_id
            AND flows_runs.status NOT IN ('completed', 'failed', 'cancelled')
        )
      ORDER BY due_at_ms, execution_id, clock_name
    `).pipe(
        Effect.orDie,
        // A row that will not decode is a storage-integrity event about that
        // row. Dying here made one of them fatal for the whole sweep, and so
        // for `register` itself (issue B-08).
        Effect.flatMap((rows) => decodeSweep(rows, "clock deadline", clockRowKey, decodeClockRowResult))
      )
  )

const hasDueWake = (db: Database): Service["hasDueWake"] => (executionId, nowMs) =>
  db.sql`
      SELECT 1 FROM flows_deferred_completions
      WHERE execution_id = ${executionId} AND consumed_at_ms IS NULL
      UNION ALL
      SELECT 1 FROM flows_clock_deadlines
      WHERE execution_id = ${executionId} AND completed_at_ms IS NULL AND due_at_ms <= ${nowMs}
      LIMIT 1
    `.pipe(Effect.orDie, Effect.map((rows) => rows.length > 0))

const completedDeferreds = (db: Database): Service["completedDeferreds"] =>
  Effect.fn(
    "DurableEngineState.completedDeferreds"
  )((flowName, executionId) =>
    db.sql<Record<string, unknown>>`
      SELECT
        flow_name AS "flowName",
        execution_id AS "executionId",
        deferred_name AS "deferredName"
      FROM flows_deferred_completions
      WHERE ${flowName === undefined ? db.sql`1 = 1` : db.sql`flow_name = ${flowName}`}
        AND ${executionId === undefined ? db.sql`1 = 1` : db.sql`execution_id = ${executionId}`}
        AND consumed_at_ms IS NULL
        AND EXISTS (
          SELECT 1 FROM flows_runs
          WHERE flows_runs.run_id = flows_deferred_completions.execution_id
            AND flows_runs.status NOT IN ('completed', 'failed', 'cancelled')
        )
      ORDER BY execution_id, deferred_name
    `.pipe(
      Effect.orDie,
      Effect.flatMap((rows) =>
        decodeSweep(
          rows,
          "deferred completion",
          deferredAddressRowKey,
          (row) => Schema.decodeUnknownEffect(DeferredAddressDatabaseRow)(row)
        )
      )
    )
  )

const completeRunClocks = (db: Database): Service["completeRunClocks"] =>
  Effect.fn(
    "DurableEngineState.completeRunClocks"
  )((executionId, completedAtMs) =>
    writeRun(
      db,
      executionId,
      db.sql<ClockDatabaseRow>`
      UPDATE flows_clock_deadlines
      SET completed_at_ms = ${completedAtMs}
      WHERE execution_id = ${executionId}
        AND completed_at_ms IS NULL
      RETURNING
        flow_name AS "flowName",
        execution_id AS "executionId",
        clock_name AS "clockName",
        deferred_name AS "deferredName",
        due_at_ms AS "dueAtMs",
        completed_at_ms AS "completedAtMs"
    `
    ).pipe(
      Effect.orDie,
      Effect.flatMap((rows) => Effect.forEach(rows, decodeClockRow)),
      Effect.map((rows) =>
        [...rows].sort((left, right) =>
          compareText(left.flowName, right.flowName) || compareText(left.clockName, right.clockName)
        )
      )
    )
  )

const selectWaiting = (db: Database, runId: string) =>
  db.sql<WaitingDatabaseRow>`
      SELECT
        run_id AS "runId",
        waiting_reason AS "waitingReason",
        waiting_wake_at_ms AS "waitingWakeAtMs",
        waiting_token AS "waitingToken",
        waiting_request AS "waitingRequest"
      FROM flows_runs
      WHERE run_id = ${runId}
        AND waiting_reason IS NOT NULL
    `

const park = (db: Database): Service["park"] =>
  Effect.fn("DurableEngineState.park")((runId, waiting, owner) =>
    writeRun(
      db,
      runId,
      Effect.gen(function*() {
        const updated = yield* db.sql<WaitingDatabaseRow>`
          UPDATE flows_runs
          SET
            waiting_reason = ${waiting.reason},
            waiting_wake_at_ms = ${waiting.wakeAt ?? null},
            waiting_token = ${waiting.token ?? null},
            waiting_request = ${waiting.request ?? null}
          WHERE run_id = ${runId}
            AND owner_host_id = ${owner.hostId}
            AND owner_pid = ${owner.pid}
            AND owner_nonce = ${owner.nonce}
          RETURNING
            run_id AS "runId",
            waiting_reason AS "waitingReason",
            waiting_wake_at_ms AS "waitingWakeAtMs",
            waiting_token AS "waitingToken",
            waiting_request AS "waitingRequest"
        `
        if (updated[0] === undefined) {
          return { _tag: "NotFound" as const }
        }
        return { _tag: "Parked" as const, row: yield* decodeWaitingRow(updated[0]) }
      })
    ).pipe(Effect.orDie)
  )

const wake = (db: Database): Service["wake"] =>
  Effect.fn("DurableEngineState.wake")((runId) =>
    writeRun(
      db,
      runId,
      Effect.gen(function*() {
        const before = yield* selectWaiting(db, runId)
        if (before[0] === undefined) {
          const existing = yield* db.sql<{ runId: string }>`
            SELECT run_id AS "runId" FROM flows_runs WHERE run_id = ${runId}
          `
          return existing[0] === undefined ? { _tag: "NotFound" as const } : { _tag: "NotWaiting" as const }
        }
        const row = yield* decodeWaitingRow(before[0])
        yield* db.sql`
          UPDATE flows_runs
          SET
            waiting_reason = NULL,
            waiting_wake_at_ms = NULL,
            waiting_token = NULL,
            waiting_request = NULL
          WHERE run_id = ${runId}
            AND waiting_reason IS NOT NULL
        `
        return { _tag: "Woken" as const, row }
      })
    ).pipe(Effect.orDie)
  )

const waiting = (db: Database): Service["waiting"] =>
  Effect.fn("DurableEngineState.waiting")((runId) =>
    selectWaiting(db, runId).pipe(
      Effect.orDie,
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeedNone
          : Effect.map(decodeWaitingRow(rows[0]), Option.some)
      )
    )
  )

/**
 * Every open wait in one run tree, the named run's own first.
 *
 * Walk the authoritative spawn and trampoline edges. UNION visits each
 * (run, depth) pair once; the depth cap bounds even externally corrupted
 * cycles. Grouping by run afterwards collapses unequal-depth DAG paths
 * and orders each wait at its shortest attached distance from the root.
 * Correlated edge lookups seek each parent's indexes instead of building
 * an edge set from the database's entire execution history.
 */
const waitingTree = (db: Database): Service["waitingTree"] =>
  Effect.fn("DurableEngineState.waitingTree")((runId, options) =>
    db.sql<WaitingDatabaseRow>`
      WITH RECURSIVE tree(run_id, depth) AS (
        SELECT run_id, 0 FROM flows_runs WHERE run_id = ${runId}
        UNION
        SELECT child.run_id, tree.depth + 1
        FROM tree
        JOIN flows_runs child ON child.run_id IN (
          SELECT child_id FROM flows_run_parents WHERE parent_id = tree.run_id
          UNION ALL
          SELECT run_id FROM flows_runs WHERE parent_run_id = tree.run_id
        )
        WHERE tree.depth < ${waitingTreeMaxDepth}
          AND (${options?.detached === "include" ? 1 : 0} = 1
            OR child.parent_run_id = tree.run_id
            OR COALESCE(${Dialect.jsonText(db.sql, db.sql`child.state_json`, "$.onParentExit")}, 'cancel') <> 'detach')
      ), reachable(run_id, depth) AS (
        SELECT run_id, MIN(depth) FROM tree GROUP BY run_id
      )
      SELECT
        parked.run_id AS "runId",
        parked.waiting_reason AS "waitingReason",
        parked.waiting_wake_at_ms AS "waitingWakeAtMs",
        parked.waiting_token AS "waitingToken",
        parked.waiting_request AS "waitingRequest"
      FROM reachable
      JOIN flows_runs parked ON parked.run_id = reachable.run_id
      WHERE parked.waiting_reason IS NOT NULL
        AND parked.status NOT IN ('completed', 'failed', 'cancelled')
      ORDER BY reachable.depth, parked.created_at_ms, parked.run_id
    `.pipe(
      Effect.orDie,
      Effect.flatMap((rows) => decodeSweep(rows, "waiting run", waitingRowKey, decodeWaitingRowResult))
    )
  )

const waitingRuns = (db: Database): Service["waitingRuns"] =>
  Effect.fn("DurableEngineState.waitingRuns")((filter) => {
    // `1 = 0` short-circuits the cancel predicate away when the caller did
    // not ask for it, so the reason/wake filters (and the 0004 index) stay
    // the leading predicates (issue #68).
    const cancelRequestedOnly = filter?.cancelRequested === true ? 1 : 0
    return (filter?.reason !== undefined && filter.dueBeforeMs !== undefined
      ? db.sql<WaitingDatabaseRow>`
        SELECT
          run_id AS "runId",
          waiting_reason AS "waitingReason",
          waiting_wake_at_ms AS "waitingWakeAtMs",
          waiting_token AS "waitingToken",
          waiting_request AS "waitingRequest"
        FROM flows_runs
        WHERE waiting_reason = ${filter.reason}
          AND waiting_wake_at_ms IS NOT NULL
          AND waiting_wake_at_ms <= ${filter.dueBeforeMs}
          AND (${cancelRequestedOnly} = 0 OR cancel_requested_at_ms IS NOT NULL)
          AND status NOT IN ('completed', 'failed', 'cancelled')
        ORDER BY waiting_wake_at_ms, run_id
      `
      : filter?.reason !== undefined
      ? db.sql<WaitingDatabaseRow>`
        SELECT
          run_id AS "runId",
          waiting_reason AS "waitingReason",
          waiting_wake_at_ms AS "waitingWakeAtMs",
          waiting_token AS "waitingToken",
          waiting_request AS "waitingRequest"
        FROM flows_runs
        WHERE waiting_reason = ${filter.reason}
          AND (${cancelRequestedOnly} = 0 OR cancel_requested_at_ms IS NOT NULL)
          AND status NOT IN ('completed', 'failed', 'cancelled')
        ORDER BY waiting_wake_at_ms IS NULL, waiting_wake_at_ms, run_id
      `
      : filter?.dueBeforeMs !== undefined
      ? db.sql<WaitingDatabaseRow>`
        SELECT
          run_id AS "runId",
          waiting_reason AS "waitingReason",
          waiting_wake_at_ms AS "waitingWakeAtMs",
          waiting_token AS "waitingToken",
          waiting_request AS "waitingRequest"
        FROM flows_runs
        WHERE waiting_reason IS NOT NULL
          AND waiting_wake_at_ms IS NOT NULL
          AND waiting_wake_at_ms <= ${filter.dueBeforeMs}
          AND (${cancelRequestedOnly} = 0 OR cancel_requested_at_ms IS NOT NULL)
          AND status NOT IN ('completed', 'failed', 'cancelled')
        ORDER BY waiting_wake_at_ms, run_id
      `
      : db.sql<WaitingDatabaseRow>`
        SELECT
          run_id AS "runId",
          waiting_reason AS "waitingReason",
          waiting_wake_at_ms AS "waitingWakeAtMs",
          waiting_token AS "waitingToken",
          waiting_request AS "waitingRequest"
        FROM flows_runs
        WHERE waiting_reason IS NOT NULL
          AND (${cancelRequestedOnly} = 0 OR cancel_requested_at_ms IS NOT NULL)
          AND status NOT IN ('completed', 'failed', 'cancelled')
        ORDER BY waiting_wake_at_ms IS NULL, waiting_wake_at_ms, run_id
      `).pipe(
        Effect.orDie,
        // The parked-run sweeper's only enumeration: one unreadable waiting
        // payload stranded every parked run, including the ones whose
        // cancellation had already been requested.
        Effect.flatMap((rows) => decodeSweep(rows, "waiting run", waitingRowKey, decodeWaitingRowResult))
      )
  })

const pendingRows = (
  db: Database,
  flowName: string,
  limit?: number,
  after?: PendingRunCursor,
  through?: PendingRunCursor,
  descending = false,
  eligibleBeforeMs?: number
): Effect.Effect<ReadonlyArray<PendingRunCursor>> =>
  db.sql<{ readonly runId: string; readonly createdAtMs: number | bigint | string }>`
      SELECT run_id AS "runId", created_at_ms AS "createdAtMs" FROM flows_runs
        ${Dialect.isPostgres(db.sql) ? db.sql`` : db.sql`INDEXED BY flows_runs_listing_3`}
      WHERE status = 'pending'
        AND ${eligibleBeforeMs === undefined ? db.sql`TRUE` : db.sql`created_at_ms < ${eligibleBeforeMs}`}
        AND execution_flow = ${flowName}
        AND ${
    after === undefined ? db.sql`TRUE` : db.sql`(
          created_at_ms > ${after.createdAtMs}
          OR (created_at_ms = ${after.createdAtMs} AND run_id > ${after.runId})
        )`
  }
        AND ${
    through === undefined ? db.sql`TRUE` : db.sql`(
          created_at_ms < ${through.createdAtMs}
          OR (created_at_ms = ${through.createdAtMs} AND run_id <= ${through.runId})
        )`
  }
      ORDER BY ${descending ? db.sql`created_at_ms DESC, run_id DESC` : db.sql`created_at_ms, run_id`}
      LIMIT ${limit ?? (Dialect.isPostgres(db.sql) ? null : -1)}
    `.pipe(
    Effect.orDie,
    Effect.map((rows) => rows.map((row) => ({ runId: row.runId, createdAtMs: Number(row.createdAtMs) })))
  )
const pendingRuns = (db: Database): Service["pendingRuns"] =>
  Effect.fn("DurableEngineState.pendingRuns")((
    flowName,
    limit,
    after,
    through,
    eligibleBeforeMs
  ) => pendingRows(db, flowName, limit, after, through, false, eligibleBeforeMs))
const pendingRunTail = (db: Database): Service["pendingRunTail"] =>
  Effect.fn("DurableEngineState.pendingRunTail")((
    flowName,
    eligibleBeforeMs
  ) =>
    pendingRows(db, flowName, 1, undefined, undefined, true, eligibleBeforeMs).pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0]))
    )
  )

const pendingCancellationRows = (
  db: Database,
  limit: number,
  after?: PendingRunCursor,
  through?: PendingRunCursor,
  descending = false
): Effect.Effect<ReadonlyArray<PendingRunCursor>> =>
  pendingCancellationLimit(limit).pipe(
    Effect.andThen(db.sql<{ readonly runId: string; readonly createdAtMs: number | bigint | string }>`
      SELECT run_id AS "runId", created_at_ms AS "createdAtMs" FROM flows_runs
        ${Dialect.isPostgres(db.sql) ? db.sql`` : db.sql`INDEXED BY flows_runs_pending_cancel_idx`}
      WHERE status = 'pending' AND cancel_requested_at_ms IS NOT NULL
        AND ${
      after === undefined ? db.sql`TRUE` : db.sql`(created_at_ms, run_id) > (${after.createdAtMs}, ${after.runId})`
    }
        AND ${
      through === undefined
        ? db.sql`TRUE`
        : db.sql`(created_at_ms, run_id) <= (${through.createdAtMs}, ${through.runId})`
    }
      ORDER BY ${descending ? db.sql`created_at_ms DESC, run_id DESC` : db.sql`created_at_ms, run_id`}
      LIMIT ${limit}
    `.pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => ({ runId: row.runId, createdAtMs: Number(row.createdAtMs) })))
    ))
  )
const pendingCancellationRuns = (db: Database): Service["pendingCancellationRuns"] =>
  Effect.fn(
    "DurableEngineState.pendingCancellationRuns"
  )((limit, after, through) => pendingCancellationRows(db, limit, after, through))
const pendingCancellationTail = (db: Database): Service["pendingCancellationTail"] =>
  Effect.fn(
    "DurableEngineState.pendingCancellationTail"
  )(() =>
    pendingCancellationRows(db, 1, undefined, undefined, true).pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0]))
    )
  )

const staleRunningRuns = (db: Database): Service["staleRunningRuns"] =>
  Effect.fn(
    "DurableEngineState.staleRunningRuns"
  )((staleBeforeMs, limit) =>
    // `LIMIT -1` is SQLite's explicit "no limit"; the partial index created
    // in `make` serves the predicate, so the per-tick sweep is an index
    // range read instead of a full table scan (issue #79).
    db.sql<{ runId: string; heartbeatAtMs: number | bigint | string }>`
      SELECT run_id AS "runId", heartbeat_at_ms AS "heartbeatAtMs"
      FROM flows_runs
      WHERE status = 'running'
        AND heartbeat_at_ms IS NOT NULL
        AND heartbeat_at_ms < ${staleBeforeMs}
      ORDER BY heartbeat_at_ms, run_id
      LIMIT ${limit ?? (Dialect.isPostgres(db.sql) ? null : -1)}
    `.pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => ({ runId: String(row.runId), heartbeatAtMs: Number(row.heartbeatAtMs) })))
    )
  )

/**
 * One ordered range read replaces the engine store's per-attempt point
 * probes (issue #77): a fresh key costs one empty SELECT instead of 32
 * sequential gets, and a resumed key one SELECT instead of one per
 * surviving attempt. The earliest surviving row is the durable retry
 * origin (issue #69) and the highest attempt contiguous from it the
 * resumed counter (issue #59). This read is deliberately unbounded; the
 * pruned-prefix tolerance that makes it agree with the point-probe
 * fallback is applied once, by the caller, in
 * `internal/AttemptProbe.probeAttempts` (issue #96).
 */
const attemptSurvivors = (db: Database): NonNullable<Service["attemptSurvivors"]> =>
  Effect.fn(
    "DurableEngineState.attemptSurvivors"
  )((runId, stepKeyDigest) =>
    db.sql<{ readonly attempt: number; readonly startedAtMs: number }>`
      SELECT attempt AS "attempt", started_at_ms AS "startedAtMs"
      FROM flows_attempts
      WHERE run_id = ${runId}
        AND step_key_digest = ${stepKeyDigest}
      ORDER BY attempt
    `.pipe(
      Effect.orDie,
      Effect.map((rows) =>
        AttemptProbe.survivorsOf(
          rows.map((row) => ({ attempt: Number(row.attempt), startedAtMs: Number(row.startedAtMs) }))
        )
      )
    )
  )

/**
 * One statement copies every ref: the refs travel as one JSON parameter that
 * each dialect expands into rows, so no statement grows a parameter per ref.
 */
const copyAttempts = (db: Database): NonNullable<Service["copyAttempts"]> =>
  Effect.fn(
    "DurableEngineState.copyAttempts"
  )(({ attempts, from, to }) => {
    if (attempts.length === 0) return Effect.succeed(0)
    const refs = JSON.stringify(attempts.map(({ attempt, stepKeyDigest }) => [stepKeyDigest, attempt]))
    const selected = Dialect.isPostgres(db.sql)
      ? db.sql`SELECT value ->> 0, (value ->> 1)::integer FROM jsonb_array_elements(${refs}::jsonb)`
      : db.sql`SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(${refs})`
    return writeRun(
      db,
      to,
      db.sql<{ readonly attempt: number }>`
        INSERT INTO flows_attempts (
          run_id, step_key_digest, attempt, state, started_at_ms, finished_at_ms,
          heartbeat_at_ms, checkpoint_json, error_json, outcome_json, meta_json
        )
        SELECT
          ${to}, step_key_digest, attempt, state, started_at_ms, finished_at_ms,
          heartbeat_at_ms, checkpoint_json, error_json, outcome_json, meta_json
        FROM flows_attempts
        WHERE run_id = ${from} AND (step_key_digest, attempt) IN (${selected})
        ON CONFLICT (run_id, step_key_digest, attempt) DO NOTHING
        RETURNING attempt
      `
    ).pipe(Effect.orDie, Effect.map((rows) => rows.length))
  })

const selectRunParent = (db: Database, childId: string, parentId: string) =>
  db.sql<RunParentDatabaseRow>`
      SELECT
        child_id AS "childId",
        parent_id AS "parentId",
        seq AS "seq"
      FROM flows_run_parents
      WHERE child_id = ${childId}
        AND parent_id = ${parentId}
    `

const parentIdsOf = (db: Database, id: string): Effect.Effect<ReadonlyArray<string>> =>
  db.sql<RunParentDatabaseRow>`
      SELECT
        child_id AS "childId",
        parent_id AS "parentId",
        seq AS "seq"
      FROM flows_run_parents
      WHERE child_id = ${id}
      ORDER BY seq
    `.pipe(
    Effect.orDie,
    Effect.map((rows) => rows.map((row) => String(row.parentId)))
  )

const recordRunParent = (db: Database): Service["recordRunParent"] =>
  Effect.fn(
    "DurableEngineState.recordRunParent"
  )((childId, parentId) =>
    db.writer.write(
      Effect.gen(function*() {
        // MAX(seq)+1 and the insert share one write transaction, so the
        // assigned seq is a total insertion order over the store.
        const inserted = yield* db.sql<RunParentDatabaseRow>`
          INSERT INTO flows_run_parents (child_id, parent_id, seq)
          SELECT ${childId}, ${parentId}, COALESCE(MAX(seq), 0) + 1
          FROM flows_run_parents
          WHERE TRUE
          ON CONFLICT (child_id, parent_id) DO NOTHING
          RETURNING
            child_id AS "childId",
            parent_id AS "parentId",
            seq AS "seq"
        `
        if (inserted[0] !== undefined) {
          // The cycle check shares the insert's transaction: a hit fails the
          // effect, rolling the insert back, so a rejected edge is never
          // durable and there is no check-then-record window for another
          // writer to slip through (issues #54/#55/#56). The insert
          // precedes the walk, so the transaction holds the write lock
          // while walking: under `DurableWriter.write`'s documented contract —
          // write transactions are mutually serialized (issue #74) — of two
          // edges that jointly close a cycle, exactly the later one fails.
          // This is a contract requirement, not a SQLite artifact; a
          // backend that ran writes at READ COMMITTED would break it and is
          // excluded by the DurableWriter contract.
          const cycle = yield* findCyclePath(childId, parentId, (id) => parentIdsOf(db, id))
          if (cycle !== undefined) {
            return yield* Effect.fail(new RunParentCycleError({ path: cycle }))
          }
          return {
            _tag: "Recorded" as const,
            edge: yield* decodeRunParentEdge(inserted[0])
          }
        }
        const existing = yield* selectRunParent(db, childId, parentId)
        if (existing[0] === undefined) {
          return yield* Effect.die(new EngineStateFault({ reason: "run_parent_edge_missing" }))
        }
        return {
          _tag: "Existing" as const,
          edge: yield* decodeRunParentEdge(existing[0])
        }
      })
    ).pipe(
      Effect.catch((error) => error instanceof RunParentCycleError ? Effect.fail(error) : Effect.die(error))
    )
  )

const removeRunParentsForRun = (db: Database): Service["removeRunParentsForRun"] =>
  Effect.fn(
    "DurableEngineState.removeRunParentsForRun"
  )((runId) =>
    db.writer.write(db.sql`
      DELETE FROM flows_run_parents
      WHERE child_id = ${runId}
        OR parent_id = ${runId}
    `).pipe(Effect.orDie, Effect.asVoid)
  )
/**
 * Writes `body`, which reads and changes one execution's rows only, in that
 * execution's partition: it waits only for that execution's other writers
 * (`packages/smithers/flows/database/docs/decisions/0001-run-writer-locks.md`).
 * Every row this store keys by execution, its deferred completions, clock
 * deadlines and waiting columns, is one execution's; the run-parent edges
 * are not, and their writes name none. A waiting column's update also bumps
 * the shared `flows_run_source` revision through the run row's trigger, an
 * atomic increment its row lock keeps correct.
 */
const writeRun = <A, E, R>(db: Database, executionId: string, body: Effect.Effect<A, E, R>) =>
  db.writer.write(body, { partition: executionId })

/**
 * Writes `body` through the shared writer, dying on a sole storage failure.
 *
 * Only a sole storage failure is normalized. A composite keeps every
 * reason for the caller to diagnose, and its storage failures are
 * demoted to defects one by one rather than cast through the
 * declared error type: `transaction` promises the BODY's failures,
 * so a `DatabaseError` arriving as a typed failure would be a lie
 * the compiler could not catch. Defect identity is unchanged.
 */
const writeBody = <A, E, R>(
  db: Database,
  body: Effect.Effect<A, E, R>,
  partition?: string | undefined
): Effect.Effect<A, E, R> =>
  db.writer.write(body, { partition }).pipe(
    Effect.catchCause((cause) => {
      if (cause.reasons.length === 1) {
        const reason = cause.reasons[0]!
        if (Cause.isFailReason(reason) && reason.error instanceof DatabaseError) {
          return Effect.die(reason.error)
        }
      }
      return Effect.failCause(dieOnDatabaseError<E>(cause))
    })
  )

/** Takes the store's transaction gate, then writes `effect`, releasing the gate at COMMIT. */
const gatedWrite = <A, E, R>(
  db: Database,
  effect: Effect.Effect<A, E, R>,
  partition?: string | undefined
): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function*() {
      yield* restore(db.transactionGate.take(1))
      let released = false
      const release = Effect.suspend(() => {
        if (released) return Effect.void
        released = true
        return db.transactionGate.release(1).pipe(Effect.asVoid)
      })
      return yield* restore(writeBody(
        db,
        Effect.gen(function*() {
          // Release at COMMIT, before publication can read through another
          // transaction. A failed write instead releases in ensuring below.
          yield* afterCommit(release, db.sql)
          return yield* effect
        }),
        partition
      )).pipe(Effect.ensuring(release))
    })
  )

/** Runs `effect` in one write transaction; a nested one joins the enclosing transaction. */
const transaction = (db: Database): Service["transaction"] => (effect, options) =>
  Effect.flatMap(
    Effect.serviceOption(db.sql.transactionService),
    (enclosing) =>
      Option.isSome(enclosing)
        ? writeBody(db, effect, options?.partition)
        : gatedWrite(db, effect, options?.partition)
  )

const readTransaction = (db: Database): Service["readTransaction"] => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Dialect.readTransaction(db.sql, effect).pipe(
    // BEGIN or COMMIT failing is the store's failure, never the body's.
    Effect.catchIf((error): error is SqlError.SqlError => SqlError.isSqlError(error), (error) => Effect.die(error))
  ) as Effect.Effect<A, E, R>

const runParents = (db: Database): Service["runParents"] =>
  Effect.fn("DurableEngineState.runParents")((childId) =>
    db.sql<RunParentDatabaseRow>`
      SELECT
        child_id AS "childId",
        parent_id AS "parentId",
        seq AS "seq"
      FROM flows_run_parents
      WHERE child_id = ${childId}
      ORDER BY seq
    `.pipe(
      Effect.orDie,
      // One unreadable edge made a run's whole ancestry unreadable, so no
      // subflow under it could be linked at all.
      Effect.flatMap((rows) => decodeSweep(rows, "run parent", runParentRowKey, decodeRunParentEdgeResult))
    )
  )

const runChildren = (db: Database): Service["runChildren"] =>
  Effect.fn("DurableEngineState.runChildren")((parentId) =>
    db.sql<RunParentDatabaseRow>`
      SELECT
        child_id AS "childId",
        parent_id AS "parentId",
        seq AS "seq"
      FROM flows_run_parents
      WHERE parent_id = ${parentId}
      ORDER BY seq
    `.pipe(
      Effect.orDie,
      // The cancellation cascade's only cross-process way to find a run's
      // children: one unreadable sibling edge left every child running after
      // its parent was cancelled.
      Effect.flatMap((rows) => decodeSweep(rows, "run parent", runParentRowKey, decodeRunParentEdgeResult))
    )
  )

/**
 * Constructs the database-backed durable-state implementation.
 *
 * Clock creation is fenced against the current run owner. Deferred completion
 * and clock firing are external trigger admissions protected by first-writer
 * and compare-and-set semantics; execution remains claim-gated by `RunStore`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make: Effect.Effect<Service, never, DurableWriter | SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const writer = yield* DurableWriter

  // Engine-store-owned storage created outside the journal migration
  // (issues #40/#41/#79/#81). The statements, their rationale, and
  // the dialects each is known to accept live in one machine-readable
  // inventory so the pg-porting plan cannot omit them (issue #92).
  yield* EngineStateSchema.apply(sql, writer)

  const db: Database = { sql, writer, transactionGate: Semaphore.makeUnsafe(1) }
  return DurableEngineState.of({
    deferred: deferred(db),
    consumeDeferred: consumeDeferred(db),
    completeDeferred: completeDeferred(db),
    clock: clock(db),
    scheduleClock: scheduleClock(db),
    completeClock: completeClock(db),
    completeRunClocks: completeRunClocks(db),
    dueClocks: dueClocks(db),
    pendingClocks: pendingClocks(db),
    completedDeferreds: completedDeferreds(db),
    hasDueWake: hasDueWake(db),
    park: park(db),
    wake: wake(db),
    waiting: waiting(db),
    waitingTree: waitingTree(db),
    waitingRuns: waitingRuns(db),
    pendingRuns: pendingRuns(db),
    pendingRunTail: pendingRunTail(db),
    pendingCancellationRuns: pendingCancellationRuns(db),
    pendingCancellationTail: pendingCancellationTail(db),
    staleRunningRuns: staleRunningRuns(db),
    attemptSurvivors: attemptSurvivors(db),
    copyAttempts: copyAttempts(db),
    recordRunParent: recordRunParent(db),
    removeRunParentsForRun: removeRunParentsForRun(db),
    runParents: runParents(db),
    runChildren: runChildren(db),
    transaction: transaction(db),
    readTransaction: readTransaction(db)
  })
})

/**
 * Provides database-backed durable engine state.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer: Layer.Layer<DurableEngineState, never, DurableWriter | SqlClient.SqlClient> = Layer.effect(
  DurableEngineState,
  make
)

/**
 * A run's ownership view as the in-memory implementation needs it for the
 * same fences the SQL implementation reads from `flows_runs`.
 *
 * @since 0.1.0
 * @category models
 */
export interface MemoryRunView {
  readonly flowName?: string | undefined
  readonly createdAtMs?: number | undefined
  readonly status: "pending" | "running" | "suspended" | "completed" | "failed" | "cancelled"
  readonly owner: OwnerId | null
  /**
   * The run's last heartbeat instant, mirroring `flows_runs.heartbeat_at_ms`.
   * `undefined` means unknown — such a run never surfaces from
   * `staleRunningRuns` (issue #53).
   */
  readonly heartbeatAtMs?: number | null | undefined
  /**
   * The run's durable cancel request, mirroring
   * `flows_runs.cancel_requested_at_ms`. `undefined`/`null` means not
   * requested — such a run never surfaces from a
   * `waitingRuns({ cancelRequested: true })` query (issue #68).
   */
  readonly cancelRequestedAtMs?: number | null | undefined
  /**
   * What this run does when the run that spawned it ends, mirroring
   * `RunState.onParentExit`. `undefined` reads as `cancel`, the default and
   * the shape a `.child()` boundary takes, so a view that does not record it
   * describes an attached child.
   */
  readonly onParentExit?: OnParentExit | undefined
}

/**
 * Options for the in-memory durable-state implementation.
 *
 * @since 0.1.0
 * @category models
 */
export interface MemoryOptions {
  /**
   * Resolves a run's existence, status, and owner — the in-memory analogue
   * of the `flows_runs` lookups the SQL implementation performs for its
   * `park`/`wake`/`scheduleClock` fences. `Option.none()` means the run does
   * not exist. When omitted, every run is treated as running and owned by
   * whichever owner is presented (a deliberately permissive default for tests
   * that exercise only deferred/clock state without a run table).
   */
  readonly runs?: (runId: string) => Option.Option<MemoryRunView>
  /**
   * Enumerates every known run — the in-memory analogue of scanning
   * `flows_runs`, which `staleRunningRuns` needs (the `runs` lookup alone
   * cannot enumerate). When omitted, `staleRunningRuns` reports no stale
   * rows.
   */
  readonly listRuns?: () => Iterable<readonly [string, MemoryRunView]>
}

/** Everything one in-memory durable state holds. */
interface Memory {
  readonly options: MemoryOptions
  readonly deferreds: Map<string, DeferredRow>
  readonly consumedDeferreds: Map<string, number>
  readonly clocks: Map<string, ClockRow>
  readonly waitingRows: Map<string, WaitingRow>
  /** childId -> (parentId -> seq); `parentSeq` mirrors the SQL MAX(seq)+1. */
  readonly parentEdges: Map<string, Map<string, number>>
  parentSeq: number
  /** The one permit every unnested operation and transaction takes. */
  readonly gate: Semaphore.Semaphore
  /** How deep each fiber is inside a transaction; a nested operation skips the gate. */
  readonly transactionDepth: Map<number, number>
}

const snapshotDeferred = (row: DeferredRow): Effect.Effect<DeferredRow> =>
  Schema.decodeUnknownEffect(DeferredRow)(row).pipe(
    Effect.orDie,
    Effect.flatMap((decoded) =>
      Effect.all({
        exitJson: encodeJson(decoded.exit, "exit"),
        metadataJson: decoded.metadata === undefined
          ? Effect.succeed(null)
          : encodeJson(decoded.metadata, "metadata")
      }).pipe(
        Effect.flatMap(({ exitJson, metadataJson }) =>
          decodeDeferredRow({
            flowName: decoded.flowName,
            executionId: decoded.executionId,
            deferredName: decoded.deferredName,
            exitJson,
            metadataJson,
            completedAtMs: decoded.completedAtMs
          })
        )
      )
    )
  )

const snapshotClock = (row: ClockRow): Effect.Effect<ClockRow> =>
  Schema.decodeUnknownEffect(ClockRow)(row).pipe(
    Effect.orDie,
    Effect.map((decoded) => ({ ...decoded }))
  )

const snapshotWaiting = (row: WaitingRow): WaitingRow => ({ ...row })

/** The synchronous twin of `findCyclePath` over the in-memory edge map. */
const findCyclePathSync = (memory: Memory, childId: string, parentId: string): ReadonlyArray<string> | undefined => {
  if (parentId === childId) return [childId]
  const seen = new Set<string>([parentId])
  const walk = (
    current: string,
    chain: ReadonlyArray<string>
  ): ReadonlyArray<string> | undefined => {
    for (const parent of memory.parentEdges.get(current)?.keys() ?? []) {
      if (parent === childId) return [...chain, parent].reverse()
      if (seen.has(parent)) continue
      seen.add(parent)
      const found = walk(parent, [...chain, parent])
      if (found !== undefined) return found
    }
    return undefined
  }
  return walk(parentId, [parentId])
}

const sameOwner = (left: OwnerId, right: OwnerId): boolean =>
  left.hostId === right.hostId && left.pid === right.pid && left.nonce === right.nonce

/** Mirrors the SQL `flows_runs` owner-match predicate for a run. */
const runView = (memory: Memory, runId: string, presented: OwnerId | undefined): {
  readonly exists: boolean
  readonly running: boolean
  readonly owned: boolean
} => {
  if (memory.options.runs === undefined) {
    return { exists: true, running: true, owned: true }
  }
  const view = memory.options.runs(runId)
  if (Option.isNone(view)) {
    return { exists: false, running: false, owned: false }
  }
  const owned = presented !== undefined &&
    view.value.owner !== null &&
    sameOwner(view.value.owner, presented)
  return { exists: true, running: view.value.status === "running", owned }
}

/**
 * Mirrors the SQL sweeps' run-status join: a row whose run has settled is
 * never swept, and `Option.none()` from a supplied `runs` view means the run
 * does not exist, so its orphaned engine-state rows stay hidden. The
 * permissive default (no `runs` view) treats every run as live because a
 * standalone memory store has no run table to consult.
 */
const isLive = (memory: Memory, runId: string): boolean => {
  if (memory.options.runs === undefined) return true
  const view = memory.options.runs(runId)
  return Option.isSome(view) && (
    view.value.status === "pending" ||
    view.value.status === "running" ||
    view.value.status === "suspended"
  )
}

const pendingMemoryRows = (
  memory: Memory,
  flowName: string | undefined,
  after?: PendingRunCursor,
  through?: PendingRunCursor,
  eligibleBeforeMs?: number,
  cancellationOnly = false
) =>
  Array.from(memory.options.listRuns?.() ?? [])
    .filter(([runId, view]) =>
      view.status === "pending" && (flowName === undefined || view.flowName === flowName) &&
      (!cancellationOnly || view.cancelRequestedAtMs != null) &&
      (eligibleBeforeMs === undefined || (view.createdAtMs ?? 0) < eligibleBeforeMs) &&
      (after === undefined || (view.createdAtMs ?? 0) > after.createdAtMs ||
        ((view.createdAtMs ?? 0) === after.createdAtMs && compareText(runId, after.runId) > 0)) &&
      (through === undefined || (view.createdAtMs ?? 0) < through.createdAtMs ||
        ((view.createdAtMs ?? 0) === through.createdAtMs && compareText(runId, through.runId) <= 0))
    )
    .sort(([leftId, left], [rightId, right]) =>
      (left.createdAtMs ?? 0) - (right.createdAtMs ?? 0) || compareText(leftId, rightId)
    )
    .map(([runId, view]) => ({ runId, createdAtMs: view.createdAtMs ?? 0 }))

const memoryDeferred = (memory: Memory): Service["deferred"] =>
  Effect.fn("DurableEngineState.deferred")((address) =>
    Effect.gen(function*() {
      const row = memory.deferreds.get(deferredKey(address))
      return row === undefined ? Option.none() : Option.some(yield* snapshotDeferred(row))
    })
  )

const memoryConsumeDeferred = (memory: Memory): Service["consumeDeferred"] =>
  Effect.fn("DurableEngineState.consumeDeferred")((
    address,
    consumedAtMs
  ) =>
    Effect.sync(() => {
      const key = deferredKey(address)
      if (!memory.deferreds.has(key) || memory.consumedDeferreds.has(key)) return false
      memory.consumedDeferreds.set(key, consumedAtMs)
      return true
    })
  )

const memoryCompleteDeferred = (memory: Memory): Service["completeDeferred"] =>
  Effect.fn("DurableEngineState.completeDeferred")((row) =>
    Effect.gen(function*() {
      const stored = yield* snapshotDeferred(row)
      const key = deferredKey(stored)
      const existing = memory.deferreds.get(key)
      if (existing !== undefined) {
        return {
          _tag: "Existing" as const,
          row: yield* snapshotDeferred(existing),
          digest: yield* memoryDigest(existing)
        }
      }
      memory.deferreds.set(key, stored)
      return {
        _tag: "Completed" as const,
        row: yield* snapshotDeferred(stored),
        digest: yield* memoryDigest(stored)
      }
    })
  )

const memoryClock = (memory: Memory): Service["clock"] =>
  Effect.fn("DurableEngineState.clock")((address) =>
    Effect.gen(function*() {
      const row = memory.clocks.get(clockKey(address))
      return row === undefined ? Option.none() : Option.some(yield* snapshotClock(row))
    })
  )

const memoryScheduleClock = (memory: Memory): Service["scheduleClock"] =>
  Effect.fn("DurableEngineState.scheduleClock")((row, owner) =>
    Effect.gen(function*(): Generator<Effect.Effect<unknown>, ScheduleClockOutcome, never> {
      // Mirrors the SQL fence: creation requires the presented owner to
      // currently run the execution; a lost fence surfaces as
      // self-interruption, an existing row wins regardless.
      const stored = yield* snapshotClock(row)
      const key = clockKey(stored)
      const existing = memory.clocks.get(key)
      if (existing !== undefined) {
        return { _tag: "Existing" as const, row: yield* snapshotClock(existing) }
      }
      const view = runView(memory, stored.executionId, owner)
      if (!view.exists || !view.running || !view.owned) {
        return yield* Effect.interrupt
      }
      memory.clocks.set(key, stored)
      return { _tag: "Scheduled" as const, row: yield* snapshotClock(stored) }
    })
  )

const memoryCompleteClock = (memory: Memory): Service["completeClock"] =>
  Effect.fn("DurableEngineState.completeClock")((
    address,
    completedAtMs
  ) =>
    Effect.sync(() => {
      const key = clockKey(address)
      const existing = memory.clocks.get(key)
      if (existing === undefined) {
        return { _tag: "NotFound" as const }
      }
      if (existing.completedAtMs !== null) {
        return { _tag: "AlreadyCompleted" as const, row: { ...existing } }
      }
      const row = { ...existing, completedAtMs }
      memory.clocks.set(key, row)
      return { _tag: "Completed" as const, row: { ...row } }
    })
  )

const memoryDueClocks = (memory: Memory): Service["dueClocks"] =>
  Effect.fn("DurableEngineState.dueClocks")((nowMs) =>
    Effect.forEach(
      Array.from(memory.clocks.values())
        .filter((row) => row.completedAtMs === null && row.dueAtMs <= nowMs)
        .sort((left, right) =>
          left.dueAtMs - right.dueAtMs ||
          compareText(left.executionId, right.executionId) ||
          compareText(left.clockName, right.clockName)
        ),
      snapshotClock
    )
  )

const memoryCompleteRunClocks = (memory: Memory): Service["completeRunClocks"] =>
  Effect.fn("DurableEngineState.completeRunClocks")((
    executionId,
    completedAtMs
  ) =>
    Effect.sync(() => {
      const completed: Array<ClockRow> = []
      for (const [key, row] of memory.clocks) {
        if (row.executionId !== executionId || row.completedAtMs !== null) continue
        const next = { ...row, completedAtMs }
        memory.clocks.set(key, next)
        completed.push({ ...next })
      }
      return completed.sort((left, right) =>
        compareText(left.flowName, right.flowName) || compareText(left.clockName, right.clockName)
      )
    })
  )

const memoryPendingClocks = (memory: Memory): Service["pendingClocks"] =>
  Effect.fn("DurableEngineState.pendingClocks")((scope) =>
    Effect.flatMap(
      Effect.sync(() =>
        Array.from(memory.clocks.values())
          .filter((row) =>
            row.completedAtMs === null &&
            isLive(memory, row.executionId) &&
            (scope.executionId === undefined || row.executionId === scope.executionId) &&
            (scope.flowName === undefined || row.flowName === scope.flowName)
          )
          .sort((left, right) =>
            left.dueAtMs - right.dueAtMs ||
            compareText(left.executionId, right.executionId) ||
            compareText(left.clockName, right.clockName)
          )
      ),
      (rows) => Effect.forEach(rows, snapshotClock)
    )
  )

const memoryHasDueWake = (memory: Memory): Service["hasDueWake"] => (executionId, nowMs) =>
  Effect.sync(() =>
    Array.from(memory.deferreds.values()).some((row) =>
      row.executionId === executionId && !memory.consumedDeferreds.has(deferredKey(row))
    ) || Array.from(memory.clocks.values()).some((row) =>
      row.executionId === executionId && row.completedAtMs === null && row.dueAtMs <= nowMs
    )
  )

const memoryCompletedDeferreds = (memory: Memory): Service["completedDeferreds"] =>
  Effect.fn("DurableEngineState.completedDeferreds")((
    flowName,
    executionId
  ) =>
    Effect.sync(() =>
      Array.from(memory.deferreds.values())
        .filter((row) =>
          (flowName === undefined || row.flowName === flowName) &&
          (executionId === undefined || row.executionId === executionId) &&
          isLive(memory, row.executionId) && !memory.consumedDeferreds.has(deferredKey(row))
        )
        .map(({ flowName, executionId, deferredName }) => ({
          flowName,
          executionId,
          deferredName
        }))
        .sort((left, right) =>
          compareText(left.executionId, right.executionId) ||
          compareText(left.deferredName, right.deferredName)
        )
    )
  )

const memoryPark = (memory: Memory): Service["park"] =>
  Effect.fn("DurableEngineState.park")((runId, waitingPayload, owner) =>
    Effect.sync(() => {
      // Mirrors the SQL fence: only the current owner of an existing run
      // may park it; anything else reports NotFound, exactly like the
      // owner-guarded UPDATE matching no row.
      const view = runView(memory, runId, owner)
      if (!view.exists || !view.owned) {
        return { _tag: "NotFound" as const }
      }
      // The declared question is stored as JSON TEXT and read back decoded,
      // exactly as the column and its SELECT do it.
      const row: WaitingRow = {
        runId,
        reason: waitingPayload.reason,
        wakeAt: waitingPayload.wakeAt ?? null,
        token: waitingPayload.token ?? null,
        ...decodeWaitingRequest(waitingPayload.request)
      } as WaitingRow
      memory.waitingRows.set(runId, row)
      return { _tag: "Parked" as const, row: snapshotWaiting(row) }
    })
  )

const memoryWake = (memory: Memory): Service["wake"] =>
  Effect.fn("DurableEngineState.wake")((runId) =>
    Effect.sync(() => {
      const row = memory.waitingRows.get(runId)
      if (row === undefined) {
        // Mirrors SQL: an unknown run is NotFound, an existing unparked
        // run is NotWaiting.
        return runView(memory, runId, undefined).exists
          ? { _tag: "NotWaiting" as const }
          : { _tag: "NotFound" as const }
      }
      memory.waitingRows.delete(runId)
      return { _tag: "Woken" as const, row: snapshotWaiting(row) }
    })
  )

const memoryWaiting = (memory: Memory): Service["waiting"] =>
  Effect.fn("DurableEngineState.waiting")((runId) =>
    Effect.sync(() => {
      const row = memory.waitingRows.get(runId)
      return row === undefined ? Option.none() : Option.some(snapshotWaiting(row))
    })
  )

const memoryWaitingTree = (memory: Memory): Service["waitingTree"] =>
  Effect.fn("DurableEngineState.waitingTree")((runId, walk) =>
    Effect.sync(() => {
      // Breadth-first over recorded spawn edges: the named run first, then
      // each generation beneath it. This memory view does not model the
      // parent_run_id trampoline links that the SQL walk also follows.
      const found: Array<WaitingRow> = []
      const seen = new Set<string>([runId])
      let frontier: ReadonlyArray<string> = [runId]
      for (let depth = 0; depth <= waitingTreeMaxDepth && frontier.length > 0; depth++) {
        const next: Array<string> = []
        for (const current of frontier) {
          const row = memory.waitingRows.get(current)
          if (row !== undefined && isLive(memory, current)) found.push(snapshotWaiting(row))
          for (const [childId, parents] of memory.parentEdges) {
            if (!parents.has(current) || seen.has(childId)) continue
            // The SQL walk skips a detached subtree; so does this one, for a
            // view that records the policy. A view that does not describes an
            // attached child, which is the default.
            const view = memory.options.runs?.(childId)
            if (
              walk?.detached !== "include" && view !== undefined && Option.isSome(view) &&
              view.value.onParentExit === "detach"
            ) continue
            seen.add(childId)
            next.push(childId)
          }
        }
        frontier = next
      }
      return found
    })
  )

const memoryWaitingRuns = (memory: Memory): Service["waitingRuns"] =>
  Effect.fn("DurableEngineState.waitingRuns")((filter) =>
    Effect.sync(() =>
      Array.from(memory.waitingRows.values())
        // Mirrors the SQL status predicate: a terminally closed run's
        // stale waiting row never surfaces to a sweeper (issue #28). The
        // permissive default (no `runs` view) treats every run as live.
        .filter((row) => isLive(memory, row.runId))
        .filter((row) => filter?.reason === undefined || row.reason === filter.reason)
        .filter((row) =>
          filter?.dueBeforeMs === undefined ||
          (row.wakeAt !== null && row.wakeAt <= filter.dueBeforeMs)
        )
        // Mirrors the SQL cancel predicate over
        // `flows_runs.cancel_requested_at_ms` (issue #68). Without a
        // `runs` view the flag is unknowable, so the query stays
        // permissive and the sweeper's own per-row guard decides.
        .filter((row) => {
          if (filter?.cancelRequested !== true) return true
          if (memory.options.runs === undefined) return true
          const view = memory.options.runs(row.runId)
          return Option.isSome(view) && view.value.cancelRequestedAtMs != null
        })
        .sort((left, right) =>
          Number(left.wakeAt === null) - Number(right.wakeAt === null) ||
          (left.wakeAt ?? 0) - (right.wakeAt ?? 0) ||
          compareText(left.runId, right.runId)
        )
        .map(snapshotWaiting)
    )
  )

const memoryPendingRuns = (memory: Memory): Service["pendingRuns"] =>
  Effect.fn("DurableEngineState.pendingRuns")((
    flowName,
    limit,
    after,
    through,
    eligibleBeforeMs
  ) =>
    Effect.sync(() => {
      const ordered = pendingMemoryRows(memory, flowName, after, through, eligibleBeforeMs)
      return limit === undefined ? ordered : ordered.slice(0, limit)
    })
  )

const memoryPendingRunTail = (memory: Memory): Service["pendingRunTail"] =>
  Effect.fn("DurableEngineState.pendingRunTail")((
    flowName,
    eligibleBeforeMs
  ) =>
    Effect.sync(() =>
      Option.fromNullishOr(pendingMemoryRows(memory, flowName, undefined, undefined, eligibleBeforeMs).at(-1))
    )
  )

const memoryPendingCancellationRuns = (memory: Memory): Service["pendingCancellationRuns"] =>
  Effect.fn(
    "DurableEngineState.pendingCancellationRuns"
  )((limit, after, through) =>
    pendingCancellationLimit(limit).pipe(Effect.andThen(
      Effect.sync(() => pendingMemoryRows(memory, undefined, after, through, undefined, true).slice(0, limit))
    ))
  )

const memoryPendingCancellationTail = (memory: Memory): Service["pendingCancellationTail"] =>
  Effect.fn(
    "DurableEngineState.pendingCancellationTail"
  )(() =>
    Effect.sync(() =>
      Option.fromNullishOr(
        pendingMemoryRows(memory, undefined, undefined, undefined, undefined, true).at(-1)
      )
    )
  )

const memoryStaleRunningRuns = (memory: Memory): Service["staleRunningRuns"] =>
  Effect.fn("DurableEngineState.staleRunningRuns")((
    staleBeforeMs,
    limit
  ) =>
    Effect.sync(() => {
      // Mirrors the SQL scan of `flows_runs`: without an enumerator there
      // is nothing to scan, so no stale rows exist.
      if (memory.options.listRuns === undefined) return []
      const stale: Array<StaleRunningRow> = []
      for (const [runId, view] of memory.options.listRuns()) {
        const heartbeatAtMs = view.heartbeatAtMs
        if (
          view.status === "running" &&
          typeof heartbeatAtMs === "number" &&
          heartbeatAtMs < staleBeforeMs
        ) {
          stale.push({ runId, heartbeatAtMs })
        }
      }
      const ordered = stale.sort((left, right) =>
        left.heartbeatAtMs - right.heartbeatAtMs ||
        compareText(left.runId, right.runId)
      )
      // Mirrors the SQL LIMIT: oldest heartbeats first, capped per sweep
      // (issue #79).
      return limit === undefined ? ordered : ordered.slice(0, limit)
    })
  )

const memoryRecordRunParent = (memory: Memory): Service["recordRunParent"] =>
  Effect.fn("DurableEngineState.recordRunParent")((
    childId,
    parentId
  ) =>
    // A single synchronous step mirrors the SQL transaction: the cycle
    // check and the insert are atomic — no fiber can interleave between
    // them, and a rejected edge is never observable (issues #54/#55/#56).
    Effect.suspend((): Effect.Effect<RecordRunParentOutcome, RunParentCycleError> => {
      const parents = memory.parentEdges.get(childId) ?? new Map<string, number>()
      const existing = parents.get(parentId)
      if (existing !== undefined) {
        return Effect.succeed({
          _tag: "Existing" as const,
          edge: { childId, parentId, seq: existing }
        })
      }
      const cycle = findCyclePathSync(memory, childId, parentId)
      if (cycle !== undefined) {
        return Effect.fail(new RunParentCycleError({ path: cycle }))
      }
      memory.parentSeq += 1
      parents.set(parentId, memory.parentSeq)
      memory.parentEdges.set(childId, parents)
      return Effect.succeed({
        _tag: "Recorded" as const,
        edge: { childId, parentId, seq: memory.parentSeq }
      })
    })
  )

const memoryRemoveRunParentsForRun = (memory: Memory): Service["removeRunParentsForRun"] =>
  Effect.fn(
    "DurableEngineState.removeRunParentsForRun"
  )((runId) =>
    Effect.sync(() => {
      memory.parentEdges.delete(runId)
      for (const [childId, parents] of memory.parentEdges) {
        parents.delete(runId)
        if (parents.size === 0) memory.parentEdges.delete(childId)
      }
    })
  )

const memoryRunParents = (memory: Memory): Service["runParents"] =>
  Effect.fn("DurableEngineState.runParents")((childId) =>
    Effect.sync(() =>
      Array.from(memory.parentEdges.get(childId) ?? [])
        .map(([parentId, seq]) => ({ childId, parentId, seq }))
        .sort((left, right) => left.seq - right.seq)
    )
  )

const memoryRunChildren = (memory: Memory): Service["runChildren"] =>
  Effect.fn("DurableEngineState.runChildren")((parentId) =>
    Effect.sync(() => {
      const edges: Array<RunParentEdge> = []
      for (const [childId, parents] of memory.parentEdges) {
        const seq = parents.get(parentId)
        if (seq !== undefined) edges.push({ childId, parentId, seq })
      }
      return edges.sort((left, right) => left.seq - right.seq)
    })
  )
/** Runs one operation under the memory state's permit, unless its fiber is inside a transaction. */
const guard = <A, E, R>(memory: Memory, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(
    Effect.fiberId,
    (fiberId) => (memory.transactionDepth.get(fiberId) ?? 0) > 0 ? effect : memory.gate.withPermit(effect)
  )

const restoreMap = <K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void => {
  target.clear()
  for (const [key, value] of source) target.set(key, value)
}

/** A copy of every table a memory transaction can change. */
const snapshotMemory = (memory: Memory) => ({
  deferreds: new Map(memory.deferreds),
  consumedDeferreds: new Map(memory.consumedDeferreds),
  clocks: new Map(memory.clocks),
  waitingRows: new Map(memory.waitingRows),
  parentEdges: new Map([...memory.parentEdges].map(([child, parents]) => [child, new Map(parents)])),
  parentSeq: memory.parentSeq
})

/** Puts back every table a failed transaction changed. */
const restoreMemory = (memory: Memory, before: ReturnType<typeof snapshotMemory>): void => {
  restoreMap(memory.deferreds, before.deferreds)
  restoreMap(memory.consumedDeferreds, before.consumedDeferreds)
  restoreMap(memory.clocks, before.clocks)
  restoreMap(memory.waitingRows, before.waitingRows)
  restoreMap(memory.parentEdges, before.parentEdges)
  memory.parentSeq = before.parentSeq
}

/**
 * Leaves a fiber's transaction, once: lowers its depth and, when the
 * transaction is the outermost, releases the permit.
 */
const leaveTransaction = (memory: Memory, fiberId: number, nested: boolean): Effect.Effect<void> => {
  let closed = false
  return Effect.suspend(() => {
    if (closed) return Effect.void
    closed = true
    const depth = memory.transactionDepth.get(fiberId)! - 1
    if (depth === 0) memory.transactionDepth.delete(fiberId)
    else memory.transactionDepth.set(fiberId, depth)
    return nested ? Effect.void : memory.gate.release(1).pipe(Effect.asVoid)
  })
}

/**
 * Runs `effect` as one memory transaction: the outermost takes the permit,
 * and a failure before commit restores every table it changed.
 */
const memoryTransaction = (memory: Memory): Service["transaction"] => (effect, options) =>
  Effect.flatMap(Effect.fiberId, (fiberId) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function*() {
        const nested = (memory.transactionDepth.get(fiberId) ?? 0) > 0
        if (!nested) yield* restore(memory.gate.take(1))
        const before = snapshotMemory(memory)
        memory.transactionDepth.set(fiberId, (memory.transactionDepth.get(fiberId) ?? 0) + 1)
        let committed = false
        const close = leaveTransaction(memory, fiberId, nested)
        const commit = Effect.sync(() => {
          committed = true
        }).pipe(Effect.andThen(close))
        return yield* Effect.sync(() => options?.onCommit?.(commit)).pipe(
          Effect.andThen(restore(effect)),
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              if (!committed) restoreMemory(memory, before)
            }).pipe(Effect.andThen(Effect.failCause(cause)))
          ),
          Effect.ensuring(close)
        )
      })
    ))

/** The memory state's operations, each unguarded: the caller holds the gate. */
const memoryMethods = (memory: Memory): Omit<Service, "transaction" | "readTransaction"> => ({
  deferred: memoryDeferred(memory),
  consumeDeferred: memoryConsumeDeferred(memory),
  completeDeferred: memoryCompleteDeferred(memory),
  clock: memoryClock(memory),
  scheduleClock: memoryScheduleClock(memory),
  completeClock: memoryCompleteClock(memory),
  dueClocks: memoryDueClocks(memory),
  completeRunClocks: memoryCompleteRunClocks(memory),
  pendingClocks: memoryPendingClocks(memory),
  hasDueWake: memoryHasDueWake(memory),
  completedDeferreds: memoryCompletedDeferreds(memory),
  park: memoryPark(memory),
  wake: memoryWake(memory),
  waiting: memoryWaiting(memory),
  waitingTree: memoryWaitingTree(memory),
  waitingRuns: memoryWaitingRuns(memory),
  pendingRuns: memoryPendingRuns(memory),
  pendingRunTail: memoryPendingRunTail(memory),
  pendingCancellationRuns: memoryPendingCancellationRuns(memory),
  pendingCancellationTail: memoryPendingCancellationTail(memory),
  staleRunningRuns: memoryStaleRunningRuns(memory),
  recordRunParent: memoryRecordRunParent(memory),
  removeRunParentsForRun: memoryRemoveRunParentsForRun(memory),
  runParents: memoryRunParents(memory),
  runChildren: memoryRunChildren(memory)
})

/**
 * Constructs a deterministic in-memory durable-state implementation.
 *
 * The returned service can be shared by multiple fresh engine instances in a
 * test to model process restart over the same storage. With `runs` supplied
 * it enforces the same ownership fences as the SQL implementation and is
 * held to the same contract suite
 * (`test/contract/DurableEngineStateContract.ts`).
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeMemory = (options: MemoryOptions = {}): Service => {
  const memory: Memory = {
    options,
    deferreds: new Map(),
    consumedDeferreds: new Map(),
    clocks: new Map(),
    waitingRows: new Map(),
    parentEdges: new Map(),
    parentSeq: 0,
    gate: Semaphore.makeUnsafe(1),
    transactionDepth: new Map()
  }
  const unguarded = memoryMethods(memory)
  const transaction = memoryTransaction(memory)
  return DurableEngineState.of({
    deferred: (address) => guard(memory, unguarded.deferred(address)),
    consumeDeferred: (address, consumedAtMs) => guard(memory, unguarded.consumeDeferred(address, consumedAtMs)),
    completeDeferred: (row) => guard(memory, unguarded.completeDeferred(row)),
    clock: (address) => guard(memory, unguarded.clock(address)),
    scheduleClock: (row, owner) => guard(memory, unguarded.scheduleClock(row, owner)),
    completeClock: (address, completedAtMs) => guard(memory, unguarded.completeClock(address, completedAtMs)),
    dueClocks: (nowMs) => guard(memory, unguarded.dueClocks(nowMs)),
    completeRunClocks: (executionId, completedAtMs) =>
      guard(memory, unguarded.completeRunClocks(executionId, completedAtMs)),
    pendingClocks: (scope) => guard(memory, unguarded.pendingClocks(scope)),
    hasDueWake: (executionId, nowMs) => guard(memory, unguarded.hasDueWake(executionId, nowMs)),
    completedDeferreds: (flowName, executionId) => guard(memory, unguarded.completedDeferreds(flowName, executionId)),
    park: (runId, waiting, owner) => guard(memory, unguarded.park(runId, waiting, owner)),
    wake: (runId) => guard(memory, unguarded.wake(runId)),
    waiting: (runId) => guard(memory, unguarded.waiting(runId)),
    waitingTree: (runId, options) => guard(memory, unguarded.waitingTree(runId, options)),
    waitingRuns: (filter) => guard(memory, unguarded.waitingRuns(filter)),
    pendingRuns: (flowName, limit, after, through, eligibleBeforeMs) =>
      guard(memory, unguarded.pendingRuns(flowName, limit, after, through, eligibleBeforeMs)),
    pendingRunTail: (flowName, eligibleBeforeMs) => guard(memory, unguarded.pendingRunTail(flowName, eligibleBeforeMs)),
    pendingCancellationRuns: (limit, after, through) =>
      guard(memory, unguarded.pendingCancellationRuns(limit, after, through)),
    pendingCancellationTail: () => guard(memory, unguarded.pendingCancellationTail()),
    staleRunningRuns: (staleBeforeMs, limit) => guard(memory, unguarded.staleRunningRuns(staleBeforeMs, limit)),
    attemptSurvivors: undefined,
    recordRunParent: (childId, parentId) => guard(memory, unguarded.recordRunParent(childId, parentId)),
    removeRunParentsForRun: (runId) => guard(memory, unguarded.removeRunParentsForRun(runId)),
    runParents: (childId) => guard(memory, unguarded.runParents(childId)),
    runChildren: (parentId) => guard(memory, unguarded.runChildren(parentId)),
    transaction,
    // Memory has no lock to contend for; its permit is what keeps reads agreeing.
    readTransaction: (effect) => transaction(effect)
  })
}

/**
 * Provides deterministic in-memory durable engine state.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerMemory: Layer.Layer<DurableEngineState> = Layer.sync(
  DurableEngineState,
  makeMemory
)
