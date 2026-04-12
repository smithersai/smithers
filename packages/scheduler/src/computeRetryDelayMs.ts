import type { RetryPolicy } from "./RetryPolicy.ts";
export declare function computeRetryDelayMs(policy: RetryPolicy | undefined, attempt: number): number;
