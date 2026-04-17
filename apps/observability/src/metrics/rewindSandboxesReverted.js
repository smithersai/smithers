import { MetricBoundaries, Metric } from "effect";
const buckets = MetricBoundaries.fromIterable([0, 1, 2, 4, 8, 16, 32, 64]);
export const rewindSandboxesReverted = Metric.histogram("smithers_rewind_sandboxes_reverted", buckets);
