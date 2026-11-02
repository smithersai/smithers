/**
 * Node-only OTLP/HTTP OpenTelemetry setup.
 *
 * @since 0.1.0
 */
import type * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as Endpoint from "./Endpoint.vibe";
import * as Resource from "../../../src/Resource.ts";
import type { Configuration as ResourceConfiguration } from "../../../src/Resource.ts";
/**
 * Node OTLP/HTTP layer options.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
    /**
     * The collector base URL. It must be an absolute `http:` or `https:` URL
     * without credentials and free of spaces and control characters; anything
     * else fails layer acquisition with
     * {@link Endpoint.InvalidExporterEndpoint}.
     */
    readonly endpoint: string;
    readonly resource: ResourceConfiguration;
    readonly shutdownTimeout?: Duration.Input | undefined;
    readonly exportIntervalMillis?: number | undefined;
}
/**
 * Builds a scoped Node OTLP/HTTP layer for all three telemetry signals.
 * Exporter objects are created only when this layer is built.
 * Resource metadata is explicit: ambient OTEL resource configuration cannot
 * enlarge it after validation. The OpenTelemetry exporters still read the
 * standard `OTEL_EXPORTER_OTLP_*` transport variables (headers, timeout,
 * compression, TLS files) from the process environment and send them to the
 * explicit endpoint, which always wins over `OTEL_EXPORTER_OTLP_ENDPOINT`.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerOtel: (options: Options) => Layer.Layer<never, Resource.InvalidResourceConfiguration | Endpoint.InvalidExporterEndpoint>;
