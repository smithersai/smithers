import { Metric } from "effect";

export const gatewayWebhooksRejectedTotal = Metric.counter(
  "smithers.gateway.webhooks_rejected_total",
);
