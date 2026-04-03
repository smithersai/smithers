import { describe, expect, test } from "bun:test";
import { isRetryableSqliteWriteError } from "../src/db/write-retry";

describe("isRetryableSqliteWriteError", () => {
  test("returns true for SQLITE_BUSY code", () => {
    const err = Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
    expect(isRetryableSqliteWriteError(err)).toBe(true);
  });

  test("returns true for SQLITE_BUSY_RECOVERY code", () => {
    const err = Object.assign(new Error("busy"), { code: "SQLITE_BUSY_RECOVERY" });
    expect(isRetryableSqliteWriteError(err)).toBe(true);
  });

  test("returns true for SQLITE_IOERR code", () => {
    const err = Object.assign(new Error("io"), { code: "SQLITE_IOERR" });
    expect(isRetryableSqliteWriteError(err)).toBe(true);
  });

  test("returns true for SQLITE_IOERR_WRITE code", () => {
    const err = Object.assign(new Error("io write"), { code: "SQLITE_IOERR_WRITE" });
    expect(isRetryableSqliteWriteError(err)).toBe(true);
  });

  test("returns true for 'database is locked' message", () => {
    expect(isRetryableSqliteWriteError(new Error("database is locked"))).toBe(true);
  });

  test("returns true for 'database is busy' message", () => {
    expect(isRetryableSqliteWriteError(new Error("database is busy"))).toBe(true);
  });

  test("returns true for 'disk i/o error' message", () => {
    expect(isRetryableSqliteWriteError(new Error("disk i/o error"))).toBe(true);
  });

  test("returns true for message with mixed case", () => {
    expect(isRetryableSqliteWriteError(new Error("Database Is Locked"))).toBe(true);
  });

  test("returns false for generic error", () => {
    expect(isRetryableSqliteWriteError(new Error("something else"))).toBe(false);
  });

  test("returns false for SQLITE_CONSTRAINT code", () => {
    const err = Object.assign(new Error("constraint"), { code: "SQLITE_CONSTRAINT" });
    expect(isRetryableSqliteWriteError(err)).toBe(false);
  });

  test("returns false for null", () => {
    expect(isRetryableSqliteWriteError(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isRetryableSqliteWriteError(undefined)).toBe(false);
  });

  test("returns false for string", () => {
    expect(isRetryableSqliteWriteError("database is locked")).toBe(false);
  });

  test("returns false for number", () => {
    expect(isRetryableSqliteWriteError(42)).toBe(false);
  });

  test("returns false for error without code or matching message", () => {
    const err = Object.assign(new Error("random error"), { code: "OTHER" });
    expect(isRetryableSqliteWriteError(err)).toBe(false);
  });
});
