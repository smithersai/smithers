/**
 * Standard metric definitions for the engine-store hot paths.
 *
 * This module only defines the metric handles, following the shape of
 * `RunStoreMetrics` and Effect's `ClusterMetrics`. The dispatch seam
 * (`internal/ActionPersistence`), the plan scheduler, the workspace sandbox,
 * and the run driver update them as outcomes are decided. No exporter ships in
 * this package; provide one — for example `@smthrs/observability` — and
 * these series appear in it.
 *
 * Counters over an effect's exit are keyed by {@link ExitTag} records, so an
 * update is a lookup rather than a branch, and durations land in
 * `Metric.timer` histograms through Effect's own `Effect.trackDuration`. The
 * same exit observation annotates the operation span with its outcome; none of
 * the instrumentation combinators alters the instrumented effect's result or
 * cause.
 *
 * @since 0.1.0
 */
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as Metric from "effect/Metric";
/**
 * How an instrumented effect exited: `Success`, `Failure` (any non-interrupt
 * cause), or `Interrupt` (an interrupt-only cause — in this store that is the
 * fencing self-interruption as well as caller cancellation).
 *
 * @category models
 * @since 0.1.0
 */
export type ExitTag = "Success" | "Failure" | "Interrupt";
/**
 * Classifies an exit for an {@link ExitTag}-keyed counter record.
 *
 * @category accessors
 * @since 0.1.0
 */
export declare const exitTag: <A, E>(exit: Exit.Exit<A, E>) => ExitTag;
/**
 * Observes an effect with a duration timer and an exit-outcome counter.
 *
 * Composes Effect's own `Effect.trackDuration` (monotonic clock, records on
 * success, failure, and interruption alike) with an `Effect.onExit` counter
 * update and current-span annotation, so the instrumented effect's exit —
 * value, cause, and interruption — propagates byte-identically. This is the
 * dual-instrument shape production Effect services use for hot-path
 * operations.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const observe: (instruments: {
    readonly timer: Metric.Histogram<Duration.Duration>;
    readonly counter: { readonly [Tag in ExitTag]: Metric.Metric<number, Metric.CounterState<number>>; };
}) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
/**
 * Counter over durable action dispatches through
 * `internal/ActionPersistence`, dimensioned by exit `outcome` (`success`,
 * `failure`, or `interrupt`). A cache-served replay and a fresh execution
 * both count: the dispatch is the unit the engine retries and fences.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const dispatches: Metric.Counter<number>;
/**
 * Latency histogram over durable action dispatches, from admission through
 * settlement (cache verification, execution, copy-back, and the terminal
 * row included).
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const dispatchDuration: Metric.Histogram<Duration.Duration>;
/**
 * `dispatches` views keyed by {@link ExitTag}.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const dispatch: {
    readonly Failure: Metric.Metric<number, Metric.CounterState<number>>;
    readonly Interrupt: Metric.Metric<number, Metric.CounterState<number>>;
    readonly Success: Metric.Metric<number, Metric.CounterState<number>>;
};
/**
 * Counter over scheduler admission passes that launched work. The
 * completion-driven scheduler re-computes the ready set after every terminal
 * event; only a pass that admits at least one node counts, so the series
 * reads as "how many times the scheduler opened dispatch permits", not as
 * event-loop noise.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const schedulerAdmissions: Metric.Counter<number>;
/**
 * Latency histogram over one scheduler dispatch, admission through terminal
 * event: measurement, keying, the durable-action seam, and every rebase turn
 * of the same node's loop land in a single observation.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const schedulerDispatchDuration: Metric.Histogram<Duration.Duration>;
/**
 * Counter over plan node settlements, dimensioned by the scheduler `outcome`
 * (`built`, `clean`, `failed`, `skipped`, or `deferred`) — the per-node
 * evaluation vocabulary `PlanScheduler` journals.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const schedulerNodes: Metric.Counter<number>;
/**
 * `schedulerNodes` views keyed by `PlanScheduler.Outcome`.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const node: {
    readonly built: Metric.Metric<number, Metric.CounterState<number>>;
    readonly clean: Metric.Metric<number, Metric.CounterState<number>>;
    readonly deferred: Metric.Metric<number, Metric.CounterState<number>>;
    readonly failed: Metric.Metric<number, Metric.CounterState<number>>;
    readonly skipped: Metric.Metric<number, Metric.CounterState<number>>;
};
/**
 * Counter over isolated workspace executions (`WorkspaceSandbox.execute`),
 * dimensioned by exit `outcome`. An `Invalidated` verdict is a `success`
 * exit — the transaction ran and answered; the verdict itself is journaled.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const sandboxExecutions: Metric.Counter<number>;
/**
 * `sandboxExecutions` views keyed by {@link ExitTag}.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const sandboxExecution: {
    readonly Failure: Metric.Metric<number, Metric.CounterState<number>>;
    readonly Interrupt: Metric.Metric<number, Metric.CounterState<number>>;
    readonly Success: Metric.Metric<number, Metric.CounterState<number>>;
};
/**
 * Latency histogram over isolated workspace executions.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const sandboxExecutionDuration: Metric.Histogram<Duration.Duration>;
/**
 * Counter over sandbox materializations (`WorkspaceSandbox.materialize` —
 * the one host write), dimensioned by exit `outcome`.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const sandboxMaterializations: Metric.Counter<number>;
/**
 * `sandboxMaterializations` views keyed by {@link ExitTag}.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const materialization: {
    readonly Failure: Metric.Metric<number, Metric.CounterState<number>>;
    readonly Interrupt: Metric.Metric<number, Metric.CounterState<number>>;
    readonly Success: Metric.Metric<number, Metric.CounterState<number>>;
};
/**
 * Latency histogram over sandbox materializations.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const materializationDuration: Metric.Histogram<Duration.Duration>;
/**
 * Counter over copy-back compare-and-set refusals: the preflight found host
 * state that moved after the transaction's base snapshot. The engine answers
 * one with a rebase or a conflict strategy, so the rate is contention
 * evidence, not an error rate.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const materializationConflicts: Metric.Counter<number>;
/**
 * Counter over action attempts interrupted because the engine's store was
 * unavailable while the attempt was admitted, run or recorded: a lost
 * connection, an I/O failure, a busy database. Each one releases its run for a
 * later drive that adopts the attempt, so a rising rate is a storage outage,
 * not failing actions.
 *
 * @category metrics
 * @since 1.0.0
 */
