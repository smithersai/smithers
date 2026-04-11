import type { SqliteWriteRetryOptions } from "./SqliteWriteRetryOptions";
import { isRetryableSqliteWriteError } from "./isRetryableSqliteWriteError";

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_BASE_DELAY_MS = 50;
const DEFAULT_MAX_DELAY_MS = 2_000;

export type { SqliteWriteRetryOptions } from "./SqliteWriteRetryOptions";
export { isRetryableSqliteWriteError } from "./isRetryableSqliteWriteError";
export { withSqliteWriteRetryEffect } from "./withSqliteWriteRetryEffect";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeDelayMs(
  retryAttempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const boundedBaseDelayMs = Math.max(1, Math.floor(baseDelayMs));
  const boundedMaxDelayMs = Math.max(1, Math.floor(maxDelayMs));
  const exponentialDelayMs = boundedBaseDelayMs * 2 ** Math.max(0, retryAttempt - 1);
  return Math.min(boundedMaxDelayMs, exponentialDelayMs);
}

export async function withSqliteWriteRetry<A>(
  operation: () => A | PromiseLike<A>,
  opts: SqliteWriteRetryOptions = {},
): Promise<A> {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    sleep = delay,
  } = opts;
  const boundedMaxAttempts = Math.max(1, Math.floor(maxAttempts));

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (
        attempt >= boundedMaxAttempts ||
        !isRetryableSqliteWriteError(error)
      ) {
        throw error;
      }

      await sleep(computeDelayMs(attempt, baseDelayMs, maxDelayMs));
    }
  }
}
