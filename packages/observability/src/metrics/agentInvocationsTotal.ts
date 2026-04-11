import { Metric } from "effect";

export const agentInvocationsTotal = Metric.counter("smithers.agent_invocations_total");
