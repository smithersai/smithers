import { Metric } from "effect";

export const toolCallErrorsTotal = Metric.counter("smithers.tool_calls.errors_total");
