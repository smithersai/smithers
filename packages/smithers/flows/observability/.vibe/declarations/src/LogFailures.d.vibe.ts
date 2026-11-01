/**
 * Counts what went wrong from the log: every line at `Warn` or above, by its
 * record, its code and its area, and keeps the latest of them.
 *
 * A program that logs each failure once, by a stable record name and a code,
 * gets its failures counted without a counter at every call site: install
 * {@link layer} beside the program's exporter and each `Effect.logWarning`,
 * `Effect.logError` or `Effect.logFatal` adds one to {@link failures}. The
 * latest lines stay in memory for a report through {@link Recent}.
 *
 * Nothing it keeps can carry what someone wrote: a record is the line's
 * message only when the program names it (`records`), a code is an
 * annotation's identifier or a failure's tag or name, never a message, and
 * every value set is capped, so a careless line costs `other`, never a new
 * series.
 *
 * @since 1.0.0-rc.17
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
/**
 * What {@link layer} counts and keeps.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Options {
    /**
     * The record names a line keeps as its `record`: its message, when it is
     * one of these. Any other line counts as `other`. Omitted, a message of up
     * to 96 letters, digits, spaces and `_ . : ' / @ -` is kept, up to
     * {@link maxRecords} distinct ones.
     */
    readonly records?: Iterable<string> | undefined;
    /**
     * The annotations read for a line's code, first present first. Defaults to
     * {@link defaultCodeFields}. Without one, the code is the tag or name of
     * the first failure or defect in the line's cause, else `none`.
     */
    readonly codes?: ReadonlyArray<string> | undefined;
    /** The annotation naming a line's area. Defaults to `feature`; absent, `none`. */
    readonly area?: string | undefined;
    /** How many of the latest lines {@link Recent} keeps. Defaults to 50. */
    readonly keep?: number | undefined;
}
/**
 * One line {@link Recent} kept: when, how bad, its record, code and area, and
 * the span it was logged in, if any.
 *
 * @category models
 * @since 1.0.0-rc.17
 */
export interface Entry {
    /** Epoch milliseconds, from the program's clock. */
    readonly at: number;
    readonly level: "warn" | "error" | "fatal";
    readonly record: string;
    readonly code: string;
    readonly area: string;
    readonly traceId?: string;
    readonly spanId?: string;
}
declare const Recent_base: Context.ServiceClass<Recent, "@smthrs/observability/LogFailures/Recent", {
    readonly entries: Effect.Effect<ReadonlyArray<Entry>>;
}>;
/**
 * The latest lines at `Warn` or above, oldest first, from the {@link layer}
 * that provides it.
 *
 * @category services
 * @since 1.0.0-rc.17
 */
export declare class Recent extends Recent_base {
}
/**
 * Lines logged at `Warn` or above, by `level` (`warn`, `error`, `fatal`),
 * `record`, `code` and `area`.
 *
 * @category metrics
 * @since 1.0.0-rc.17
 */
export declare const failures: Metric.Counter<number>;
/**
 * The annotations read for a line's code when {@link Options.codes} is
 * omitted, first present first.
 *
 * @category constants
 * @since 1.0.0-rc.17
 */
export declare const defaultCodeFields: ReadonlyArray<string>;
/**
 * Distinct records kept when {@link Options.records} is omitted; past it a
 * new one reads `other`.
 *
 * @category limits
 * @since 1.0.0-rc.17
 */
export declare const maxRecords = 200;
/**
 * Distinct codes kept; past it a new one reads `other`.
 *
 * @category limits
 * @since 1.0.0-rc.17
 */
export declare const maxCodes = 200;
/**
 * Distinct areas kept; past it a new one reads `other`.
 *
 * @category limits
 * @since 1.0.0-rc.17
 */
export declare const maxAreas = 50;
/**
 * Installs the counting logger beside the program's other loggers and
 * provides {@link Recent}. Each line at `Warn` or above adds one to
 * {@link failures} and becomes the newest {@link Entry}.
 *
 * Provide it above the layer that installs the exporter, so the logger set it
 * extends already holds the exporter's logger.
 *
 * @category layers
 * @since 1.0.0-rc.17
 */
export declare const layer: (options?: Options) => Layer.Layer<Recent>;
export {};
