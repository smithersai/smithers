import { Metric, MetricBoundaries } from "effect";

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

export const scorersStarted = Metric.counter("smithers.scorers.started");
export const scorersFinished = Metric.counter("smithers.scorers.finished");
export const scorersFailed = Metric.counter("smithers.scorers.failed");

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

const scorerBuckets = MetricBoundaries.exponential({
  start: 10,
  factor: 2,
  count: 14,
}); // ~10ms to ~80s

export const scorerDuration = Metric.histogram(
  "smithers.scorer.duration_ms",
  scorerBuckets,
);
