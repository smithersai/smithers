import { Metric } from "effect";

export const supervisorStaleDetected = Metric.counter("smithers.supervisor.stale_detected");
