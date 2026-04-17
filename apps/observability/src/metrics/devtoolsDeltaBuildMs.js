import { Metric } from "effect";
import { fastBuckets } from "./_buckets.js";
export const devtoolsDeltaBuildMs = Metric.histogram("smithers.devtools.delta_build_ms", fastBuckets);
