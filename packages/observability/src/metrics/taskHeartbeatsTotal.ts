import { Metric } from "effect";

export const taskHeartbeatsTotal = Metric.counter("smithers.heartbeats.total");
