import { Metric, MetricBoundaries } from "effect";

const durationBuckets = MetricBoundaries.exponential({
  start: 10,
  factor: 2,
  count: 14,
}); // ~10ms to ~80s

export const ragRetrieveDuration = Metric.histogram(
  "smithers.rag.retrieve_duration_ms",
  durationBuckets,
);
