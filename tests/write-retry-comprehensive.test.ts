import { describe, expect, test } from "bun:test";
import {
  isRetryableSqliteWriteError,
  withSqliteWriteRetry,
} from "../src/db/write-retry";

describe("isRetryableSqliteWriteError", () => {
  test("SQLITE_BUSY code is retryable", () => {
    const err = Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
    expect(isRetryableSqliteWriteError(err)).toBe(true);
  });

  test("SQLITE_BUSY_SNAPSHOT is retryable", () => {
    const err = Object.assign(new Error("busy"), {
      code: "SQLITE_BUSY_SNAPSHOT",
    });
    expect(isRetryableSqliteWriteError(err)).toBe(true);
  });

  test("SQLITE_IOERR code is retryable", () => {
    const err = Object.assign(new Error("io"), { code: "SQLITE_IOERR" });
    expect(isRetryableSqliteWriteError(err)).toBe(true);
  });

  test("SQLITE_IOERR_WRITE is retryable", () => {
    const err = Object.assign(new Error("io"), {
      code: "SQLITE_IOERR_WRITE",
    });
    expect(isRetryableSqliteWriteError(err)).toBe(true);
  });

  test("'database is locked' message is retryable", () => {
    const err = new Error("database is locked");
    expect(isRetryableSqliteWriteError(err)).toBe(true);
  });

  test("'database is busy' message is retryable", () => {
    const err = new Error("Database is busy");
    expect(isRetryableSqliteWriteError(err)).toBe(true);
  });

  test("'disk i/o error' message is retryable", () => {
    const err = new Error("disk i/o error occurred");
    expect(isRetryableSqliteWriteError(err)).toBe(true);
  });

  test("regular error is not retryable", () => {
    const err = new Error("syntax error");
    expect(isRetryableSqliteWriteError(err)).toBe(false);
  });

  test("SQLITE_CONSTRAINT is not retryable", () => {
    const err = Object.assign(new Error("constraint"), {
      code: "SQLITE_CONSTRAINT",
    });
    expect(isRetryableSqliteWriteError(err)).toBe(false);
  });

  test("null is not retryable", () => {
    expect(isRetryableSqliteWriteError(null)).toBe(false);
  });

  test("undefined is not retryable", () => {
    expect(isRetryableSqliteWriteError(undefined)).toBe(false);
  });

  test("string is not retryable", () => {
    expect(isRetryableSqliteWriteError("database is locked")).toBe(false);
  });
});

describe("withSqliteWriteRetry", () => {
  test("succeeds on first try", async () => {
    let calls = 0;
    const result = await withSqliteWriteRetry(async () => {
      calls++;
      return 42;
    });
    expect(result).toBe(42);
    expect(calls).toBe(1);
  });

  test("retries on retryable error and succeeds", async () => {
    let calls = 0;
    const result = await withSqliteWriteRetry(
      async () => {
        calls++;
        if (calls < 3) {
          throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
        }
        return "ok";
      },
      {
        maxAttempts: 5,
        baseDelayMs: 1,
        sleep: () => Promise.resolve(),
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  test("throws non-retryable error immediately", async () => {
    let calls = 0;
    await expect(
      withSqliteWriteRetry(async () => {
        calls++;
        throw new Error("syntax error");
      }),
    ).rejects.toThrow("syntax error");
    expect(calls).toBe(1);
  });

  test("throws after max attempts exhausted", async () => {
    let calls = 0;
    await expect(
      withSqliteWriteRetry(
        async () => {
          calls++;
          throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
        },
        {
          maxAttempts: 3,
          baseDelayMs: 1,
          sleep: () => Promise.resolve(),
        },
      ),
    ).rejects.toThrow("busy");
    expect(calls).toBe(3);
  });
});
