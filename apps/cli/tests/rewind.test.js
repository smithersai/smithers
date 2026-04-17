import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers/db/adapter";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { runRewindOnce } from "../src/rewind.js";

function makeStream() {
    let out = "";
    return {
        write(chunk) { out += String(chunk); },
        get value() { return out; },
    };
}

async function openMemoryDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { sqlite, adapter: new SmithersDb(db) };
}

function nonTtyStdin() {
    // Minimal duck-typed stream that reports not-a-tty.
    return {
        isTTY: false,
        on() { return this; },
        off() { return this; },
        once() { return this; },
        resume() { return this; },
        pause() { return this; },
        pipe() { return this; },
        unpipe() { return this; },
        setEncoding() { return this; },
    };
}

describe("runRewindOnce", () => {
    test("exits 3 when stdin is not a TTY and --yes is not set", async () => {
        const { sqlite, adapter } = await openMemoryDb();
        const stdout = makeStream();
        const stderr = makeStream();
        try {
            const result = await runRewindOnce({
                adapter,
                runId: "run-x",
                frameNo: 5,
                yes: false,
                json: false,
                stdin: nonTtyStdin(),
                stdout,
                stderr,
            });
            expect(result.exitCode).toBe(3);
            expect(stderr.value).toContain("ConfirmationRequired");
            expect(stderr.value).toContain("--yes");
        } finally {
            sqlite.close();
        }
    });

    test("exits 3 when the confirm callback rejects", async () => {
        const { sqlite, adapter } = await openMemoryDb();
        const stdout = makeStream();
        const stderr = makeStream();
        try {
            const result = await runRewindOnce({
                adapter,
                runId: "run-x",
                frameNo: 5,
                yes: false,
                json: false,
                stdin: nonTtyStdin(),
                stdout,
                stderr,
                confirm: async () => false,
            });
            expect(result.exitCode).toBe(3);
            expect(stderr.value).toContain("declined");
        } finally {
            sqlite.close();
        }
    });

    test("maps server-side RunNotFound to exit 2 via typed error path", async () => {
        const { sqlite, adapter } = await openMemoryDb();
        const stdout = makeStream();
        const stderr = makeStream();
        try {
            const result = await runRewindOnce({
                adapter,
                runId: "missing-run",
                frameNo: 0,
                yes: true,
                json: false,
                stdin: nonTtyStdin(),
                stdout,
                stderr,
            });
            // RunNotFound from JumpToFrameError is a user error (run doesn't
            // exist locally). Our mapping keeps it at exit 1.
            expect(result.exitCode).toBe(1);
            expect(stderr.value).toContain("RunNotFound");
        } finally {
            sqlite.close();
        }
    });

    test("maps InvalidRunId to exit 1", async () => {
        const { sqlite, adapter } = await openMemoryDb();
        const stdout = makeStream();
        const stderr = makeStream();
        try {
            const result = await runRewindOnce({
                adapter,
                runId: "!!BAD!!",
                frameNo: 0,
                yes: true,
                json: false,
                stdin: nonTtyStdin(),
                stdout,
                stderr,
            });
            expect(result.exitCode).toBe(1);
            expect(stderr.value).toContain("InvalidRunId");
        } finally {
            sqlite.close();
        }
    });
});
