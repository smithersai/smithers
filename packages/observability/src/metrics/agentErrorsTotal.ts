import { Metric } from "effect";

export const agentErrorsTotal = Metric.counter("smithers.agent_errors_total");
