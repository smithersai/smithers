import { Metric } from "effect";

export const activeRuns = Metric.gauge("smithers.runs.active");
