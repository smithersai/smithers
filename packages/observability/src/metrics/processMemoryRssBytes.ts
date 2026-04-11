import { Metric } from "effect";

export const processMemoryRssBytes = Metric.gauge("smithers.process.memory_rss_bytes");
