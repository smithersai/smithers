/**
 * Shared call lifecycle identity rules for full and incremental projections.
 *
 * @since 1.0.0
 */
/** A sparse historical observation is readable without inventing missing fields.
 * @category models
 * @since 1.0.0
 */
export interface CallObservation {
    readonly kind?: string | undefined;
    readonly runId?: string | undefined;
    readonly sequence?: number | undefined;
    readonly payload?: unknown;
}
/** Interpret only the native producer's versioned, run-scoped outbox facts.
 * @category projections
 * @since 1.0.0
 */
export declare const nativeCallEvent: <Event extends CallObservation>(event: Event) => Event | undefined;
/** Normalize a checkpoint only within its recorded execution and source.
 * Replayed prefixes retain the generation that first recorded the work.
 * @category projections
 * @since 1.0.0
 */
export declare const nativeStepEvent: <Event extends CallObservation>(event: Event) => Event | undefined;
/** Scope call matching to the recorded invocation, including its generation.
 * @category projections
 * @since 1.0.0
 */
export declare const callScope: (event: CallObservation) => string | undefined;
/**
 * Identity first; the upgrade fallback can consume only unidentified starts.
 *
 * @category projections
 * @since 1.0.0
 */
export declare const openCallIndex: (open: ReadonlyArray<{
    readonly flowName: string;
    readonly callId?: string | undefined;
    readonly scope?: string | undefined;
}>, callId: string | undefined, flowName: string | undefined, scope?: string) => number;
/**
 * Deduplicate identified call lifecycles and committed checkpoint observations.
 *
 * @category projections
 * @since 1.0.0
 */
export declare const callEventKey: (event: CallObservation) => string | undefined;
/**
 * Native facts supersede identified telemetry while retaining its display
 * position. Unidentified history cannot acquire an invented identity.
 *
 * @category projections
 * @since 1.0.0
 */
export declare const uniqueCallEvents: <Event extends CallObservation>(events: ReadonlyArray<Event>) => ReadonlyArray<Event>;
/**
 * What {@link CallEventFilter} did with one event.
 *
 * `rewrite` means the event superseded one the filter already kept: the batch
 * rule replaces the earlier event in place, so a reader holding the earlier
 * output must refold from the whole journal.
 *
 * @category projections
 * @since 1.0.0
 */
export type CallEventVerdict<Event> = {
    readonly _tag: "keep";
    readonly event: Event;
} | {
    readonly _tag: "drop";
} | {
    readonly _tag: "rewrite";
};
/**
 * {@link uniqueCallEvents} one event at a time, for a journal read in order.
 *
 * The sets are exactly the ones the batch builds, so a filter fed a whole
 * journal holds the state the batch ended with. Only one case cannot be
 * answered in order: a native fact whose key an earlier telemetry event
 * already claimed. That verdict is `rewrite`.
 *
 * @category projections
 * @since 1.0.0
 */
export interface CallEventFilter<Event extends CallObservation> {
    readonly push: (event: Event) => CallEventVerdict<Event>;
}
/**
 * Builds an empty {@link CallEventFilter}.
 *
 * @category projections
 * @since 1.0.0
 */
export declare const callEventFilter: <Event extends CallObservation>() => CallEventFilter<Event>;
