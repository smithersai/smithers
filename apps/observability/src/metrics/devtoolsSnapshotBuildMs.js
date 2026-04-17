import { Metric } from "effect";
import { fastBuckets } from "./_buckets.js";
export const devtoolsSnapshotBuildMs = Metric.histogram("smithers.devtools.snapshot_build_ms", fastBuckets);
