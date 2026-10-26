/**
 * Observability for flows: the default OTLP export wiring plus the
 * Effect-native logger, metric, and OpenTelemetry resource layers.
 *
 * The store packages define and update their own metric handles
 * (`JournalMetrics`, `RunStoreMetrics`, `CacheStoreMetrics`,
 * `ArtifactStoreMetrics`, `DatabaseMetrics`) and open spans through Effect's
 * tracer; this package is the exporter they deliberately leave out. `Otlp`
 * composes what `effect` already ships with the journal's redaction rules, so
 * it is browser-bundleable. The
 * remaining modules are the fuller stack folded in from the agent workspace:
 * a structured `Logger`, a `JournalLogger` that mirrors log events into the
 * run journal, `Metric` helpers, the `Resource` descriptor, and the `Otel`
 * layer the OpenTelemetry SDK wiring installs behind.
 *
 * `NodeOtel` and `BrowserOtel` are deliberately NOT re-exported here. Each
 * resolves a host-specific OpenTelemetry SDK. `NodeOtel` reaches Node-only
 * host modules through `@effect/opentelemetry/NodeSdk` and
 * `@opentelemetry/sdk-trace-node`, including the bare `async_hooks` specifier
 * `@opentelemetry/context-async-hooks` imports, so re-exporting it would put a
 * module a browser bundler cannot resolve in the root entry and break the
 * browser bundle this package guarantees. Import them by subpath instead:
 * `@smthrs/observability/NodeOtel`.
 *
 * @since 0.1.0
 */

/**
 * @category layers
 * @since 0.1.0
 */
export * as Otlp from "./Otlp.ts"

/**
 * @category handlers
 * @since 1.0.0-rc.16
 */
export * as OtlpRelay from "./OtlpRelay.ts"

/**
 * @category observability
 * @since 1.0.0-rc.0
 */
export * as Endpoint from "./Endpoint.ts"

/**
 * @category observability
 * @since 1.0.0-rc.17
 */
export * as FetchFailures from "./FetchFailures.ts"

/**
 * @category observability
 * @since 0.1.0
 */
export * as JournalLogger from "./JournalLogger.ts"

/**
 * @category observability
 * @since 1.0.0-rc.17
 */
export * as LogFailures from "./LogFailures.ts"

/**
 * @category observability
 * @since 0.1.0
 */
export * as Logger from "./Logger.ts"

/**
 * @category observability
 * @since 0.1.0
 */
export * as Metric from "./Metric.ts"

/**
 * @category observability
 * @since 0.1.0
 */
export * as Otel from "./Otel.ts"

/**
 * @category observability
 * @since 0.1.0
 */
export * as Resource from "./Resource.ts"
