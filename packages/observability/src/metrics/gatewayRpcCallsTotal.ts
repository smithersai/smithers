import { Metric } from "effect";

export const gatewayRpcCallsTotal = Metric.counter(
  "smithers.gateway.rpc_calls_total",
);
