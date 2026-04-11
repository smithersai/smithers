import { Metric } from "effect";

export const gatewayRunsCompletedTotal = Metric.counter(
  "smithers.gateway.runs_completed_total",
);
