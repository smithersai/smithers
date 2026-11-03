/**
 * Durable storage for individual step attempts.
 *
 * Attempt metadata is deliberately opaque to this module. Its shape belongs to
 * the step executor, and is persisted unchanged across attempt state changes.
 *
 * The running-state and owner fences mean stale attempts and repeated terminal
 * transitions never overwrite the winning row.
 *
 * @since 0.1.0
 */
import { DurableWriter } from "@smthrs/database/DurableWriter";
import type { OwnerId } from "@smthrs/journal/OwnerId";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Absolute ceiling for {@link Options.maxCheckpointBytes}.
 *
 * This bounds only the configured checkpoint policy; metadata, errors, and
 * outcomes have no byte ceiling.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const maximumCheckpointBytes: number;
/**
 * Maximum nesting admitted for durable attempt JSON.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const maximumJsonDepth = 128;
/**
 * Maximum values and members admitted for durable attempt JSON.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const maximumJsonNodes = 100000;
/**
 * Strict JSON value accepted as executable attempt state.
 *
 * The store still takes an inert snapshot at effect start; this schema is the
 * public declaration contract shared by `Attempt`, `FinishAttempt`, and
 * `AttemptPatch`.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const JsonValue: Schema.declare<import("@smthrs/canonical/BoundedJson").Json, import("@smthrs/canonical/BoundedJson").Json>;
/**
 * Strict JSON value accepted as executable attempt state.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type JsonValue = typeof JsonValue.Type;
/**
 * Stable error codes returned by attempt persistence operations.
 *
 * @category models
 * @since 0.1.0
 */
export declare const AttemptStoreErrorCode: Schema.Literals<readonly ["invalid_attempt", "constraint", "decode_failed", "persistence_failed", "unknown"]>;
/**
 * Stable error codes returned by attempt persistence operations.
 *
 * @category models
 * @since 0.1.0
 */
export type AttemptStoreErrorCode = typeof AttemptStoreErrorCode.Type;
declare const AttemptStoreError_base: Schema.Class<AttemptStoreError, Schema.TaggedStruct<"@smthrs/run-store/AttemptStoreError", {
    readonly code: Schema.Literals<readonly ["invalid_attempt", "constraint", "decode_failed", "persistence_failed", "unknown"]>;
    readonly method: Schema.String;
    readonly message: Schema.String;
    readonly cause: Schema.optional<Schema.Unknown>;
}>, import("effect/Cause").YieldableError>;
/**
 * Error raised by attempt persistence operations.
 *
 * The identity string equals the defining module path, which is how every
 * tagged identity in this package is named.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class AttemptStoreError extends AttemptStoreError_base {
}
/**
 * Identifies one execution of a content-addressed step within a run.
 *
 * @category models
 * @since 0.1.0
 */
export declare const AttemptId: Schema.Struct<{
    readonly runId: Schema.NonEmptyString;
    readonly stepKeyDigest: Schema.NonEmptyString;
    readonly attempt: Schema.Int;
}>;
/**
 * Identifies one execution of a content-addressed step within a run.
 *
 * @category models
 * @since 0.1.0
 */
export type AttemptId = typeof AttemptId.Type;
/**
 * A durable attempt row.
 *
 * @category models
 * @since 0.1.0
 */
export declare const Attempt: Schema.Struct<{
    readonly runId: Schema.NonEmptyString;
    readonly stepKeyDigest: Schema.NonEmptyString;
    readonly attempt: Schema.Int;
    readonly state: Schema.NonEmptyString;
    readonly startedAtMs: Schema.Int;
    readonly finishedAtMs: Schema.optionalKey<Schema.Int>;
    readonly heartbeatAtMs: Schema.optionalKey<Schema.Int>;
    readonly checkpoint: Schema.optionalKey<Schema.declare<import("@smthrs/canonical/BoundedJson").Json, import("@smthrs/canonical/BoundedJson").Json>>;
    readonly error: Schema.optionalKey<Schema.declare<import("@smthrs/canonical/BoundedJson").Json, import("@smthrs/canonical/BoundedJson").Json>>;
    readonly outcome: Schema.optionalKey<Schema.declare<import("@smthrs/canonical/BoundedJson").Json, import("@smthrs/canonical/BoundedJson").Json>>;
    readonly meta: Schema.declare<import("@smthrs/canonical/BoundedJson").Json, import("@smthrs/canonical/BoundedJson").Json>;
}>;
/**
 * A durable attempt row.
 *
 * @category models
 * @since 0.1.0
 */
