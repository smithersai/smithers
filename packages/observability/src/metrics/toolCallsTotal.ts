import { Metric } from "effect";

export const toolCallsTotal = Metric.counter("smithers.tool_calls.total");