export declare const storageUnavailable: Metric.Counter<number>;
/**
 * Counter over hosted drives that spent their budget (`EngineStore.drive`'s
 * `budgetMs`) and yielded at a step boundary. Each one releases its run for a
 * drive that follows at once; a run that yields on every drive has more work
 * than one drive's budget, which is what the budget is for.
 *
 * @category metrics
 * @since 1.0.0
 */
export declare const driveYields: Metric.Counter<number>;
/**
 * Counter over hosted drives that drove their run again themselves: it parked
 * on a wake due within the drive's `holdMs` (`EngineStore.drive`), such as a
 * short durable sleep, which its host would otherwise wake it for with a new
 * invocation.
 *
 * @category metrics
 * @since 1.0.0
 */
export declare const heldDrives: Metric.Counter<number>;
/**
 * Counter over rounds that read their replay seed: the run's attempt rows and
 * journal entries, read at once before a resumed run replays them, so a
 * recorded step answers without a read of its own.
 *
 * @category metrics
 * @since 1.0.0
 */
export declare const replaySeeds: Metric.Counter<number>;
/**
 * Counter over retries from a step (`FlowRuntime.retryFrom`), dimensioned by
 * `outcome`: `admitted` for a new run, `joined` for a repeated request,
 * `carried` for a child a retry carried from its source instead of running it
 * again, or the refusal's code.
 *
 * @category metrics
 * @since 1.0.0
 */
export declare const retriesFrom: Metric.Counter<number>;
/**
 * Counter over the source attempts retries from a step copied into their new
 * runs, which replay instead of executing.
 *
 * @category metrics
 * @since 1.0.0
 */
