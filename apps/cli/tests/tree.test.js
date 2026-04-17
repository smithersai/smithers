import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers/db/adapter";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { renderDevToolsTree, selectSubtree, runTreeOnce, runTreeWatch } from "../src/tree.js";

function makeSnapshot() {
    return {
        version: 1,
        runId: "run-1",
        frameNo: 3,
        seq: 3,
        root: {
            id: 1,
            type: "workflow",
            name: "root",
            props: {},
            children: [
                {
                    id: 2,
                    type: "sequence",
                    name: "seq",
                    props: { label: "outer" },
                    children: [
                        {
                            id: 3,
                            type: "task",
                            name: "task-a",
                            props: {},
                            task: { nodeId: "task-a", kind: "agent", iteration: 0 },
                            children: [],
                            depth: 2,
                        },
                    ],
                    depth: 1,
                },
            ],
            depth: 0,
        },
    };
}

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

describe("renderDevToolsTree", () => {
    test("renders a nested tree with open and close tags", () => {
        const text = renderDevToolsTree(makeSnapshot(), { color: false });
        expect(text).toContain("<workflow");
        expect(text).toContain("<sequence");
        expect(text).toContain("<task");
        expect(text).toContain("</workflow>");
        expect(text).toContain("</sequence>");
        expect(text).toContain("</task>");
    });

    test("includes nodeId and kind for task nodes", () => {
        const text = renderDevToolsTree(makeSnapshot(), { color: false });
        expect(text).toContain('nodeId="task-a"');
        expect(text).toContain('kind="agent"');
    });

    test("respects the depth limit by truncating deeper nodes", () => {
        const text = renderDevToolsTree(makeSnapshot(), { color: false, depth: 1 });
        expect(text).toContain("hidden");
        expect(text).not.toContain("<task");
    });

    test("scopes to a subtree when nodeId is set", () => {
        const text = renderDevToolsTree(makeSnapshot(), { color: false, nodeId: "task-a" });
        expect(text).toContain("<task");
        expect(text).not.toContain("<workflow");
    });

    test("emits ANSI escapes when color=true and none when false", () => {
        const colored = renderDevToolsTree(makeSnapshot(), { color: true });
        const plain = renderDevToolsTree(makeSnapshot(), { color: false });
        expect(colored).toContain("\u001b[");
        expect(plain).not.toContain("\u001b[");
    });
});

describe("selectSubtree", () => {
    test("returns null for missing ids", () => {
        expect(selectSubtree(makeSnapshot().root, "no-such-id")).toBeNull();
    });
    test("locates descendants by task.nodeId", () => {
        const node = selectSubtree(makeSnapshot().root, "task-a");
        expect(node).not.toBeNull();
        expect(node.task?.nodeId).toBe("task-a");
    });
});

describe("runTreeOnce", () => {
    test("returns exit 1 with user-friendly error when run is missing", async () => {
        const { sqlite, adapter } = await openMemoryDb();
        const stdout = makeStream();
        const stderr = makeStream();
        try {
            const result = await runTreeOnce({
                adapter,
                runId: "missing-run",
                json: false,
                watch: false,
                color: false,
                stdout,
                stderr,
            });
            expect(result.exitCode).toBe(1);
            expect(stderr.value).toContain("RunNotFound");
            expect(stdout.value).toBe("");
        } finally {
            sqlite.close();
        }
    });

    test("returns exit 1 with InvalidRunId for malformed run ids", async () => {
        const { sqlite, adapter } = await openMemoryDb();
        const stdout = makeStream();
        const stderr = makeStream();
        try {
            const result = await runTreeOnce({
                adapter,
                runId: "INVALID!!!",
                json: false,
                watch: false,
                color: false,
                stdout,
                stderr,
            });
            expect(result.exitCode).toBe(1);
            expect(stderr.value).toContain("InvalidRunId");
            expect(stderr.value).toContain("hint:");
        } finally {
            sqlite.close();
        }
    });

    test("renders a run with no frames as an empty tree", async () => {
        const { sqlite, adapter } = await openMemoryDb();
        await adapter.insertRun({
            runId: "empty-run",
            workflowName: "wf",
            status: "running",
            createdAtMs: 1_000,
            startedAtMs: 1_000,
            finishedAtMs: null,
        });
        const stdout = makeStream();
        const stderr = makeStream();
        try {
            const result = await runTreeOnce({
                adapter,
                runId: "empty-run",
                json: false,
                watch: false,
                color: false,
                stdout,
                stderr,
            });
            expect(result.exitCode).toBe(0);
            expect(stdout.value).toContain("<workflow");
            expect(stderr.value).toBe("");
        } finally {
            sqlite.close();
        }
    });

    test("SIGINT (abortSignal.abort) exits with 130 and stops the stream", async () => {
        const { sqlite, adapter } = await openMemoryDb();
        await adapter.insertRun({
            runId: "watch-abort-run",
            workflowName: "wf",
            status: "running",
            createdAtMs: 1_000,
            startedAtMs: 1_000,
            finishedAtMs: null,
        });
        const stdout = makeStream();
        const stderr = makeStream();
        const abort = new AbortController();
        // Abort immediately so the stream loop exits on its first check.
        queueMicrotask(() => abort.abort());
        try {
            const result = await runTreeWatch({
                adapter,
                runId: "watch-abort-run",
                json: true,
                watch: true,
                color: false,
                stdout,
                stderr,
                abortSignal: abort.signal,
            });
            expect(result.exitCode).toBe(130);
        } finally {
            sqlite.close();
        }
    });

    test("--json emits parseable JSON", async () => {
        const { sqlite, adapter } = await openMemoryDb();
        await adapter.insertRun({
            runId: "empty-run",
            workflowName: "wf",
            status: "running",
            createdAtMs: 1_000,
            startedAtMs: 1_000,
            finishedAtMs: null,
        });
        const stdout = makeStream();
        const stderr = makeStream();
        try {
            const result = await runTreeOnce({
                adapter,
                runId: "empty-run",
                json: true,
                watch: false,
                color: false,
                stdout,
                stderr,
            });
            expect(result.exitCode).toBe(0);
            const parsed = JSON.parse(stdout.value);
            expect(parsed.version).toBe(1);
            expect(parsed.runId).toBe("empty-run");
            expect(parsed.root).toBeDefined();
        } finally {
            sqlite.close();
        }
    });
});
