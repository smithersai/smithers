import { describe, expect, test } from "bun:test";
import { withSqliteWriteRetryEffect, isRetryableSqliteWriteError, } from "../src/write-retry.js";
import { Effect } from "effect";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * @param {string} code
 * @param {string} message
 * @returns {SmithersError}
 */
function makeSqliteError(code, message) {
    return new SmithersError(code, message);
}
function makeTrackingSleep() {
    const delays = [];
    /**
   * @param {number} ms
   */
    const sleep = async (ms) => {
        delays.push(ms);
    };
    return { delays, sleep };
}
// ---------------------------------------------------------------------------
// withSqliteWriteRetryEffect
// ---------------------------------------------------------------------------
describe("withSqliteWriteRetryEffect", () => {
    test("succeeds on first try", async () => {
        const result = await Effect.runPromise(withSqliteWriteRetryEffect(() => Effect.succeed("hello")));
        expect(result).toBe("hello");
    });
    test("retries on SQLITE_BUSY then succeeds", async () => {
        let attempts = 0;
        const { delays, sleep } = makeTrackingSleep();
        const result = await Effect.runPromise(withSqliteWriteRetryEffect(() => {
            attempts += 1;
            if (attempts < 3) {
                return Effect.fail(makeSqliteError("SQLITE_BUSY", "database is busy"));
            }
            return Effect.succeed("recovered");
        }, { label: "busy-test", maxAttempts: 5, sleep }));
        expect(result).toBe("recovered");
        expect(attempts).toBe(3);
        expect(delays.length).toBe(2);
        expect(delays.every((ms) => ms > 0)).toBe(true);
    });
    test("retries on SQLITE_IOERR then succeeds", async () => {
        let attempts = 0;
        const { delays, sleep } = makeTrackingSleep();
        const result = await Effect.runPromise(withSqliteWriteRetryEffect(() => {
            attempts += 1;
            if (attempts < 3) {
                return Effect.fail(makeSqliteError("SQLITE_IOERR_VNODE", "disk I/O error"));
            }
            return Effect.succeed("io-recovered");
        }, { label: "ioerr-test", maxAttempts: 5, sleep }));
        expect(result).toBe("io-recovered");
        expect(attempts).toBe(3);
        expect(delays.length).toBe(2);
        expect(delays.every((ms) => ms > 0)).toBe(true);
    });
    test("retries on 'database is locked' message (no code)", async () => {
        let attempts = 0;
        const { delays, sleep } = makeTrackingSleep();
        const result = await Effect.runPromise(withSqliteWriteRetryEffect(() => {
            attempts += 1;
            if (attempts === 1) {
                return Effect.fail(new SmithersError("DB_WRITE_FAILED", "database is locked"));
            }
            return Effect.succeed("lock-recovered");
        }, { label: "locked-test", maxAttempts: 4, sleep }));
        expect(result).toBe("lock-recovered");
        expect(attempts).toBe(2);
        expect(delays.length).toBe(1);
    });
    test("does NOT retry non-retryable errors", async () => {
        let attempts = 0;
        const { delays, sleep } = makeTrackingSleep();
        const err = makeSqliteError("SQLITE_CONSTRAINT", "constraint failed");
        const exit = await Effect.runPromiseExit(withSqliteWriteRetryEffect(() => {
            attempts += 1;
            return Effect.fail(err);
        }, { label: "no-retry-test", maxAttempts: 5, sleep }));
        expect(exit._tag).toBe("Failure");
        expect(attempts).toBe(1);
        expect(delays.length).toBe(0);
    });
    test("exhausts max attempts then fails", async () => {
        let attempts = 0;
        const { delays, sleep } = makeTrackingSleep();
        const exit = await Effect.runPromiseExit(withSqliteWriteRetryEffect(() => {
            attempts += 1;
            return Effect.fail(makeSqliteError("SQLITE_BUSY", "database is busy"));
        }, { label: "exhaust-test", maxAttempts: 4, sleep }));
        expect(exit._tag).toBe("Failure");
        expect(attempts).toBe(4);
        // Retries happen between attempts, so 3 delays for 4 attempts
        expect(delays.length).toBe(3);
    });
    test("respects custom maxAttempts=2", async () => {
        let attempts = 0;
        const { delays, sleep } = makeTrackingSleep();
        const exit = await Effect.runPromiseExit(withSqliteWriteRetryEffect(() => {
            attempts += 1;
            return Effect.fail(makeSqliteError("SQLITE_BUSY", "database is busy"));
        }, { label: "custom-max-test", maxAttempts: 2, sleep }));
        expect(exit._tag).toBe("Failure");
        expect(attempts).toBe(2);
        expect(delays.length).toBe(1);
    });
});
// ---------------------------------------------------------------------------
// isRetryableSqliteWriteError — edge cases
// ---------------------------------------------------------------------------
describe("isRetryableSqliteWriteError edge cases", () => {
    test("returns true for SQLITE_BUSY code", () => {
        expect(isRetryableSqliteWriteError(makeSqliteError("SQLITE_BUSY", "busy"))).toBe(true);
    });
    test("returns true for SQLITE_BUSY subcode", () => {
        expect(isRetryableSqliteWriteError(makeSqliteError("SQLITE_BUSY_RECOVERY", "busy recovery"))).toBe(true);
    });
    test("returns true for SQLITE_IOERR code", () => {
        expect(isRetryableSqliteWriteError(makeSqliteError("SQLITE_IOERR", "io error"))).toBe(true);
    });
    test("returns true for SQLITE_IOERR subcode", () => {
        expect(isRetryableSqliteWriteError(makeSqliteError("SQLITE_IOERR_VNODE", "io error vnode"))).toBe(true);
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
    test("returns true for mixed-case message", () => {
        expect(isRetryableSqliteWriteError(new Error("Database Is Locked"))).toBe(true);
    });
    test("returns false for SQLITE_CONSTRAINT", () => {
        expect(isRetryableSqliteWriteError(makeSqliteError("SQLITE_CONSTRAINT", "constraint"))).toBe(false);
    });
    test("returns false for unrelated error", () => {
        expect(isRetryableSqliteWriteError(new Error("something else"))).toBe(false);
    });
    test("returns false for null", () => {
        expect(isRetryableSqliteWriteError(null)).toBe(false);
    });
    test("returns false for undefined", () => {
        expect(isRetryableSqliteWriteError(undefined)).toBe(false);
    });
    test("returns false for plain string", () => {
        expect(isRetryableSqliteWriteError("SQLITE_BUSY")).toBe(false);
    });
    test("returns false for number", () => {
        expect(isRetryableSqliteWriteError(42)).toBe(false);
    });
});
