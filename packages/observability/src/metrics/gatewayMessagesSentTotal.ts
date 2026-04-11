import { Metric } from "effect";

export const gatewayMessagesSentTotal = Metric.counter(
  "smithers.gateway.messages_sent_total",
);
