// ---------------------------------------------------------------------------
// OpenAPI tool metrics
// ---------------------------------------------------------------------------
import { Metric, MetricBoundaries } from "effect";
export const openApiToolCallsTotal = Metric.counter("smithers.openapi.tool_calls");
export const openApiToolCallErrorsTotal = Metric.counter("smithers.openapi.tool_call_errors");
const toolBuckets = MetricBoundaries.exponential({
    start: 10,
    factor: 2,
    count: 14,
}); // ~10ms to ~80s
export const openApiToolDuration = Metric.histogram("smithers.openapi.tool_duration_ms", toolBuckets);
