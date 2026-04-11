import { Metric } from "effect";

export const gatewayRunsStartedTotal = Metric.counter(
  "smithers.gateway.runs_started_total",
);
