/**
 * Native execution observations, independent of operational ownership leases.
 * @since 1.0.0
 */
import * as Schema from "effect/Schema";
/** Native semantic lifecycle fields recorded by the owning writer.
 * @category schemas
 * @since 1.0.0
 */
export declare const Observation: Schema.Struct<{
    readonly executionId: Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">;
    readonly flowName: Schema.NonEmptyString;
    readonly status: Schema.Literals<readonly ["pending", "running", "suspended", "completed", "failed", "cancelled"]>;
    readonly createdAtMs: Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">;
    readonly startedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
    readonly finishedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
    readonly parentRunId: Schema.NullOr<Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">>;
    readonly lineageId: Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">;
    readonly roundOrdinal: Schema.Int;
    readonly cancelRequestedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
    readonly treeVersion: Schema.optional<Schema.Literal<1>>;
    readonly parentPolicy: Schema.optional<Schema.Literals<readonly ["cancel", "detach"]>>;
    readonly waiting: Schema.NullOr<Schema.Struct<{
        readonly reason: Schema.NonEmptyString;
        readonly wakeAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
        readonly tokenDigest: Schema.NullOr<Schema.NonEmptyString>;
        readonly point: Schema.optional<Schema.NullOr<Schema.String>>;
        readonly request: Schema.optional<Schema.NullOr<Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
    }>>;
}>;
/** The value form of a native execution observation.
 * @category models
 * @since 1.0.0
 */
export type Observation = typeof Observation.Type;
/** A new observation baseline never invents the preceding history.
 * @category schemas
 * @since 1.0.0
 */
export declare const Fact: Schema.Struct<{
    readonly version: Schema.Literal<1>;
    readonly baseline: Schema.Literals<readonly ["created", "legacy"]>;
    readonly observation: Schema.Struct<{
        readonly executionId: Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">;
        readonly flowName: Schema.NonEmptyString;
        readonly status: Schema.Literals<readonly ["pending", "running", "suspended", "completed", "failed", "cancelled"]>;
        readonly createdAtMs: Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">;
        readonly startedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
        readonly finishedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
        readonly parentRunId: Schema.NullOr<Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">>;
        readonly lineageId: Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">;
        readonly roundOrdinal: Schema.Int;
        readonly cancelRequestedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
        readonly treeVersion: Schema.optional<Schema.Literal<1>>;
        readonly parentPolicy: Schema.optional<Schema.Literals<readonly ["cancel", "detach"]>>;
        readonly waiting: Schema.NullOr<Schema.Struct<{
            readonly reason: Schema.NonEmptyString;
            readonly wakeAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
            readonly tokenDigest: Schema.NullOr<Schema.NonEmptyString>;
            readonly point: Schema.optional<Schema.NullOr<Schema.String>>;
            readonly request: Schema.optional<Schema.NullOr<Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
        }>>;
    }>;
}>;
/** A corrupt/legacy row can still settle, but cannot establish a replay baseline.
 * @category schemas
 * @since 1.0.0
 */
export declare const UnavailableFact: Schema.Struct<{
    readonly version: Schema.Literal<1>;
    readonly unavailable: Schema.Literal<"invalid-observation">;
}>;
/** Root identity stays fixed while lifecycle follows its latest trampoline round.
 * @category schemas
 * @since 1.0.0
 */
