import { Metric } from "effect";
import { ancestryDepthBuckets } from "./_buckets";

export const runsAncestryDepth = Metric.histogram(
  "smithers.runs.ancestry_depth",
  ancestryDepthBuckets,
);
