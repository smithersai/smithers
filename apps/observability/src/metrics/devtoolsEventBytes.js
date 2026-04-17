import { Metric } from "effect";
import { sizeBuckets } from "./_buckets.js";
export const devtoolsEventBytes = Metric.histogram("smithers.devtools.event_bytes", sizeBuckets);