export declare const View: Schema.Struct<{
    readonly root: Schema.Struct<{
        readonly executionId: Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">;
        readonly flowName: Schema.NonEmptyString;
        readonly status: Schema.Literals<readonly ["pending", "running", "suspended", "completed", "failed", "cancelled"]>;
        readonly createdAtMs: Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">;
        readonly startedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
        readonly finishedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
        readonly parentRunId: Schema.NullOr<Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">>;
        readonly lineageId: Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">;
        readonly roundOrdinal: Schema.Int;
        readonly cancelRequestedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
        readonly treeVersion: Schema.optional<Schema.Literal<1>>;
        readonly parentPolicy: Schema.optional<Schema.Literals<readonly ["cancel", "detach"]>>;
        readonly waiting: Schema.NullOr<Schema.Struct<{
            readonly reason: Schema.NonEmptyString;
            readonly wakeAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
            readonly tokenDigest: Schema.NullOr<Schema.NonEmptyString>;
            readonly point: Schema.optional<Schema.NullOr<Schema.String>>;
            readonly request: Schema.optional<Schema.NullOr<Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
        }>>;
    }>;
    readonly current: Schema.Struct<{
        readonly executionId: Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">;
        readonly flowName: Schema.NonEmptyString;
        readonly status: Schema.Literals<readonly ["pending", "running", "suspended", "completed", "failed", "cancelled"]>;
        readonly createdAtMs: Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">;
        readonly startedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
        readonly finishedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
        readonly parentRunId: Schema.NullOr<Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">>;
        readonly lineageId: Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">;
        readonly roundOrdinal: Schema.Int;
        readonly cancelRequestedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
        readonly treeVersion: Schema.optional<Schema.Literal<1>>;
        readonly parentPolicy: Schema.optional<Schema.Literals<readonly ["cancel", "detach"]>>;
        readonly waiting: Schema.NullOr<Schema.Struct<{
            readonly reason: Schema.NonEmptyString;
            readonly wakeAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
            readonly tokenDigest: Schema.NullOr<Schema.NonEmptyString>;
            readonly point: Schema.optional<Schema.NullOr<Schema.String>>;
            readonly request: Schema.optional<Schema.NullOr<Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
        }>>;
    }>;
    /** Redacted display observations; opaque wake tokens are never journal authority. */
    readonly humanWaits: Schema.optional<Schema.$Array<Schema.Struct<{
        readonly executionId: Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">;
        readonly flowName: Schema.NonEmptyString;
        readonly status: Schema.Literals<readonly ["pending", "running", "suspended", "completed", "failed", "cancelled"]>;
        readonly createdAtMs: Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">;
        readonly startedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
        readonly finishedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
        readonly parentRunId: Schema.NullOr<Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">>;
        readonly lineageId: Schema.brand<Schema.String, "@smthrs/journal/JournalEvent/RunId">;
        readonly roundOrdinal: Schema.Int;
        readonly cancelRequestedAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
        readonly treeVersion: Schema.optional<Schema.Literal<1>>;
        readonly parentPolicy: Schema.optional<Schema.Literals<readonly ["cancel", "detach"]>>;
        readonly waiting: Schema.NullOr<Schema.Struct<{
            readonly reason: Schema.NonEmptyString;
            readonly wakeAtMs: Schema.NullOr<Schema.brand<Schema.Int, "@smthrs/journal/TimestampMs">>;
            readonly tokenDigest: Schema.NullOr<Schema.NonEmptyString>;
            readonly point: Schema.optional<Schema.NullOr<Schema.String>>;
            readonly request: Schema.optional<Schema.NullOr<Schema.Codec<Schema.Json, Schema.Json, never, never>>>;
        }>>;
    }>>>;
}>;
/** The value form of a logical execution view.
 * @category models
 * @since 1.0.0
 */
export type View = typeof View.Type;
/** Source positions are native run-local sequence plus native journal generation.
 * @category models
 * @since 1.0.0
 */
export interface Input {
    readonly executionId: string;
    readonly generation: number | null;
    readonly sequence: number;
    readonly eventType: string;
    readonly payload: unknown;
    readonly gap?: boolean;
}
/** Honest replay coverage of the selected native root and current round.
 * @category schemas
 * @since 1.0.0
 */
export declare const Provenance: Schema.Struct<{
    readonly source: Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>;
    readonly rootExecutionId: Schema.String;
    readonly humanWaits: Schema.optional<Schema.Literals<readonly ["events", "legacy-observation", "unverified-observation"]>>;
    /** Tree coverage starts independently in every native run-local stream. */
    readonly humanWaitSources: Schema.optional<Schema.$Array<Schema.Struct<{
        readonly executionId: Schema.String;
        readonly generation: Schema.Number;
        readonly baseline: Schema.Literals<readonly ["created", "legacy"]>;
        readonly fromSequence: Schema.Number;
        readonly throughSequence: Schema.Number;
    }>>>;
    readonly currentExecutionId: Schema.optional<Schema.String>;
    readonly generation: Schema.optional<Schema.Number>;
    readonly baseline: Schema.optional<Schema.Literals<readonly ["created", "legacy"]>>;
    readonly fromSequence: Schema.optional<Schema.Number>;
    readonly throughSequence: Schema.optional<Schema.Number>;
}>;
/** Compare semantic state only; heartbeat and owner incarnation are operational.
 * @category projections
 * @since 1.0.0
 */
export declare const equal: (left: Observation, right: Observation) => boolean;
/**
 * Fold native facts after a separately authenticated root binding. Sequence gaps
 * alone are not loss: SQL journal rollbacks leave unused sequence reservations.
 * A real omission/generation boundary invalidates coverage until a new complete
 * baseline is recorded. Unknown producer versions never become successful replay.
 * @category projections
 * @since 1.0.0
 */
export declare const fold: (inputs: ReadonlyArray<Input>, rootExecutionId: string, observed?: View) => {
    readonly view: View | undefined;
    readonly provenance: typeof Provenance.Type;
};
/** Control bridge inputs retain their native run-local positions and generation.
 * @category models
 * @since 1.0.0
 */
export interface BridgeEvent {
    readonly runId?: string | undefined;
    readonly kind: string;
    readonly payload: unknown;
}
/** Interpret only the host's explicit root binding, never an ID naming convention.
 * @category projections
 * @since 1.0.0
 */
export declare const foldControl: (events: ReadonlyArray<BridgeEvent>, controlRunId: string, observed?: View) => {
    readonly view: View | undefined;
    readonly provenance: typeof Provenance.Type;
} | undefined;
