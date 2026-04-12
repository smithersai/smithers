import { Metric, MetricBoundaries } from "effect";
const durationBuckets = MetricBoundaries.exponential({
    start: 1,
    factor: 2,
    count: 14,
}); // ~1ms to ~8s
export const memoryRecallDuration = Metric.histogram("smithers.memory.recall_duration_ms", durationBuckets);
