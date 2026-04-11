import { Metric } from "effect";

export const schedulerConcurrencyUtilization = Metric.gauge("smithers.scheduler.concurrency_utilization");