export type Attempt = typeof Attempt.Type;
/**
 * Input used to finish an existing attempt. `error`, `outcome`, and `meta`
 * follow the same rule as {@link AttemptPatch}: an omitted field is left as
 * recorded, so a terminal transition never erases a value written mid-flight
 * by `put` or `patch`. Supplying one replaces it atomically with the terminal
 * state, which lets an executor durably record what it discovered while
 * handling a failure.
 *
 * @category models
 * @since 0.1.0
 */
export declare const FinishAttempt: Schema.Struct<{
    readonly runId: Schema.NonEmptyString;
    readonly stepKeyDigest: Schema.NonEmptyString;
    readonly attempt: Schema.Int;
    readonly state: Schema.NonEmptyString;
    readonly finishedAtMs: Schema.Int;
    readonly error: Schema.optionalKey<Schema.declare<import("@smthrs/canonical/BoundedJson").Json, import("@smthrs/canonical/BoundedJson").Json>>;
    readonly outcome: Schema.optionalKey<Schema.declare<import("@smthrs/canonical/BoundedJson").Json, import("@smthrs/canonical/BoundedJson").Json>>;
    readonly meta: Schema.optionalKey<Schema.declare<import("@smthrs/canonical/BoundedJson").Json, import("@smthrs/canonical/BoundedJson").Json>>;
}>;
/**
 * Input used to finish an existing attempt.
 *
 * @category models
 * @since 0.1.0
 */
export type FinishAttempt = typeof FinishAttempt.Type;
/**
 * Result of starting an owner-fenced attempt.
 *
 * @category models
 * @since 0.1.0
 */
export type PutResult = {
    readonly _tag: "Inserted";
} | {
    readonly _tag: "Upserted";
} | {
    readonly _tag: "ExistingSame";
} | {
    readonly _tag: "Conflict";
} | {
    readonly _tag: "FenceLost";
} | {
    readonly _tag: "RunNotFound";
};
/**
 * Fields a patch may rewrite.
 *
 * A patch never touches `state`, `started_at_ms`, or `finished_at_ms`: those
 * are the lifecycle, and only `put`/`heartbeat`/`finish` move them. An
 * omitted field is left as recorded.
 *
 * @category models
 * @since 0.1.0
 */
export declare const AttemptPatch: Schema.Struct<{
    readonly checkpoint: Schema.optionalKey<Schema.declare<import("@smthrs/canonical/BoundedJson").Json, import("@smthrs/canonical/BoundedJson").Json>>;
    readonly error: Schema.optionalKey<Schema.declare<import("@smthrs/canonical/BoundedJson").Json, import("@smthrs/canonical/BoundedJson").Json>>;
    readonly outcome: Schema.optionalKey<Schema.declare<import("@smthrs/canonical/BoundedJson").Json, import("@smthrs/canonical/BoundedJson").Json>>;
    readonly meta: Schema.optionalKey<Schema.declare<import("@smthrs/canonical/BoundedJson").Json, import("@smthrs/canonical/BoundedJson").Json>>;
}>;
/**
 * Fields a patch may rewrite.
 *
 * @category models
 * @since 0.1.0
 */
export type AttemptPatch = typeof AttemptPatch.Type;
/**
 * Result of an owner-fenced attempt patch.
 *
 * @category models
 * @since 0.1.0
 */
export type PatchResult = {
    readonly _tag: "Patched";
} | {
    readonly _tag: "NotFound";
} | {
    readonly _tag: "FenceLost";
};
/**
 * Store-wide policy.
 *
 * Defaults treat only `running` attempts as in progress, cap checkpoints at
 * 1 MiB, and make attempt insertion first-writer-wins.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
    /**
     * States the store treats as "attempt still in progress". `heartbeat` and
     * `finish` fence on membership, and `finish` refuses them as targets.
     * Defaults to `["running"]`.
     */
    readonly inProgressStates?: ReadonlyArray<string> | undefined;
    /**
     * Largest encoded checkpoint accepted, in bytes. Defaults to 1 MiB and may
     * not exceed {@link maximumCheckpointBytes}.
     */
    readonly maxCheckpointBytes?: number | undefined;
    /**
     * `"insert"` (the default) is first-writer-wins: a re-put with different
     * content reports `Conflict`. `"upsert"` overwrites it and reports
     * `Upserted` only while the existing row is still in progress. A terminal
     * row remains immutable. Both modes keep the run-ownership fence.
     */
    readonly putMode?: "insert" | "upsert" | undefined;
}
/**
 * Result of a fenced attempt heartbeat.
 *
 * @category models
 * @since 0.1.0
 */
