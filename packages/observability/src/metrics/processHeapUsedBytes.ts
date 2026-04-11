import { Metric } from "effect";

export const processHeapUsedBytes = Metric.gauge("smithers.process.heap_used_bytes");