export declare const retrySeededAttempts: Metric.Counter<number>;
/**
 * Counter over step-boundary settlements at the dispatch seam, dimensioned by
 * `outcome`: `clean` evidence, an `expected`-mode `deviation`, or a hard
 * `violation` (undeclared write, missing declared output, surviving declared
 * removal), with `refused` for a host that could not settle at all.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const boundarySettlements: Metric.Counter<number>;
/**
 * `boundarySettlements` views keyed by settlement classification.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const boundarySettlement: {
    readonly Clean: Metric.Metric<number, Metric.CounterState<number>>;
    readonly Deviation: Metric.Metric<number, Metric.CounterState<number>>;
    readonly Refused: Metric.Metric<number, Metric.CounterState<number>>;
    readonly Violation: Metric.Metric<number, Metric.CounterState<number>>;
};
/**
 * Counter over the EFFECTIVE step-boundary cache decisions at the dispatch
 * seam, dimensioned by `outcome`. `flows_step_cache_lookups` counts raw row
 * presence at `CacheStore.get`; this series records what the dispatch
 * actually did with the row after read-set verification and output
 * materialization — `verified_hit` served the cached result, and every other
 * outcome fell through to a real execution (`miss` no row,
 * `unverifiable_evidence` a row whose recorded evidence cannot justify reuse,
 * `unmeasurable` a host that could not re-measure the read set,
 * `stale_read_set` a measured mismatch, `replay_failed` verified evidence the
 * host could not re-materialize). Each decision is counted where it takes
 * effect: `verified_hit` as the cached result is returned, a fall-through
 * outcome as the dispatch proceeds past its refusal handling — so a
 * cache-consulting dispatch that fails or is fenced out mid-decision (a
 * journal failure on the provenance emit, a strict corruption verdict)
 * records no decision, and its exit lands in {@link dispatches}. At most one
 * decision is counted per cache-consulting dispatch.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const stepCacheDecisions: Metric.Counter<number>;
/**
 * `stepCacheDecisions` views keyed by decision.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const stepCacheDecision: {
    readonly Miss: Metric.Metric<number, Metric.CounterState<number>>;
    readonly ReplayFailed: Metric.Metric<number, Metric.CounterState<number>>;
    readonly StaleReadSet: Metric.Metric<number, Metric.CounterState<number>>;
    readonly Unmeasurable: Metric.Metric<number, Metric.CounterState<number>>;
    readonly UnverifiableEvidence: Metric.Metric<number, Metric.CounterState<number>>;
    readonly VerifiedHit: Metric.Metric<number, Metric.CounterState<number>>;
};
/**
 * Counter over the run driver's claim-and-activate decisions, dimensioned by
 * `outcome`. These are the engine-level decisions taken BEFORE or AFTER the
 * store-level compare-and-swaps `RunStoreMetrics` counts: a `terminal` or
 * `heartbeat_fresh` refusal never reaches the store, `steal_refused_owner_alive`
 * is the liveness probe declining, and `claim_lost`/`activation_lost` are the
 * driver observing a lost store CAS.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const claims: Metric.Counter<number>;
/**
 * `claims` views keyed by driver decision.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const claim: {
    readonly Activated: Metric.Metric<number, Metric.CounterState<number>>;
    readonly ActivationLost: Metric.Metric<number, Metric.CounterState<number>>;
    readonly ClaimLost: Metric.Metric<number, Metric.CounterState<number>>;
    readonly HeartbeatFresh: Metric.Metric<number, Metric.CounterState<number>>;
    readonly StealRefusedOwnerAlive: Metric.Metric<number, Metric.CounterState<number>>;
    readonly Terminal: Metric.Metric<number, Metric.CounterState<number>>;
};
/** Confirmed ownership heartbeat receipts, by outcome (completed, skipped, failed).
 * External receipts are bounded and never block the ownership writer.
 * @category metrics
 * @since 1.0.0
 */
export declare const heartbeatReceipts: Metric.Counter<number>;
/**
 * Counter over the log records action attempt bodies emitted at or above the
 * ambient minimum level, dimensioned by what became of each (`outcome`):
 * `journaled` into the attempt's run, or lost and counted as
 * `dropped_limit` (past `StepLogs.Limits.records`), `dropped_queue` (the
 * attempt's queue was full or closed), `dropped_journal` (the journal's lossy
 * channel refused it), `dropped_flush` (still queued when the flush deadline
 * passed, or its write was interrupted) or `failed` (the journal write
 * failed). The one summary record an attempt with losses journals counts too.
 *
 * @category metrics
 * @since 1.0.0
 */
export declare const stepLogs: Metric.Counter<number>;
/**
 * `stepLogs` views keyed by outcome.
 *
 * @category metrics
 * @since 1.0.0
 */
export declare const stepLog: {
    readonly DroppedFlush: Metric.Metric<number, Metric.CounterState<number>>;
    readonly DroppedJournal: Metric.Metric<number, Metric.CounterState<number>>;
    readonly DroppedLimit: Metric.Metric<number, Metric.CounterState<number>>;
    readonly DroppedQueue: Metric.Metric<number, Metric.CounterState<number>>;
    readonly Failed: Metric.Metric<number, Metric.CounterState<number>>;
    readonly Journaled: Metric.Metric<number, Metric.CounterState<number>>;
};
