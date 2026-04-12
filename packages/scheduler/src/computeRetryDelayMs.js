import { retryPolicyToSchedule } from "./retryPolicyToSchedule.js";
import { retryScheduleDelayMs } from "./retryScheduleDelayMs.js";
/** @typedef {import("./RetryPolicy.ts").RetryPolicy} RetryPolicy */

/**
 * @param {RetryPolicy | undefined} policy
 * @param {number} attempt
 * @returns {number}
 */
export function computeRetryDelayMs(policy, attempt) {
    if (!policy)
        return 0;
    return retryScheduleDelayMs(retryPolicyToSchedule(policy), attempt);
}
