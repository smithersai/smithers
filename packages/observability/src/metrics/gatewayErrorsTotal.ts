import { Metric } from "effect";

export const gatewayErrorsTotal = Metric.counter("smithers.gateway.errors_total");
