import { Metric, MetricBoundaries } from "effect";

const durationBuckets = MetricBoundaries.exponential({
  start: 10,
  factor: 2,
  count: 14,
}); // ~10ms to ~80s

export const ragEmbedDuration = Metric.histogram(
  "smithers.rag.embed_duration_ms",
  durationBuckets,
);
