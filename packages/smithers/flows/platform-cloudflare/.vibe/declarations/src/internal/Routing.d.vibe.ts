/**
 * Which other executions a drive left for their own Durable Objects.
 *
 * A Durable Object drives one execution, and its runtime refuses every other
 * one. A drive can still create executions and make them due: a `.child()`
 * call admits a child, a `.to()` handoff admits the next round, and a
 * settlement makes the parents waiting on it due, or asks a linked child to
 * cancel, and a cancellation admits the run its flow declared for it
 * (`Flow.OnCancel`). The store records each of those, and `EngineStore.drive` records a
 * settled run's parent wakes again whenever it finds one missing, so the
 * object reads them back from the store after every drive, not from what the
 * drive happened to report before an isolate died.
 *
 * @since 1.0.0
 */
import { DurableEngineState } from "@smthrs/engine-store";
import { RunStore } from "@smthrs/run-store";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
/**
 * What a drive left for other objects.
 *
 * - `start`: executions this one created that no object has driven yet, as
 *   the intents their own objects store.
 * - `wake`: executions with work due now that their own objects already
 *   hold: a parent this one's settlement made due, or a child or the next
 *   round asked to cancel.
 *
 * @category models
 * @since 1.0.0
 */
export interface Routes {
    readonly start: ReadonlyArray<{
        readonly flow: string;
        readonly executionId: string;
        readonly payload: unknown;
    }>;
    readonly wake: ReadonlyArray<string>;
}
/**
 * Reads what driving `executionId` left for other objects.
 *
 * 1. The round it handed off to, if any, and the current round of each child
 *    lineage linked to it: to this round alone while the lineage runs, and to
 *    every round of it once its last round settled, since that settlement
 *    ends the linked children of every round. One with work due is started
 *    when it is still `pending`, since no object has its intent yet, and woken
 *    otherwise, as a child asked to cancel is.
 * 2. When it was cancelled, the cancellation run its flow declared, which its
 *    cancelled state names: started on its own object, since nothing else
 *    holds its intent.
 * 3. Its parents, when it settled and is the last round of its lineage: every
 *    parent the engine wakes for a settlement (the one its state names and
 *    the edges of every round), when that parent has work due. An earlier
 *    round's settlement wakes no parent; the lineage has not settled.
 *
 * "Due" is `EngineStore.nextWake` at or before now, so a parent that has
 * already consumed this settlement, a settled child and an unknown id are
 * left alone. Every read is one read transaction: one snapshot, and the
 * round trips of one transaction rather than one per read.
 *
 * @category operations
 * @since 1.0.0
 */
export declare const routes: (executionId: string) => Effect.Effect<{
    start: {
        readonly flow: string;
        readonly executionId: string;
        readonly payload: unknown;
    }[];
    wake: string[];
}, RunStore.RunStoreError | Schema.SchemaError, DurableEngineState.DurableEngineState | RunStore.RunStore>;
