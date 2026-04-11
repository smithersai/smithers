import { Metric } from "effect";

export const schedulerQueueDepth = Metric.gauge("smithers.scheduler.queue_depth");
