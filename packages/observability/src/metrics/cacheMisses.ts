import { Metric } from "effect";

export const cacheMisses = Metric.counter("smithers.cache.misses");
