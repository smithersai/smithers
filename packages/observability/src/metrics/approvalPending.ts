import { Metric } from "effect";

export const approvalPending = Metric.gauge("smithers.approval.pending");
