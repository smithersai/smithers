import { Metric } from "effect";

export const gatewayWebhooksReceivedTotal = Metric.counter(
  "smithers.gateway.webhooks_received_total",
);
