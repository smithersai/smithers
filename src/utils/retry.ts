import { Duration, Effect, Schedule, ScheduleDecision, ScheduleIntervals } from "effect";
import type { RetryPolicy } from "../RetryPolicy";

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
  switch (backoff) {
    case "fixed":
      return Schedule.fixed(Duration.millis(base));
    case "linear":
      return Schedule.linear(Duration.millis(base));
    case "exponential":
      return Schedule.exponential(Duration.millis(base));
  }
}

export function retryScheduleDelayMs(
  schedule: Schedule.Schedule<unknown>,
  attempt: number,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  let state = schedule.initial;
  let now = 0;
  let delayMs = 0;

  for (let index = 0; index < safeAttempt; index++) {
    const [nextState, , decision] = Effect.runSync(
      schedule.step(now, undefined, state),
    );
    if (ScheduleDecision.isDone(decision)) {
      return 0;
    }
    const nextNow = ScheduleIntervals.start(decision.intervals);
    delayMs = Math.max(0, nextNow - now);
    state = nextState;
    now = nextNow;
  }

  return delayMs;
}

export function computeRetryDelayMs(
  policy: RetryPolicy | undefined,
  attempt: number,
): number {
  if (!policy) return 0;
  return retryScheduleDelayMs(retryPolicyToSchedule(policy), attempt);
}
