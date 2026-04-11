import { Metric } from "effect";

export const gatewayConnectionsActive = Metric.gauge(
  "smithers.gateway.connections_active",
);
