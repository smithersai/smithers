import { Metric } from "effect";

export const eventsEmittedTotal = Metric.counter("smithers.events.emitted_total");
