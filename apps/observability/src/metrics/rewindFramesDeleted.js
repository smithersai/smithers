import { MetricBoundaries, Metric } from "effect";
const buckets = MetricBoundaries.exponential({ start: 1, factor: 2, count: 18 });
export const rewindFramesDeleted = Metric.histogram("smithers_rewind_frames_deleted", buckets);
