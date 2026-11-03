/**
 * Durable suspected-edge storage for probabilistic selection.
 *
 * The store persists advisory beliefs only: training moves edge confidence and
 * appends evidence, but it never writes scheduler journal records, step keys,
 * or cache rows (law 5). The edge and snapshot schemas are `Selection`'s own —
 * one source of truth, so a stored edge is by construction what
 * `Selection.select` consumes. Evidence entries stay strings: training appends
 * the observation JSON-encoded, so audits can replay the asymmetric rule
 * without the schema forking from `Selection.SuspectedEdge`.
 *
 * Model-backed selection, CLI verbs, approval routing, auto-appending
 * proposals, and scheduled recertification cadence are deliberately out of
 * scope here: `engine-store` must not grow a model dependency, no selection
 * CLI verbs are exposed yet, approval routing belongs to
 * `@smthrs/control`, proposal admission still needs human product review, and
 * cadence belongs to a system-flow/product layer rather than the primitive
 * store.
 *
 * @since 0.1.0
 */
import { DurableWriter } from "@smthrs/database/DurableWriter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Selection from "../../../src/Selection.ts";
/**
 * Training outcomes for a suspected edge: a `hit` is a recertified deferral
 * that passed, a `miss` is one that failed — the guess was confidently wrong.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const TrainingOutcome: Schema.Literals<readonly ["hit", "miss"]>;
/**
 * Training outcomes for a suspected edge.
 *
 * @category models
 * @since 0.1.0
 */
export type TrainingOutcome = typeof TrainingOutcome.Type;
/**
 * One observed result for a stored suspected edge.
 *
 * @category schemas
 * @since 0.1.0
 */
export declare const TrainingObservation: Schema.Struct<{
    readonly scope: Schema.NonEmptyString;
    readonly affects: Schema.NonEmptyString;
    readonly outcome: Schema.Literals<readonly ["hit", "miss"]>;
}>;
/**
 * One observed result for a stored suspected edge.
 *
 * @category models
 * @since 0.1.0
 */
export type TrainingObservation = typeof TrainingObservation.Type;
/**
 * Stable selection-store failure codes.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const SelectionStoreErrorCode: Schema.Literals<readonly ["invalid_input", "decode_failed", "persistence_failed"]>;
/**
 * Stable selection-store failure codes.
 *
 * @category models
 * @since 1.0.0
 */
export type SelectionStoreErrorCode = typeof SelectionStoreErrorCode.Type;
declare const SelectionStoreError_base: Schema.Class<SelectionStoreError, Schema.TaggedStruct<"@smthrs/engine-store/SelectionStoreError", {
    readonly code: Schema.Literals<readonly ["invalid_input", "decode_failed", "persistence_failed"]>;
    readonly message: Schema.String;
    readonly scope: Schema.optional<Schema.String>;
    readonly affects: Schema.optional<Schema.String>;
    readonly cause: Schema.optional<Schema.Unknown>;
}>, import("effect/Cause").YieldableError>;
/**
 * A rejected public value, corrupt stored row, or unavailable database.
 *
 * @category errors
 * @since 1.0.0
 */
export declare class SelectionStoreError extends SelectionStoreError_base {
}
/**
 * Durable suspected-edge persistence operations. `snapshot` pins the injected
 * clock's now, never `Date.now()`; `train` applies the asymmetric rule — a
 * hit gains five percent of the remaining headroom, a miss halves — to
 * matching stored edges only, ignoring unknown pairs rather than creating
 * them. Training retains at most {@link maxEvidenceEntries} newest evidence
 * entries per edge.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
    readonly upsert: (edges: ReadonlyArray<Selection.SuspectedEdge>) => Effect.Effect<void, SelectionStoreError>;
    readonly list: () => Effect.Effect<ReadonlyArray<Selection.SuspectedEdge>, SelectionStoreError>;
    readonly snapshot: () => Effect.Effect<Selection.BeliefSnapshot, SelectionStoreError>;
    readonly train: (observations: ReadonlyArray<TrainingObservation>) => Effect.Effect<void, SelectionStoreError>;
}
declare const SelectionStore_base: Context.ServiceClass<SelectionStore, "@smthrs/engine-store/SelectionStore", Service>;
/**
 * Service tag for the durable suspected-edge store.
 *
 * @category services
 * @since 0.1.0
 */
export declare class SelectionStore extends SelectionStore_base {
}
/**
 * Maximum evidence entries retained for one suspected edge. Training drops
 * the oldest entries after this bound and preserves the newest entries in
 * observation order.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const maxEvidenceEntries = 128;
/**
 * Builds the SQL-backed suspected-edge store.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: Effect.Effect<Service, never, DurableWriter | SqlClient.SqlClient>;
/**
 * Provides the SQL-backed suspected-edge store.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: Layer.Layer<SelectionStore, never, DurableWriter | SqlClient.SqlClient>;
export {};
