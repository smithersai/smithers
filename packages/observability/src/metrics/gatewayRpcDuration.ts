import { Metric } from "effect";
import { durationBuckets } from "./_buckets";

export const gatewayRpcDuration = Metric.histogram(
  "smithers.gateway.rpc_duration_ms",
  durationBuckets,
);
