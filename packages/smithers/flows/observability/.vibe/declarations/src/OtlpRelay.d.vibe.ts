/**
 * Receives OTLP/HTTP JSON exports and re-emits every record as a structured
 * Effect log line.
 *
 * `Otlp.layerFetch` is the sending half: a browser posts its logs, spans and
 * metric snapshots as OTLP JSON. {@link serve} is the receiving half, an
 * `effect/http` handler a server mounts below its own route, for example a
 * Cloudflare Worker at `/api/telemetry`. Each log record, span and metric data
 * point becomes one `Effect.log` line on the server's own loggers, so the
 * host's log store holds browser and server telemetry side by side, joined by
 * trace id and by whatever attributes the browser annotated.
 *
 * The module imports `effect` and the journal's redaction rules
 * (`@smthrs/journal`), and no `node:` built-in or OpenTelemetry SDK.
 *
 * @since 1.0.0-rc.16
 */
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type * as LogLevel from "effect/LogLevel";
/**
 * The largest request body {@link serve} reads when
 * {@link Options.maxBodyBytes} is omitted: 256 KiB.
 *
 * @category limits
 * @since 1.0.0-rc.16
 */
export declare const defaultMaxBodyBytes: number;
/**
 * The most records one request relays when {@link Options.maxRecords} is
 * omitted. It matches the exporter's 1,000-record batch.
 *
 * @category limits
 * @since 1.0.0-rc.16
 */
export declare const defaultMaxRecords = 1000;
/**
 * The records and fields a host relays, each named exactly.
 *
 * @category models
 * @since 1.0.0-rc.16
 */
export interface Allowlist {
    /**
     * The record names relayed: a log record's body when it is a string, a
     * span's name, a metric's name. Every other record is dropped and counted.
     */
    readonly records: ReadonlyArray<string>;
    /**
     * The field keys a relayed line keeps, the relay's own included
     * (`otlp.signal`, `service.name`, `trace_id`, `otlp.status_message` and the
     * rest). Nested attribute keys are dotted, as in `user.id`. Every other field
     * is removed.
     */
    readonly fields: ReadonlyArray<string>;
}
/**
 * Limits and the allowlist for {@link serve}.
 *
 * @category models
 * @since 1.0.0-rc.16
 */
export interface Options {
    /** Body bytes read before answering 413, counted as the body streams. Defaults to {@link defaultMaxBodyBytes}. */
    readonly maxBodyBytes?: number | undefined;
    /** Records relayed per request; the rest are dropped and counted. Defaults to {@link defaultMaxRecords}. */
    readonly maxRecords?: number | undefined;
    /**
     * Relays only the records and fields it names. Omitted, every record is
     * relayed with every field. Either way, a key `Redaction.isSensitiveKey`
     * names a credential is removed with its value and any keys nested under it.
     */
    readonly allow?: Allowlist | undefined;
}
/**
 * The OTLP signal a request carries, named by its path's last segment.
 *
 * @category models
 * @since 1.0.0-rc.16
 */
export type Signal = "logs" | "traces" | "metrics";
/**
 * Maps an OTLP severity to an Effect log level. `severityNumber` decides when
 * it is set: 1-4 Trace, 5-8 Debug, 9-12 Info, 13-16 Warn, 17-20 Error, 21-24
 * Fatal. Otherwise `severityText` decides by its leading word, and a record
 * with neither logs at Info.
 *
 * @category severity
 * @since 1.0.0-rc.16
 */
export declare const severityLevel: (severityNumber: number | undefined, severityText: string | undefined) => LogLevel.Severity;
/**
 * The deepest `{` and `[` nesting a body may reach. OTLP JSON from an exporter
 * nests about a dozen levels; the bound keeps a hostile body from exhausting
 * the stack in the recursive value decoder.
 *
 * @category limits
 * @since 1.0.0-rc.16
 */
export declare const maxNesting = 64;
/**
 * An `effect/http` handler that relays OTLP/HTTP JSON exports into the
 * server's own loggers.
 *
 * It answers POST `<base>/v1/logs`, `<base>/v1/traces` and `<base>/v1/metrics`
 * for any base path, so it mounts below whatever route the host chooses. Each
 * log record, span and metric data point becomes one `Effect.log` line whose
 * message is the record's body, span name or metric name, at the level its
 * severity maps to ({@link severityLevel}; an errored span logs at `Error`,
 * everything else at `Info`).
 *
 * Every line carries `otlp.signal` and the resource's `service.name`, the
 * record's attributes flattened with dotted keys, and as they apply
 * `otlp.severity`, `trace_id`, `span_id`, `otlp.parent_span_id`,
 * `otlp.duration_ms`, `otlp.status_message`, `otlp.metric_type`, `otlp.unit`,
 * `otlp.value`, `otlp.count` and `otlp.sum`. A key `Redaction.isSensitiveKey`
 * names a credential is removed. With {@link Options.allow}, a record whose
 * name is not listed is dropped and a field whose key is not listed is
 * removed. The finished line, its message and every field the relay added
 * included, then passes `Redaction.redact`.
 *
 * It answers 200 with `{}`, or with an OTLP `partialSuccess` counting the
 * records off the allowlist or over {@link Options.maxRecords}; 413 past
 * {@link Options.maxBodyBytes}; 400 for a body that is not OTLP JSON or nests
 * deeper than {@link maxNesting}; 405 for
 * another method; 404 for another path. It never fails and never echoes a
 * parse error. `flows_observability_otlp_relayed` counts records by `signal`,
 * and `flows_observability_otlp_relay_dropped` by `signal` and `reason`
 * (`not_allowed` or `over_limit`).
 *
 * **Example**
 *
 * ```ts
 * import { OtlpRelay } from "@smthrs/observability"
 *
 * const telemetry = OtlpRelay.serve({
 *   allow: {
 *     records: ["chat ready", "chat.ask"],
 *     fields: ["otlp.signal", "service.name", "trace_id", "span_id", "answerId"]
 *   }
 * })
 * // In a fetch handler: if the path starts with /api/telemetry/, return telemetry.
 * ```
 *
 * @category handlers
 * @since 1.0.0-rc.16
 */
export declare const serve: (options?: Options) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest>;
