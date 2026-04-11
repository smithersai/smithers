import { Duration, Schedule } from "effect";
import type { RetryPolicy } from "../RetryPolicy";

const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;

/**
 * Convert a RetryPolicy to an Effect Schedule for use with Effect.retry.
 */
export function retryPolicyToSchedule(
  policy: RetryPolicy,
): Schedule.Schedule<unknown> {
  const base =
    typeof policy.initialDelayMs === "number"
      ? Math.max(0, Math.floor(policy.initialDelayMs))
      : 0;
  if (base <= 0) return Schedule.stop;

  const backoff = policy.backoff ?? "fixed";
  const capDelay = Schedule.modifyDelay((_out, delay) =>
    Duration.min(delay, Duration.millis(MAX_RETRY_DELAY_MS)),
  );
  switch (backoff) {
    case "fixed":
      return capDelay(Schedule.fixed(Duration.millis(base)));
    case "linear":
      return capDelay(Schedule.linear(Duration.millis(base)));
    case "exponential":
      return capDelay(Schedule.exponential(Duration.millis(base)));
  }
}
