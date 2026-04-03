export type RetryBackoff = "fixed" | "linear" | "exponential";

export type RetryPolicy = {
  backoff?: RetryBackoff;
  initialDelayMs?: number;
};
