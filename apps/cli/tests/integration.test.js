import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { runTreeOnce } from "../src/tree.js";
import { runDiffOnce } from "../src/diff.js";
import { runOutputOnce } from "../src/output.js";
import { runRewindOnce } from "../src/rewind.js";

/**
 * In-process integration tests for the four devtools live-run CLI commands.
 *
 * Strategy: construct an in-memory SmithersDb, seed a fixture run with
 * enough state for each RPC to succeed or fail in a documented way, and
 * invoke the CLI command entrypoints against the real gateway route
 * implementations (no mock server). This validates the full wiring from
 * the CLI through the route layer to the db adapter.
 */

function makeStream() {
    let out = "";
    return {
        write(chunk) {
            out += String(chunk);
        },
        get value() {
            return out;
        },
    };
}

function nonTtyStdin() {
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

async function openFixture() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    return { sqlite, adapter };
}

function workflowFrameJson(children) {
    return JSON.stringify({
        kind: "element",
        tag: "smithers:workflow",
        props: { name: "integration-fixture" },
        children,
    });
}

async function seedRun(adapter, runId) {
    const now = Date.now();
    await adapter.insertRun({
        runId,
        workflowName: "integration-fixture",
        workflowPath: "workflow.tsx",
        status: "running",
        createdAtMs: now - 10_000,
        startedAtMs: now - 9_000,
        finishedAtMs: null,
        heartbeatAtMs: now,
    });
    await adapter.insertFrame({
        runId,
        frameNo: 0,
        createdAtMs: now - 8_000,
        xmlJson: workflowFrameJson([]),
        xmlHash: "hash-0",
        mountedTaskIdsJson: "[]",
        taskIndexJson: "[]",
        note: null,
    });
}

describe("integration: runTreeOnce", () => {
    test("returns a snapshot for a seeded run and emits parseable JSON", async () => {
        const { sqlite, adapter } = await openFixture();
        try {
            await seedRun(adapter, "run-int-1");
            const stdout = makeStream();
            const stderr = makeStream();
            const result = await runTreeOnce({
                adapter,
                runId: "run-int-1",
                json: true,
                watch: false,
                color: false,
                stdout,
                stderr,
            });
            expect(result.exitCode).toBe(0);
            expect(stderr.value).toBe("");
            const parsed = JSON.parse(stdout.value);
            expect(parsed.runId).toBe("run-int-1");
            expect(parsed.root).toBeDefined();
        } finally {
            sqlite.close();
        }
    });

    test("rendered tree contains XML-like open tag for the workflow", async () => {
        const { sqlite, adapter } = await openFixture();
        try {
            await seedRun(adapter, "run-int-2");
            const stdout = makeStream();
            const stderr = makeStream();
            const result = await runTreeOnce({
                adapter,
                runId: "run-int-2",
                json: false,
                watch: false,
                color: false,
                stdout,
                stderr,
            });
            expect(result.exitCode).toBe(0);
            expect(stdout.value).toContain("<");
            expect(stdout.value).toContain(">");
        } finally {
            sqlite.close();
        }
    });

    test("InvalidRunId from the route layer yields exit 1 on stderr", async () => {
        const { sqlite, adapter } = await openFixture();
        try {
            const stdout = makeStream();
            const stderr = makeStream();
            const result = await runTreeOnce({
                adapter,
                runId: "NOT VALID",
                json: false,
                watch: false,
                color: false,
                stdout,
                stderr,
            });
            expect(result.exitCode).toBe(1);
            expect(stdout.value).toBe("");
            expect(stderr.value).toContain("InvalidRunId");
            expect(stderr.value).toContain("hint:");
        } finally {
            sqlite.close();
        }
    });
});

describe("integration: runOutputOnce", () => {
    test("NodeNotFound / RunNotFound flow emits typed error and exit 1", async () => {
        const { sqlite, adapter } = await openFixture();
        try {
            const stdout = makeStream();
            const stderr = makeStream();
            const result = await runOutputOnce({
                adapter,
                runId: "no-such-run",
                nodeId: "task-a",
                json: true,
                pretty: false,
                stdout,
                stderr,
            });
            expect(result.exitCode).toBe(1);
            expect(stderr.value).toContain("RunNotFound");
        } finally {
            sqlite.close();
        }
    });
});

describe("integration: runDiffOnce", () => {
    test("NodeNotFound for a missing task yields exit 1 + hint", async () => {
        const { sqlite, adapter } = await openFixture();
        try {
            await seedRun(adapter, "run-diff-int");
            const stdout = makeStream();
            const stderr = makeStream();
            const result = await runDiffOnce({
                adapter,
                runId: "run-diff-int",
                nodeId: "never-mounted",
                json: false,
                stat: false,
                color: false,
                stdout,
                stderr,
            });
            expect(result.exitCode).toBe(1);
            expect(stderr.value).toContain("NodeNotFound");
            expect(stderr.value).toContain("hint:");
        } finally {
            sqlite.close();
        }
    });
});

describe("integration: runRewindOnce", () => {
    test("--yes on a missing run surfaces RunNotFound with exit 1", async () => {
        const { sqlite, adapter } = await openFixture();
        try {
            const stdout = makeStream();
            const stderr = makeStream();
            const result = await runRewindOnce({
                adapter,
                runId: "no-such-run",
                frameNo: 0,
                yes: true,
                json: false,
                stdin: nonTtyStdin(),
                stdout,
                stderr,
            });
            expect(result.exitCode).toBe(1);
            expect(stderr.value).toContain("RunNotFound");
        } finally {
            sqlite.close();
        }
    });

    test("without --yes on a non-TTY stdin exits 3", async () => {
        const { sqlite, adapter } = await openFixture();
        try {
            const stdout = makeStream();
            const stderr = makeStream();
            const result = await runRewindOnce({
                adapter,
                runId: "no-such-run",
                frameNo: 0,
                yes: false,
                json: false,
                stdin: nonTtyStdin(),
                stdout,
                stderr,
            });
            expect(result.exitCode).toBe(3);
            expect(stderr.value).toContain("ConfirmationRequired");
        } finally {
            sqlite.close();
        }
    });
});
