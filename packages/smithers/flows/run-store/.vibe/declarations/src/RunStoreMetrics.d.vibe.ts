/**
 * Standard metric definitions for fenced run persistence.
 *
 * This module only defines the metric handles, following the shape of Effect's
 * `ClusterMetrics`. `RunStore` updates them as compare-and-swap outcomes are
 * decided, so every driver that persists through the store — the engine, a
 * sweeper, a foreign process — lands in the same counters. No exporter ships
 * in this package; provide one — for example `@smthrs/observability` —
 * and these counters appear in it.
 *
 * Each exported record maps an outcome's `_tag` to an attributed view of the
 * counter, so an update is a lookup rather than a branch:
 * `Metric.update(RunStoreMetrics.claim[outcome._tag], 1)`.
 *
 * @since 0.1.0
 */
import * as Metric from "effect/Metric";
/**
 * Counter over ownership claim compare-and-swaps, dimensioned by `op`
 * (`claim`, `claim_and_own`, `activate`, `abandon_claim`, `recover_claim`, or
 * `steal`) and `outcome` (the
 * operation's result tag in snake case, or `failure` or `interrupt` when the
 * call did not return one).
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const claims: Metric.Counter<number>;
/**
 * Counter over fenced run state transitions, dimensioned by `outcome`
 * (`transitioned`, `fence_lost`, `not_found`, `guard_failed`, `failure`, or
 * `interrupt`) and `to` (the requested target status).
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const transitions: Metric.Counter<number>;
/**
 * Counter over fenced ownership heartbeats, dimensioned by `outcome`
 * (`updated`, `fence_lost`, `not_found`, `failure`, or `interrupt`). A
 * `fence_lost` heartbeat is the fencing event: the writer discovered another
 * owner holds the run.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const heartbeats: Metric.Counter<number>;
/**
 * `claims` views for `RunStore.claim`, keyed by `ClaimOutcome` tag.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const claim: {
    readonly AlreadyClaimed: Metric.Metric<number, Metric.CounterState<number>>;
    readonly Claimed: Metric.Metric<number, Metric.CounterState<number>>;
    readonly HeartbeatFresh: Metric.Metric<number, Metric.CounterState<number>>;
    readonly NotFound: Metric.Metric<number, Metric.CounterState<number>>;
    readonly SnapshotChanged: Metric.Metric<number, Metric.CounterState<number>>;
};
/**
 * `claims` views for `RunStore.claimAndOwn`, keyed by `ClaimAndOwnOutcome`
 * tag.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const claimAndOwn: {
    readonly Activated: Metric.Metric<number, Metric.CounterState<number>>;
    readonly AlreadyClaimed: Metric.Metric<number, Metric.CounterState<number>>;
    readonly EvidenceRequired: Metric.Metric<number, Metric.CounterState<number>>;
    readonly HeartbeatFresh: Metric.Metric<number, Metric.CounterState<number>>;
    readonly NotFound: Metric.Metric<number, Metric.CounterState<number>>;
    readonly SnapshotChanged: Metric.Metric<number, Metric.CounterState<number>>;
};
/**
 * `claims` views for `RunStore.activate`, keyed by `ActivateOutcome` tag. A
 * `claim_lost` activation is a fencing event: the held claim was recovered or
 * replaced before the activation ran.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const activate: {
    readonly Activated: Metric.Metric<number, Metric.CounterState<number>>;
    readonly ClaimLost: Metric.Metric<number, Metric.CounterState<number>>;
    readonly SnapshotChanged: Metric.Metric<number, Metric.CounterState<number>>;
};
/**
 * `claims` views for `RunStore.abandonClaim`, keyed by outcome tag.
 *
 * @category metrics
 * @since 1.0.0-rc.0
 */
export declare const abandonClaim: {
    readonly Abandoned: Metric.Metric<number, Metric.CounterState<number>>;
    readonly ClaimLost: Metric.Metric<number, Metric.CounterState<number>>;
};
/**
 * `claims` views for `RunStore.recoverClaim`, keyed by outcome tag.
 *
 * @category metrics
 * @since 1.0.0-rc.0
 */
export declare const recoverClaim: {
    readonly ClaimChanged: Metric.Metric<number, Metric.CounterState<number>>;
    readonly ClaimFresh: Metric.Metric<number, Metric.CounterState<number>>;
    readonly LivenessUnconfirmed: Metric.Metric<number, Metric.CounterState<number>>;
    readonly NotFound: Metric.Metric<number, Metric.CounterState<number>>;
    readonly Recovered: Metric.Metric<number, Metric.CounterState<number>>;
};
/**
 * `claims` views for `RunStore.steal`, keyed by `StealOutcome` tag.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const steal: {
    readonly AlreadyClaimed: Metric.Metric<number, Metric.CounterState<number>>;
    readonly Claimed: Metric.Metric<number, Metric.CounterState<number>>;
    readonly HeartbeatFresh: Metric.Metric<number, Metric.CounterState<number>>;
    readonly LivenessUnconfirmed: Metric.Metric<number, Metric.CounterState<number>>;
    readonly NotFound: Metric.Metric<number, Metric.CounterState<number>>;
    readonly SnapshotChanged: Metric.Metric<number, Metric.CounterState<number>>;
};
/**
 * `heartbeats` views keyed by `HeartbeatOutcome` tag.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const heartbeat: {
    readonly FenceLost: Metric.Metric<number, Metric.CounterState<number>>;
    readonly NotFound: Metric.Metric<number, Metric.CounterState<number>>;
    readonly Updated: Metric.Metric<number, Metric.CounterState<number>>;
};
/**
 * `transitions` views keyed by `TransitionOutcome` tag. `RunStore` adds the
 * `to` attribute at the update site, because the target status is call input
 * rather than a closed set this module should restate.
 *
 * @category metrics
 * @since 0.1.0
 */
export declare const transition: {
    readonly FenceLost: Metric.Metric<number, Metric.CounterState<number>>;
    readonly GuardFailed: Metric.Metric<number, Metric.CounterState<number>>;
    readonly NotFound: Metric.Metric<number, Metric.CounterState<number>>;
    readonly Transitioned: Metric.Metric<number, Metric.CounterState<number>>;
};
