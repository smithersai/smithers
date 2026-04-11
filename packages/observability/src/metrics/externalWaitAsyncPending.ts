import { Metric } from "effect";

export const externalWaitAsyncPending = Metric.gauge(
  "smithers.external_wait.async_pending",
);
