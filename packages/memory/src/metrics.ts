import { Metric, MetricBoundaries } from "effect";

// ---------------------------------------------------------------------------
// Memory counters
// ---------------------------------------------------------------------------

export const memoryFactReads = Metric.counter("smithers.memory.fact_reads");
export const memoryFactWrites = Metric.counter("smithers.memory.fact_writes");
export const memoryRecallQueries = Metric.counter("smithers.memory.recall_queries");
export const memoryMessageSaves = Metric.counter("smithers.memory.message_saves");

// ---------------------------------------------------------------------------
// Memory histograms
// ---------------------------------------------------------------------------

const durationBuckets = MetricBoundaries.exponential({
  start: 1,
  factor: 2,
  count: 14,
}); // ~1ms to ~8s

export const memoryRecallDuration = Metric.histogram(
  "smithers.memory.recall_duration_ms",
  durationBuckets,
);
