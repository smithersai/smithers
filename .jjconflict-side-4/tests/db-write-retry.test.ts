import { describe, expect, test } from "bun:test";
import {
  isRetryableSqliteWriteError,
  withSqliteWriteRetry,
} from "../src/db/write-retry";

describe("sqlite write retry", () => {
  test("retries retryable sqlite I/O errors with backoff", async () => {
    let attempts = 0;
    const delays: number[] = [];

    const result = await withSqliteWriteRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          const err = new Error("disk I/O error");
          (err as any).code = "SQLITE_IOERR_VNODE";
          throw err;
        }
        return "ok";
      },
      {
        label: "test write",
        maxAttempts: 4,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(delays.length).toBe(2);
    expect(delays.every((ms) => ms > 0)).toBe(true);
  });

  test("retries retryable lock errors by message", async () => {
    let attempts = 0;

    const result = await withSqliteWriteRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("database is locked");
        }
        return 42;
      },
      {
        maxAttempts: 3,
        sleep: async () => {},
      },
    );

    expect(result).toBe(42);
    expect(attempts).toBe(2);
  });

  test("does not retry non-retryable errors", async () => {
    let attempts = 0;
    const err = new Error("constraint failed");
    (err as any).code = "SQLITE_CONSTRAINT";

    await expect(
      withSqliteWriteRetry(
        async () => {
          attempts += 1;
          throw err;
        },
        {
          maxAttempts: 4,
          sleep: async () => {},
        },
      ),
    ).rejects.toThrow("constraint failed");

    expect(attempts).toBe(1);
    expect(isRetryableSqliteWriteError(err)).toBe(false);
  });
});
