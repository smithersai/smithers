import { Metric } from "effect";

export const taskHeartbeatTimeoutTotal = Metric.counter("smithers.heartbeats.timeout_total");
