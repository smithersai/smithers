import { Metric } from "effect";

export const gatewayCronTriggersTotal = Metric.counter(
  "smithers.gateway.cron_triggers_total",
);
