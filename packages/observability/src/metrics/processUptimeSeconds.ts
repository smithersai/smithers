import { Metric } from "effect";

export const processUptimeSeconds = Metric.gauge("smithers.process.uptime_seconds");
