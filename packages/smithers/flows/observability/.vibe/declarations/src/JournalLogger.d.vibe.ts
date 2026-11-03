/**
 * Non-blocking forwarding of bounded operational logs to the durable journal.
 *
 * @since 0.1.0
 */
import { Journal, JournalEvent, TelemetryLog as Telemetry } from "@smthrs/journal";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import type * as LogLevel from "effect/LogLevel";
import * as Schema from "effect/Schema";
/**
 * Largest queue accepted by the forwarding logger.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const maximumCapacity = 65536;
/**
 * Largest detached log payload admitted to the asynchronous queue.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const maximumSnapshotBytes: number;
/**
 * Largest number of container members copied into one detached log payload.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const maximumSnapshotMembers = 4096;
/**
 * Deepest container path copied into one detached log payload.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const maximumSnapshotDepth = 64;
/**
 * What a hostile or unreadable logged value becomes.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const unrenderableMarker = "[Unrenderable]";
/**
 * What a value beyond a logger resource ceiling becomes.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const truncatedMarker = "[Truncated]";
/**
 * Options for the journal forwarding logger.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Options {
    /** The run every forwarded record is attributed to. */
    readonly runId: JournalEvent.RunId;
    /** Queue depth, 1 through {@link maximumCapacity}. Defaults to 256. */
    readonly capacity?: number | undefined;
    /**
     * Pins `References.MinimumLogLevel` for the whole application. Omitted, the
     * layer leaves that reference alone and Effect's own `Info` default applies.
     */
    readonly minimumLogLevel?: LogLevel.LogLevel | undefined;
    /**
     * Keeps the ambient loggers alongside the forwarder. Defaults to `false`,
     * which replaces the ambient logger set.
     */
    readonly mergeWithExisting?: boolean | undefined;
}
declare const InvalidJournalLoggerOptions_base: Schema.Class<InvalidJournalLoggerOptions, Schema.TaggedStruct<"@smthrs/observability/InvalidJournalLoggerOptions", {
    readonly code: Schema.Literal<"invalid_journal_logger_options">;
    readonly path: Schema.String;
    readonly message: Schema.String;
}>, Cause.YieldableError>;
/**
 * A stable logger configuration refusal.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export declare class InvalidJournalLoggerOptions extends InvalidJournalLoggerOptions_base {
}
/**
 * One typed failure retained from an Effect cause. The same schema as
 * `@smthrs/journal`'s `Telemetry.Fail`.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const TelemetryFail: Schema.Struct<{
    readonly _tag: Schema.Literal<"Fail">;
    readonly error: Schema.Unknown;
}>;
/**
 * One unexpected defect retained from an Effect cause. The same schema as
 * `@smthrs/journal`'s `Telemetry.Die`.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const TelemetryDie: Schema.Struct<{
    readonly _tag: Schema.Literal<"Die">;
    readonly defect: Schema.Unknown;
}>;
/**
 * One interruption retained from an Effect cause. The same schema as
 * `@smthrs/journal`'s `Telemetry.Interrupt`.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const TelemetryInterrupt: Schema.Struct<{
    readonly _tag: Schema.Literal<"Interrupt">;
    readonly fiberId: Schema.NullOr<Schema.Int>;
}>;
/**
 * One reason in a persisted telemetry cause. The same schema as
 * `@smthrs/journal`'s `Telemetry.CauseReason`.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const TelemetryCauseReason: Schema.Union<readonly [Schema.Struct<{
    readonly _tag: Schema.Literal<"Fail">;
    readonly error: Schema.Unknown;
}>, Schema.Struct<{
    readonly _tag: Schema.Literal<"Die">;
    readonly defect: Schema.Unknown;
}>, Schema.Struct<{
    readonly _tag: Schema.Literal<"Interrupt">;
    readonly fiberId: Schema.NullOr<Schema.Int>;
}>]>;
/**
 * One reason in a persisted telemetry cause.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type TelemetryCauseReason = Telemetry.CauseReason;
/**
 * A versioned structural Effect cause. The same schema as `@smthrs/journal`'s
 * `Telemetry.LogCause`.
 *
 * Effect 4 stores composed failures as an ordered reason list. The projection
 * preserves that order and each fail, defect, or interrupt discriminator.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const TelemetryCause: Schema.Struct<{
    readonly version: Schema.Literal<1>;
    readonly reasons: Schema.$Array<Schema.Union<readonly [Schema.Struct<{
        readonly _tag: Schema.Literal<"Fail">;
        readonly error: Schema.Unknown;
    }>, Schema.Struct<{
        readonly _tag: Schema.Literal<"Die">;
        readonly defect: Schema.Unknown;
    }>, Schema.Struct<{
        readonly _tag: Schema.Literal<"Interrupt">;
        readonly fiberId: Schema.NullOr<Schema.Int>;
    }>]>>;
}>;
/**
 * A versioned structural Effect cause.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type TelemetryCause = Telemetry.LogCause;
/**
 * Runtime schema for the operational log payload written to the journal. The
 * same schema as `@smthrs/journal`'s `TelemetryLog.Log`, which also builds it.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export declare const TelemetryLog: Schema.Struct<{
    readonly version: Schema.Literal<1>;
    readonly level: Schema.Literals<readonly ["All", "Fatal", "Error", "Warn", "Info", "Debug", "Trace", "None"]>;
    readonly message: Schema.Unknown;
    readonly annotations: Schema.$Record<Schema.String, Schema.Unknown>;
    readonly cause: Schema.Struct<{
        readonly version: Schema.Literal<1>;
        readonly reasons: Schema.$Array<Schema.Union<readonly [Schema.Struct<{
            readonly _tag: Schema.Literal<"Fail">;
            readonly error: Schema.Unknown;
        }>, Schema.Struct<{
            readonly _tag: Schema.Literal<"Die">;
            readonly defect: Schema.Unknown;
        }>, Schema.Struct<{
            readonly _tag: Schema.Literal<"Interrupt">;
            readonly fiberId: Schema.NullOr<Schema.Int>;
        }>]>>;
    }>;
    readonly fiberId: Schema.Int;
    readonly traceId: Schema.optionalKey<Schema.String>;
    readonly spanId: Schema.optionalKey<Schema.String>;
    readonly timestamp: Schema.String;
}>;
/**
 * Versioned operational log payload written to the journal.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type TelemetryLog = Telemetry.Log;
/**
 * Installs a bounded, drop-on-overflow logger forwarder for one explicit run.
 *
 * Configuration is decoded before a worker starts. The callback reads the
 * queue's remaining room first, snapshots and redacts a bounded DTO
 * synchronously only when a slot is free, then performs only non-blocking
 * queue admission. A record a saturated queue cannot take is counted and
 * discarded without being snapshotted. Queue overflow, journal `Dropped` receipts, delivery failures,
 * and journal defects each advance `Metric.droppedLogRecords`. The two failure
 * paths also warn through the ambient loggers with a fixed code and run id,
 * and the worker keeps draining. `Accepted` and `Duplicate` do not advance the
 * counter. Admission receipts cannot identify later drop-oldest evictions of
 * these records or report asynchronous persistence failures or shutdown losses.
 * Closing the scope interrupts the worker and may drop records still queued
 * behind an in-flight write without advancing the counter.
 *
 * The layer replaces the ambient logger set unless `mergeWithExisting` is
 * `true`, and provides `MinimumLogLevel` only when `minimumLogLevel` is given,
 * so an application that set that reference elsewhere keeps it.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export declare const layerJournalForwarding: (options: Options) => Layer.Layer<never, InvalidJournalLoggerOptions, Journal.Journal>;
export {};
