import { MetricsService } from "./_coreMetrics.js";
import { Effect, Layer } from "effect";
import { metricsServiceAdapter } from "./metrics/index.js";
import { renderPrometheusMetrics } from "./renderPrometheusMetrics.js";
/** @type {Layer.Layer<MetricsService, never, never>} */
export const MetricsServiceLive = Layer.succeed(MetricsService, {
    ...metricsServiceAdapter,
    renderPrometheus: () => Effect.sync(renderPrometheusMetrics),
});
