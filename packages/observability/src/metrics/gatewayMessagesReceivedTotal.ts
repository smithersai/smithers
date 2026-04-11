import { Metric } from "effect";

export const gatewayMessagesReceivedTotal = Metric.counter(
  "smithers.gateway.messages_received_total",
);
