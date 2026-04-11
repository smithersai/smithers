import { Metric } from "effect";

export const gatewayWebhooksVerifiedTotal = Metric.counter(
  "smithers.gateway.webhooks_verified_total",
);
