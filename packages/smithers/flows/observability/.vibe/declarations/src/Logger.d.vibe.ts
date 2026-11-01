/**
 * Effect logger layers used by flows.
 *
 * @since 0.1.0
 */
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import type * as LogLevel from "effect/LogLevel";
/**
 * Options shared by the built-in logger layers.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
    /**
     * Pins `References.MinimumLogLevel` for the whole application. Omitted, the
     * layer leaves that reference alone and Effect's own `Info` default applies.
     */
    readonly minimumLogLevel?: LogLevel.LogLevel | undefined;
    /**
     * Keeps the ambient loggers alongside this one. Defaults to `false`, which
     * replaces the ambient logger set, matching Effect's own `Logger.layer`.
     */
    readonly mergeWithExisting?: boolean | undefined;
}
/**
 * Provides a human-readable development logger.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerPrettyDev: (options?: Options) => Layer.Layer<never>;
/**
 * Effect's structured record of a log line (`Logger.formatStructured`), with
 * the current span's `trace_id` and `span_id` among its annotations when the
 * line is logged inside a span. They are the names `OtlpRelay` gives a relayed
 * record's ids, so a service's own lines and the browser records it relays
 * join on the trace. An annotation the caller set under either name wins.
 *
 * @category loggers
 * @since 1.0.0
 */
export declare const formatStructured: Logger.Logger<unknown, {
    readonly level: string;
    readonly fiberId: string;
    readonly timestamp: string;
    readonly message: unknown;
    readonly cause: string | undefined;
    readonly annotations: Record<string, unknown>;
    readonly spans: Record<string, number>;
}>;
/**
 * Provides one structured JSON object per log line: {@link formatStructured},
 * with the current span's ids, written to the console.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerStructuredJson: (options?: Options) => Layer.Layer<never>;
/**
 * Removes the active logger set and pins the minimum level to `None` unless
 * `options.minimumLogLevel` explicitly selects another level.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerNoop: (options?: Pick<Options, "minimumLogLevel">) => Layer.Layer<never>;
/**
 * A logger layer that can be composed without requiring a runtime service.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layer: (logger: Logger.Logger<unknown, unknown>, options?: Options) => Layer.Layer<never>;
