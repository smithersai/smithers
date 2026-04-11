import { Effect, Metric } from "effect";
import { processStartMs } from "./_processStartMs";
import { processUptimeSeconds } from "./processUptimeSeconds";
import { processMemoryRssBytes } from "./processMemoryRssBytes";
import { processHeapUsedBytes } from "./processHeapUsedBytes";

export function updateProcessMetrics(): Effect.Effect<void> {
  const uptimeS = (Date.now() - processStartMs) / 1000;
  const mem = process.memoryUsage();
  return Effect.all([
    Metric.set(processUptimeSeconds, uptimeS),
    Metric.set(processMemoryRssBytes, mem.rss),
    Metric.set(processHeapUsedBytes, mem.heapUsed),
  ], { discard: true });
}
