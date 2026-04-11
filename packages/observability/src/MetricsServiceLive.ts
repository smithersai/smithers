import { MetricsService } from "@smithers/core/observability";
import { Effect, Layer } from "effect";
import { metricsServiceAdapter } from "./metrics";
import { renderPrometheusMetrics } from "./renderPrometheusMetrics";

export const MetricsServiceLive = Layer.succeed(MetricsService, {
  ...metricsServiceAdapter,
  renderPrometheus: () => Effect.sync(renderPrometheusMetrics),
});
