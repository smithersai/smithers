/**
 * The tier-2 anchor projector: engine snapshot records in, frame anchors out.
 *
 * `docs/concepts/derived-state.md`: a frame must carry the jj pointer
 * current when its seq was journaled and the plan digest in force, because
 * replay cannot derive either. The engine emits both facts as ordinary journal
 * records — it has to, it is the only thing that knows them — but the engine
 * must NOT write `flows_time_travel_snapshots` itself: `@smthrs/time-travel`
 * already depends on `@smthrs/engine-store`, so an engine that wrote this
 * package's tables would close a dependency cycle.
 *
 * A projector is the seam that keeps the arrow one-way. It reads the journal
 * (which both packages may depend on) and folds it into the anchor table
 * through {@link TimeTravelStore.Service.recordSnapshot}. The journal's projection
 * rule applies: a projection has no independent durable state, so replaying the
 * same entries reproduces the same anchors, and running it twice is a no-op.
 *
 * @since 0.1.0
 */
import * as Journal from "@smthrs/journal/Journal";
import type * as JournalEvent from "@smthrs/journal/JournalEvent";
import type * as Projection from "@smthrs/journal/Projection";
import * as Effect from "effect/Effect";
import { type TimeTravelError } from "../TimeTravelError.vibe";
import { type Snapshot, TimeTravelStore } from "../TimeTravelStore.ts";
/**
 * The anchor facts one lineage has put in force.
 *
 * `changeId` is the pointer the lineage's last anchor named, which is what a
 * `carried` record on that lineage resolves to; `planDigest` is the digest
 * the lineage's last plan record put in force. Both start absent, and an
 * anchor is written only once a pointer exists: a lineage that has taken no
 * snapshot has no tier-2 state to restore, and inventing one would be worse
 * than reporting none.
 *
 * @since 0.1.0
 * @category models
 */
export interface LineageState {
    readonly changeId: string | undefined;
    readonly operationId?: string | undefined;
    readonly planDigest: string | undefined;
}
/**
 * What the fold carries between entries.
 *
 * Facts are keyed BY LINEAGE. A run's journal can interleave lineages, and a
 * `carried` record asserts "the same pointer as my lineage's previous anchor",
 * never "the pointer whoever wrote last named". One run-wide pointer resolved
 * lineage B's carried record to lineage A's snapshot and recorded it under B,
 * so a later fork or rewind of B restored A's workspace. The plan digest is
 * scoped the same way: a plan record belongs to the lineage that recorded it.
 *
 * @since 0.1.0
 * @category models
 */
export interface State {
    readonly lineages: Readonly<Record<string, LineageState>>;
    readonly anchors: number;
}
/**
 * The fold's starting {@link State}: no lineage known, nothing anchored.
 *
 * A projection has no durable state of its own beyond the anchors it writes,
 * so a fold from here replays to the same result as one resumed from them.
 *
 * @since 0.1.0
 * @category constants
 */
export declare const initial: State;
/**
 * One fold step: the state after `entry`, and the anchor the entry put in
 * force, if any.
 *
 * Pure with respect to the store, so {@link project} can batch a page's
 * anchors into one write while {@link projection} records each as it folds.
 *
 * @since 0.1.0
 * @category constructors
 */
export declare const step: (state: State, entry: JournalEvent.Entry) => Effect.Effect<{
    readonly state: State;
    readonly anchor: Snapshot | undefined;
}, TimeTravelError>;
/**
 * The fold, as a reproducible journal projection.
 *
 * @since 0.1.0
 * @category constructors
 */
export declare const projection: (store: TimeTravelStore["Service"]) => Projection.Projection<State, TimeTravelError>;
/**
 * What {@link project} reads and where it stops.
 *
 * @since 0.1.0
 * @category models
 */
export interface ProjectOptions {
    /** Journal page size; defaults to 200. */
    readonly pageSize?: number | undefined;
    /**
     * The seq the fold stops at, inclusive. A fork or rewind restores from the
     * anchor at or below its frame, so it has no use for anchors above it.
     */
    readonly upTo?: number | undefined;
    /**
     * The most unanchored entries the fold may read before it refuses with
     * `limit_exceeded`. Entries at or below the anchored high-water mark are
     * never re-read, so a run whose anchors are current costs one page.
     */
    readonly maxEntries?: number | undefined;
}
/**
 * Folds one run's committed journal into its frame anchors, resuming from the
 * anchors already recorded.
 *
 * The fold is {@link projection}, a plain `@smthrs/journal` `Projection` that
 * `Journal.project` runs unchanged — that is the reusable artifact, and a live
 * follower should use exactly that. What this driver does NOT do is call
 * `Journal.project` itself, because that stream replays a run and then FOLLOWS
 * its committed tail: it never ends, so a verb that awaited it would hang
 * forever instead of forking. Paging `entries` gives the same fold a terminating
 * driver.
 *
 * The anchor table is the projection's own output, so it is also its cursor:
 * the driver reads the last anchor per lineage, folds only the entries above
 * the highest one, and writes each page's anchors in one store write. A run
 * whose anchors are current reads one page and writes nothing, and a second
 * run over the same journal is a no-op in the store, not merely in the result.
 *
 * @since 0.1.0
 * @category constructors
 */
export declare const project: (runId: string, options?: ProjectOptions) => Effect.Effect<State, TimeTravelError, Journal.Journal | TimeTravelStore>;
