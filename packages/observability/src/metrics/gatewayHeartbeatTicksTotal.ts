import { Metric } from "effect";

export const gatewayHeartbeatTicksTotal = Metric.counter(
  "smithers.gateway.heartbeat_ticks_total",
);
