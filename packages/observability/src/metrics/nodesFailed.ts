import { Metric } from "effect";

export const nodesFailed = Metric.counter("smithers.nodes.failed");
