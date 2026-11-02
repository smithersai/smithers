/**
 * Browser OpenTelemetry setup with explicitly injected providers/readers.
 *
 * @since 0.1.0
 */
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { MetricReader } from "@opentelemetry/sdk-metrics";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import * as Layer from "effect/Layer";
import * as Resource from "../../../src/Resource.ts";
import type { Configuration as ResourceConfiguration } from "../../../src/Resource.ts";
/**
 * Browser OTEL layer options. Processors and readers are created by the
 * caller's factories, which keeps this module free of Node imports and browser
 * exporter policy. Every factory is owned: it runs once during layer
 * acquisition, after resource validation, and the layer scope shuts down
 * everything it returned. An empty array installs nothing for that signal.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
    readonly resource: ResourceConfiguration;
    readonly spanProcessor?: (() => SpanProcessor | ReadonlyArray<SpanProcessor>) | undefined;
    readonly logRecordProcessor?: (() => LogRecordProcessor | ReadonlyArray<LogRecordProcessor>) | undefined;
    readonly metricReader?: (() => MetricReader | ReadonlyArray<MetricReader>) | undefined;
    readonly loggerMergeWithExisting?: boolean | undefined;
}
/**
 * Builds a scoped browser OpenTelemetry layer. The web SDK owns every
 * processor and reader the factories return and shuts them down on release.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerOtel: (options: Options) => Layer.Layer<never, Resource.InvalidResourceConfiguration>;
