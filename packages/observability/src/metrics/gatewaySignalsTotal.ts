import { Metric } from "effect";

export const gatewaySignalsTotal = Metric.counter("smithers.gateway.signals_total");
