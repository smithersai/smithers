import { Metric } from "effect";

export const supervisorSkippedTotal = Metric.counter("smithers.supervisor.skipped_total");
