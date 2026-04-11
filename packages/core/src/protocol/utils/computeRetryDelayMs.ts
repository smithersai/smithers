import type { RetryPolicy } from "../RetryPolicy";
import { retryPolicyToSchedule } from "./retryPolicyToSchedule";
import { retryScheduleDelayMs } from "./retryScheduleDelayMs";

export function computeRetryDelayMs(
  policy: RetryPolicy | undefined,
  attempt: number,
): number {
  if (!policy) return 0;
  return retryScheduleDelayMs(retryPolicyToSchedule(policy), attempt);
}