export type HeartbeatResult = {
    readonly _tag: "Updated";
} | {
    readonly _tag: "FenceLost";
} | {
    readonly _tag: "NotFound";
} | {
    readonly _tag: "StateChanged";
};
/**
 * Result of a fenced terminal attempt transition.
 *
 * @category models
 * @since 0.1.0
 */
export type FinishResult = {
    readonly _tag: "Finished";
} | {
    readonly _tag: "FenceLost";
} | {
    readonly _tag: "NotFound";
} | {
    readonly _tag: "StateChanged";
};
/**
 * Attempt persistence operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
    readonly put: (attempt: Attempt, owner: OwnerId) => Effect.Effect<PutResult, AttemptStoreError>;
    readonly get: (id: AttemptId) => Effect.Effect<Option.Option<Attempt>, AttemptStoreError>;
    /**
     * Every attempt row of one run, ordered by step key digest and attempt, in
     * one read: what `get` answers for each, all at once. A resumed run's
     * replay reads its recorded attempts here once rather than one `get` per
     * step it reaches.
     *
     * Optional: a store that cannot read a run's rows at once omits it, and its
     * callers read each attempt with `get`.
     */
    readonly listRun?: ((runId: string) => Effect.Effect<ReadonlyArray<Attempt>, AttemptStoreError>) | undefined;
    readonly heartbeat: (runId: string, stepKeyDigest: string, attempt: number, owner: OwnerId, nowMs: number, checkpoint?: JsonValue) => Effect.Effect<HeartbeatResult, AttemptStoreError>;
    readonly finish: (attempt: FinishAttempt, owner: OwnerId) => Effect.Effect<FinishResult, AttemptStoreError>;
    /**
     * Rewrites opaque fields without competing for the attempt lifecycle: a
     * patch never moves `state`, so executors record response text, worktree
     * pointers, or cache flags on running *and* terminal rows. It is fenced on
     * run ownership like every other write — `outcome` is replayed verbatim as
     * the attempt's result, so a delayed patch from an owner that lost the run
     * (or from any writer after the run reached a terminal status and its
     * owner columns were cleared) reports `FenceLost` instead of rewriting the
     * winning row. Prior art: Temporal conditions every persistence write on
     * the shard `rangeID` (`reference/temporal/service/history/shard/`); there
     * is no unfenced write surface.
     */
    readonly patch: (id: AttemptId, patch: AttemptPatch, owner: OwnerId) => Effect.Effect<PatchResult, AttemptStoreError>;
}
declare const AttemptStore_base: Context.ServiceClass<AttemptStore, "@smthrs/run-store/AttemptStore", Service>;
/**
 * Service tag for durable step attempts.
 *
 * The identity string equals the defining module path, which is how every
 * service in this package is named.
 *
 * @category services
 * @since 0.1.0
 */
export declare class AttemptStore extends AttemptStore_base {
}
/**
 * Builds the SQL-backed attempt store under an explicit policy.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const makeWith: (options?: Options) => Effect.Effect<Service, AttemptStoreError, DurableWriter | SqlClient.SqlClient>;
/**
 * Builds the SQL-backed attempt store with default policy.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: Effect.Effect<Service, never, DurableWriter | SqlClient.SqlClient>;
/**
 * Creates an attempt store from an implementation.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const makeNoop: (overrides?: Partial<Service>) => Service;
/**
 * Provides a no-op attempt store.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerNoop: (overrides?: Partial<Service>) => Layer.Layer<AttemptStore>;
/**
 * Provides the SQL-backed attempt store.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: Layer.Layer<AttemptStore, never, DurableWriter | SqlClient.SqlClient>;
/**
 * Provides the SQL-backed attempt store under an explicit policy.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerWith: (options: Options) => Layer.Layer<AttemptStore, AttemptStoreError, DurableWriter | SqlClient.SqlClient>;
export {};
