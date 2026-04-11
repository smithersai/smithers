import { Metric } from "effect";

export const httpRequests = Metric.counter("smithers.http.requests");
