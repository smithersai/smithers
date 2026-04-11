import { Metric } from "effect";

export const voiceErrorsTotal = Metric.counter("smithers.voice.errors_total");
