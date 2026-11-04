/**
 * Shared engine node-record identity rules for the duration projection.
 *
 * A host copies every engine journal entry of a run into the control journal
 * as a `control.engine.event` envelope, so the node records both executors
 * write arrive here verbatim. The envelope's own fields are guarded the way
 * `callEvents.ts` guards them, and the record inside it is decoded with the
 * payload schemas `@smthrs/journal` publishes rather than with a second,
 * hand-written copy of the same contract.
 *
 * @since 1.0.0
 */
import { EngineEvent } from "@smthrs/journal";
/** A sparse historical observation is readable without inventing missing fields.
 * @category models
 * @since 1.0.0
 */
export interface NodeObservation {
    readonly kind?: string | undefined;
    readonly payload?: unknown;
}
/**
 * One node record, with the envelope coordinates that scope and stamp it.
 *
 * `executionId` is the native run the record belongs to, which is what keeps
 * two executions of one node id apart, and `emittedAtMs` is the native
 * timestamp the engine wrote, which is what a duration is measured between.
 *
 * @category models
 * @since 1.0.0
 */
export interface NodeRecord<Payload> {
    readonly executionId: string;
    readonly emittedAtMs: number;
    readonly payload: Payload;
}
/** A node the executor admitted, as the engine recorded it.
 * @category projections
 * @since 1.0.0
 */
export declare const nodeScheduled: (event: NodeObservation) => NodeRecord<EngineEvent.NodeScheduledPayload> | undefined;
/** A node that reached an outcome, as the engine recorded it.
 * @category projections
 * @since 1.0.0
 */
export declare const nodeSettled: (event: NodeObservation) => NodeRecord<EngineEvent.NodeSettledPayload> | undefined;
