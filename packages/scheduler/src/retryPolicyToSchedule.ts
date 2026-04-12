import { Schedule } from "effect";
import type { RetryPolicy } from "./RetryPolicy.ts";
/**
 * Convert a RetryPolicy to an Effect Schedule for use with Effect.retry.
 */
export declare function retryPolicyToSchedule(policy: RetryPolicy): Schedule.Schedule<unknown>;
