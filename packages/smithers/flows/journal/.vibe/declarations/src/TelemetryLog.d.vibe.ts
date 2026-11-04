/**
 * The `telemetry.log` journal record: its durable schema and the bounded,
 * redacted snapshot of an Effect log event that fills it.
 *
 * A log record is written to a run's journal on the lossy channel by two
 * producers: `@smthrs/observability`'s `JournalLogger`, which forwards a whole
 * process's logs to one run, and `@smthrs/engine-store`, which journals what an
 * action attempt's body logs to the attempt's own run. Both build the payload
 * here, so there is one schema and one snapshot. The module depends on nothing
 * but Effect and this package's redaction rules, so it loads in a browser, a
 * Worker, Node and Bun.
 *
 * The snapshot runs inside a logger callback: synchronously, on someone else's
 * fiber, with an arbitrary logged value. It is therefore total (it never
 * throws), detached (it copies the value before any asynchronous delivery, and
 * never runs a caller's getter, `toJSON` or `toISOString`), bounded (in bytes,
 * container members and depth, measured in one forward pass), and redacted
 * before it returns.
 *
 * @since 1.0.0
 */
import type * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Redaction from "../../../src/Redaction.ts";
/**
 * The journal event type every log record is written under.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const eventType = "telemetry.log";
/**
 * Largest encoded payload a snapshot produces, and the default bound.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const maximumSnapshotBytes: number;
/**
 * Largest number of container members copied into one snapshot.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const maximumSnapshotMembers = 4096;
/**
 * Deepest container path copied into one snapshot.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const maximumSnapshotDepth = 64;
/**
 * What a hostile or unreadable logged value becomes.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const unrenderableMarker = "[Unrenderable]";
/**
 * What a value beyond a snapshot ceiling becomes.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const truncatedMarker = "[Truncated]";
/**
 * What an Effect `Redacted` value becomes: the wrapper's own rendering without
 * its label, and never the value it hides.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const redactedMarker = "<redacted>";
/**
 * One typed failure retained from an Effect cause.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Fail: Schema.Struct<{
    readonly _tag: Schema.Literal<"Fail">;
    readonly error: Schema.Unknown;
}>;
/**
 * One unexpected defect retained from an Effect cause.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Die: Schema.Struct<{
    readonly _tag: Schema.Literal<"Die">;
    readonly defect: Schema.Unknown;
}>;
/**
 * One interruption retained from an Effect cause.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Interrupt: Schema.Struct<{
    readonly _tag: Schema.Literal<"Interrupt">;
    readonly fiberId: Schema.NullOr<Schema.Int>;
}>;
/**
 * One reason in a persisted log cause.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const CauseReason: Schema.Union<readonly [Schema.Struct<{
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
 * One reason in a persisted log cause.
 *
 * @category models
 * @since 1.0.0
 */
export type CauseReason = typeof CauseReason.Type;
/**
 * A versioned structural Effect cause.
 *
 * Effect 4 stores composed failures as an ordered reason list. The projection
 * preserves that order and each fail, defect, or interrupt discriminator.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const LogCause: Schema.Struct<{
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
 * @since 1.0.0
 */
export type LogCause = typeof LogCause.Type;
/**
 * Runtime schema for the log record payload written to the journal.
 *
 * `message` is what the logger was handed: Effect passes one array entry per
 * argument. `annotations` are the fiber's log annotations at the moment of the
 * call, and `timestamp` is that moment as ISO-8601 UTC.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Log: Schema.Struct<{
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
 * Versioned log record payload written to the journal.
 *
 * @category models
 * @since 1.0.0
 */
export type Log = typeof Log.Type;
/**
 * How one {@link snapshot} is bounded, attributed and redacted.
 *
 * @category models
 * @since 1.0.0
 */
export interface SnapshotOptions {
    /**
     * Largest encoded payload, in UTF-8 bytes of its JSON, capped at
     * {@link maximumSnapshotBytes}; a value that is not finite takes that cap.
     * Given, the record's envelope is reserved first, so the message, annotations
     * and cause share what remains and a long message is cut. Omitted, the values
     * share {@link maximumSnapshotBytes} and a record whose envelope pushes it
     * over degrades. A record that cannot fit either way keeps its level, time
     * and {@link SnapshotOptions.annotations} and loses its message.
     */
    readonly maximumBytes?: number | undefined;
    /**
     * Annotations copied ahead of the fiber's, winning over a fiber annotation
     * of the same name and kept by every fallback record. For attribution the
     * producer controls, such as run and step ids; never a value.
     */
    readonly annotations?: Readonly<Record<string, unknown>> | undefined;
    /**
     * The redaction rules. Defaults to `Redaction.defaultRules`, the journal's
     * write rules; a diagnostic producer passes `Redaction.diagnosticRules`.
     */
    readonly rules?: ReadonlyArray<Redaction.Rule> | undefined;
}
/**
 * Snapshots one Effect log event into a bounded, redacted, decodable
 * {@link Log}.
 *
 * Call it from inside a logger: it is synchronous and total. The returned
 * value shares nothing with the logged one, so it can be queued for a later
 * journal write. A projection that is too large or fails {@link Log} degrades
 * to a record with a {@link truncatedMarker} message, and a projection that
 * throws degrades to one with an {@link unrenderableMarker} message; both keep
 * the level, timestamp and {@link SnapshotOptions.annotations}.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const snapshot: (options: Logger.Options<unknown>, settings?: SnapshotOptions) => Log;
