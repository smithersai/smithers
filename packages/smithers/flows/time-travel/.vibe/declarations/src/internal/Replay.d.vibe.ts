/**
 * Deriving a run's past state from committed journal evidence alone.
 *
 * This is what makes a frame an address rather than a snapshot: nothing stores
 * "the state at seq 17", so {@link rederive} folds the journal prefix up to a
 * frame through a caller-supplied {@link Projection}. It reads only durable
 * evidence — entries and sealed cache results — and has no dispatcher, so a
 * replay can never re-execute a model call or a child flow. Anything not
 * committed simply is not in the answer.
 *
 * Entries are filtered by lineage, so a run whose journal interleaves several
 * lineages replays exactly the one the frame names.
 *
 * The fold STREAMS. `Journal.entries` hands pages back in sequence order, so
 * each page is folded as it arrives and the read stops at the first record
 * past the frame; nothing below the frame is retained once it has been folded.
 * The prefix used to be collected whole and sorted before the first reduce, so
 * a frame near the head of a long run still paid for the run's whole history.
 *
 * @since 0.1.0
 */
import * as EngineEvent from "@smthrs/journal/EngineEvent";
import * as Journal from "@smthrs/journal/Journal";
import type { Entry } from "@smthrs/journal/JournalEvent";
import * as CacheStore from "@smthrs/step-cache/CacheStore";
import * as Effect from "effect/Effect";
import type { Frame } from "../Frame.vibe";
import { type TimeTravelError } from "../TimeTravelError.vibe";
/**
 * A pure fold over durable journal evidence.
 *
 * @since 0.1.0
 * @category models
 */
export interface Projection<S> {
    readonly initial: S;
    readonly reduce: (state: S, entry: Entry, sealed: unknown | undefined) => S;
}
/**
 * Which run to replay, and how large a journal page to read at a time.
 *
 * `pageSize` is a throughput knob only — it never changes the derived state,
 * because the fold sees the same entries in the same order whatever the page
 * boundaries are. It defaults to 100.
 *
 * @since 0.1.0
 * @category models
 */
export interface ReplayOptions {
    readonly runId: string;
    /** Required when replay encounters v2 engine events; supplied by the history owner. */
    readonly engineEvents?: EngineEvent.Consumer | undefined;
    readonly pageSize?: number;
    /**
     * The most entries the fold may read at or below the frame before it stops
     * with `limit_exceeded`. Defaults to `HistoryLimit.defaultMaxHistoryEntries`.
     */
    readonly maxEntries?: number;
}
/**
 * Re-derives a projection from committed evidence only. This deliberately has
 * no dispatcher dependency: model and child results can only be cache reads.
 * @since 0.1.0
 * @category constructors
 */
export declare const rederive: <S>(frame: Frame, projection: Projection<S>, options: ReplayOptions) => Effect.Effect<S, TimeTravelError, Journal.Journal | CacheStore.CacheStore>;
