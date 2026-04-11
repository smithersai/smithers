import { Metric } from "effect";

export const hotReloadFailures = Metric.counter("smithers.hot.reload_failures");
