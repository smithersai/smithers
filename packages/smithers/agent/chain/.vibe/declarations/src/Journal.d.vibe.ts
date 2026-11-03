/**
 * The append-only journal port — the chain's only state.
 *
 * The in-memory layer is a deletable stand-in for the Smithers engine journal:
 * the e2e suite asserts journal contents, not this API, so the suite
 * survives the engine swap (https://chain.smithers.sh/contract/).
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Event from "./Event.vibe";
declare const JournalError_base: Schema.Class<JournalError, Schema.TaggedStruct<"/chain/JournalError", {
    readonly code: Schema.withConstructorDefault<Schema.Literals<readonly ["journal_conflict", "journal_unavailable"]>>;
    readonly message: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * A journal that cannot be appended to or read.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export declare class JournalError extends JournalError_base {
}
/**
 * The two operations the chain needs: append one event, read them all.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Service {
    readonly append: (event: Event.Event, expectedPosition: number) => Effect.Effect<void, JournalError>;
    readonly read: Effect.Effect<ReadonlyArray<Event.Event>, JournalError>;
}
declare const Journal_base: Context.ServiceClass<Journal, "/chain/Journal", Service>;
/**
 * The journal service tag.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export declare class Journal extends Journal_base {
}
/**
 * Builds a journal from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const make: (implementation: Service) => Service;
/**
 * A journal whose every operation fails as unavailable, with per-operation
 * overrides — the default a test starts from.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export declare const makeNoop: (overrides?: Partial<Service>) => Service;
/**
 * The unavailable journal as a layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export declare const layerNoop: (overrides?: Partial<Service>) => Layer.Layer<Journal>;
/**
 * An in-memory journal over one array, optionally seeded with prior events —
 * the seed is how tests replay and resume a chain. Appends push in place and
 * reads hand out a copy, so a reader never sees a later append and an append
 * never copies the history.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export declare const layerMemory: (initial?: ReadonlyArray<Event.Event>) => Layer.Layer<Journal>;
export {};
