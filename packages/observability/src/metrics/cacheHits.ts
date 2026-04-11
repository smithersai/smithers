import { Metric } from "effect";

export const cacheHits = Metric.counter("smithers.cache.hits");
