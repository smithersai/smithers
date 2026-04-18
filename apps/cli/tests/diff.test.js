import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { renderUnifiedDiff, renderDiffStat, runDiffOnce } from "../src/diff.js";

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

const sampleBundle = {
    seq: 1,
    baseRef: "abc",
    patches: [
        {
            path: "foo.txt",
            operation: "modify",
            diff: "--- a/foo.txt\n+++ b/foo.txt\n@@ -1 +1 @@\n-old\n+new\n",
        },
        {
            path: "bar.txt",
            operation: "add",
            diff: "--- /dev/null\n+++ b/bar.txt\n@@ -0,0 +1 @@\n+hello\n",
        },
    ],
};

describe("renderUnifiedDiff", () => {
    test("returns (no changes) for empty bundles", () => {
        expect(renderUnifiedDiff({ seq: 1, baseRef: "a", patches: [] })).toBe("(no changes)");
    });

    test("concatenates patches in order", () => {
        const text = renderUnifiedDiff(sampleBundle);
        expect(text).toContain("foo.txt");
        expect(text).toContain("bar.txt");
        expect(text.indexOf("foo.txt")).toBeLessThan(text.indexOf("bar.txt"));
    });

    test("adds ANSI color codes to +/- lines when color=true", () => {
        const colored = renderUnifiedDiff(sampleBundle, { color: true });
        const plain = renderUnifiedDiff(sampleBundle, { color: false });
        expect(colored).toContain("\u001b[");
        expect(plain).not.toContain("\u001b[");
    });
});

describe("renderDiffStat", () => {
    test("summarizes per-file add/remove counts", () => {
        const text = renderDiffStat(sampleBundle);
        expect(text).toContain("foo.txt");
        expect(text).toContain("bar.txt");
        expect(text).toContain("2 files changed");
        expect(text).toContain("2 insertions(+)");
        expect(text).toContain("1 deletion(-)");
    });
    test("handles empty patches", () => {
        expect(renderDiffStat({ seq: 1, baseRef: "", patches: [] })).toContain("0 files changed");
    });
});

describe("runDiffOnce", () => {
    test("maps InvalidRunId from the server to exit 1", async () => {
        const { sqlite, adapter } = await openMemoryDb();
        const stdout = makeStream();
        const stderr = makeStream();
        try {
            const result = await runDiffOnce({
                adapter,
                runId: "!!INVALID!!",
                nodeId: "task:a",
                json: false,
                stat: false,
                color: false,
                stdout,
                stderr,
            });
            expect(result.exitCode).toBe(1);
            expect(stderr.value).toContain("InvalidRunId");
        } finally {
            sqlite.close();
        }
    });

    test("maps InvalidNodeId from the server to exit 1", async () => {
        const { sqlite, adapter } = await openMemoryDb();
        const stdout = makeStream();
        const stderr = makeStream();
        try {
            const result = await runDiffOnce({
                adapter,
                runId: "run-a",
                nodeId: "!!bad!!",
                json: false,
                stat: false,
                color: false,
                stdout,
                stderr,
            });
            expect(result.exitCode).toBe(1);
            expect(stderr.value).toContain("InvalidNodeId");
        } finally {
            sqlite.close();
        }
    });

    test("maps NodeNotFound to exit 1 with a hint", async () => {
        const { sqlite, adapter } = await openMemoryDb();
        const stdout = makeStream();
        const stderr = makeStream();
        try {
            await adapter.insertRun({
                runId: "run-diff",
                workflowName: "wf",
                status: "finished",
                createdAtMs: 1_000,
                startedAtMs: 1_000,
                finishedAtMs: 2_000,
            });
            const result = await runDiffOnce({
                adapter,
                runId: "run-diff",
                nodeId: "task-a",
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
