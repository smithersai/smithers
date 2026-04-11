import { Metric } from "effect";

export const gatewayApprovalDecisionsTotal = Metric.counter(
  "smithers.gateway.approval_decisions_total",
);
