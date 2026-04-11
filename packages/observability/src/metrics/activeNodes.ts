import { Metric } from "effect";

export const activeNodes = Metric.gauge("smithers.nodes.active");
