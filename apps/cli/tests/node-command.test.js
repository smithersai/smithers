import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";
/**
 * @param {ReturnType<typeof createTempRepo>} repo
 */
function openRepoDb(repo) {
    const sqlite = new Database(repo.path("smithers.db"));
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return {
        sqlite,
        adapter: new SmithersDb(db),
    };
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function insertRun(adapter, runId, status = "finished") {
    await adapter.insertRun({
        runId,
        workflowName: "node-fixture",
        status,
        createdAtMs: 1_000,
        startedAtMs: 1_000,
        finishedAtMs: 9_000,
    });
}
/**
 * @param {Database} sqlite
 */
function createOutputTable(sqlite, table = "node_output") {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      confidence REAL,
      summary TEXT
    );`);
}
test("node command shows enriched retry chain details by default", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
        await insertRun(adapter, "node-run", "finished");
        createOutputTable(sqlite);
        await adapter.insertNode({
            runId: "node-run",
            nodeId: "review-step",
            iteration: 0,
            state: "finished",
            lastAttempt: 3,
            updatedAtMs: 5_500,
            outputTable: "node_output",
            label: "Review Step",
        });
        sqlite
            .query("INSERT INTO node_output (run_id, node_id, iteration, confidence, summary) VALUES (?, ?, ?, ?, ?)")
            .run("node-run", "review-step", 0, 0.87, "validated summary");
        await adapter.insertCache({
            cacheKey: "cache-review-step",
            createdAtMs: 5_400,
            workflowName: "node-fixture",
            nodeId: "review-step",
            outputTable: "node_output",
            schemaSig: "sig-1",
            payloadJson: JSON.stringify({
                confidence: 0.87,
                summary: "validated summary",
            }),
        });
        await adapter.insertAttempt({
            runId: "node-run",
            nodeId: "review-step",
            iteration: 0,
            attempt: 1,
            state: "failed",
            startedAtMs: 1_000,
            finishedAtMs: 2_100,
            errorJson: JSON.stringify({
                name: "SchemaValidationError",
                message: "output.confidence must be number",
            }),
            metaJson: JSON.stringify({ kind: "agent", prompt: "first" }),
            responseText: null,
            cached: false,
            jjPointer: null,
            jjCwd: repo.dir,
        });
        await adapter.insertAttempt({
            runId: "node-run",
            nodeId: "review-step",
            iteration: 0,
            attempt: 2,
            state: "failed",
            startedAtMs: 2_200,
            finishedAtMs: 3_000,
            errorJson: JSON.stringify({
                name: "SchemaValidationError",
                message: "output.confidence must be >= 0",
            }),
            metaJson: JSON.stringify({ kind: "agent", prompt: "second" }),
            responseText: null,
            cached: false,
            jjPointer: null,
            jjCwd: repo.dir,
        });
        await adapter.insertAttempt({
            runId: "node-run",
            nodeId: "review-step",
            iteration: 0,
            attempt: 3,
            state: "finished",
            startedAtMs: 3_100,
            finishedAtMs: 5_400,
            errorJson: null,
            metaJson: JSON.stringify({ kind: "agent", prompt: "third" }),
            responseText: "done",
            cached: false,
            jjPointer: null,
            jjCwd: repo.dir,
        });
        await adapter.insertToolCall({
            runId: "node-run",
            nodeId: "review-step",
            iteration: 0,
            attempt: 3,
            seq: 1,
            toolName: "web-search",
            inputJson: JSON.stringify({ query: "schema validation" }),
            outputJson: JSON.stringify({ results: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
            startedAtMs: 3_300,
            finishedAtMs: 4_200,
            status: "success",
            errorJson: null,
        });
        await adapter.insertToolCall({
            runId: "node-run",
            nodeId: "review-step",
            iteration: 0,
            attempt: 3,
            seq: 2,
            toolName: "read-file",
            inputJson: JSON.stringify({ path: "README.md" }),
            outputJson: JSON.stringify({ ok: true }),
            startedAtMs: 4_300,
            finishedAtMs: 4_400,
            status: "success",
            errorJson: null,
        });
        await adapter.insertEventWithNextSeq({
            runId: "node-run",
            timestampMs: 4_450,
            type: "TokenUsageReported",
            payloadJson: JSON.stringify({
                type: "TokenUsageReported",
                runId: "node-run",
                nodeId: "review-step",
                iteration: 0,
                attempt: 3,
                model: "gpt-4o-mini",
                agent: "codex",
                inputTokens: 1204,
                outputTokens: 312,
            }),
        });
        await adapter.insertScorerResult({
            id: "score-1",
            runId: "node-run",
            nodeId: "review-step",
            iteration: 0,
            attempt: 3,
            scorerId: "quality-check",
            scorerName: "quality-check",
            source: "live",
            score: 0.91,
            reason: "high confidence",
            scoredAtMs: 5_450,
        });
        const result = runSmithers(["node", "review-step", "-r", "node-run"], {
            cwd: repo.dir,
            format: null,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Node: review-step (iteration 0)");
        expect(result.stdout).toContain("Status: finished");
        expect(result.stdout).toContain("Attempts: 3");
        expect(result.stdout).toContain("Attempt 1 - failed");
        expect(result.stdout).toContain("output.confidence must be number");
        expect(result.stdout).toContain("Attempt 2 - failed");
        expect(result.stdout).toContain("Attempt 3 - finished");
        expect(result.stdout).toContain("Tokens: 1,204 in / 312 out");
        expect(result.stdout).toContain("web-search");
        expect(result.stdout).toContain("read-file");
        expect(result.stdout).toContain("Output (validated):");
        expect(result.stdout).toContain("Scorer: quality-check -> 0.91");
    }
    finally {
        sqlite.close();
    }
});
test("node command --json returns stable structured fields", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
        await insertRun(adapter, "json-run", "finished");
        createOutputTable(sqlite);
        await adapter.insertNode({
            runId: "json-run",
            nodeId: "node-a",
            iteration: 0,
            state: "finished",
            lastAttempt: 1,
            updatedAtMs: 2_000,
            outputTable: "node_output",
            label: null,
        });
        sqlite
            .query("INSERT INTO node_output (run_id, node_id, iteration, confidence, summary) VALUES (?, ?, ?, ?, ?)")
            .run("json-run", "node-a", 0, 0.5, "ok");
        await adapter.insertAttempt({
            runId: "json-run",
            nodeId: "node-a",
            iteration: 0,
            attempt: 1,
            state: "finished",
            startedAtMs: 1_100,
            finishedAtMs: 1_300,
            errorJson: null,
            metaJson: JSON.stringify({ kind: "agent" }),
            responseText: null,
            cached: false,
            jjPointer: null,
            jjCwd: repo.dir,
        });
        await adapter.insertToolCall({
            runId: "json-run",
            nodeId: "node-a",
            iteration: 0,
            attempt: 1,
            seq: 1,
            toolName: "read-file",
            inputJson: JSON.stringify({ path: "README.md" }),
            outputJson: JSON.stringify({ ok: true }),
            startedAtMs: 1_150,
            finishedAtMs: 1_200,
            status: "success",
            errorJson: null,
        });
        await adapter.insertEventWithNextSeq({
            runId: "json-run",
            timestampMs: 1_250,
            type: "TokenUsageReported",
            payloadJson: JSON.stringify({
                type: "TokenUsageReported",
                runId: "json-run",
                nodeId: "node-a",
                iteration: 0,
                attempt: 1,
                model: "gpt-4o-mini",
                agent: "codex",
                inputTokens: 100,
                outputTokens: 20,
            }),
        });
        await adapter.insertScorerResult({
            id: "score-json",
            runId: "json-run",
            nodeId: "node-a",
            iteration: 0,
            attempt: 1,
            scorerId: "quality",
            scorerName: "quality",
            source: "live",
            score: 0.75,
            reason: null,
            scoredAtMs: 1_350,
        });
        const result = runSmithers(["node", "node-a", "-r", "json-run", "--json"], {
            cwd: repo.dir,
            format: null,
        });
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.node).toBeDefined();
        expect(parsed.attempts).toBeDefined();
        expect(parsed.toolCalls).toBeDefined();
        expect(parsed.tokenUsage).toBeDefined();
        expect(parsed.scorers).toBeDefined();
        expect(parsed.output).toBeDefined();
    }
    finally {
        sqlite.close();
    }
});
test("node command summarizes long retry chains by default and expands with --attempts", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
        await insertRun(adapter, "retry-run", "failed");
        await adapter.insertNode({
            runId: "retry-run",
            nodeId: "flaky-node",
            iteration: 0,
            state: "failed",
            lastAttempt: 50,
            updatedAtMs: 50_000,
            outputTable: "node_output",
            label: null,
        });
        for (let attempt = 1; attempt <= 50; attempt += 1) {
            let state = "failed";
            if (attempt === 48 || attempt === 49)
                state = "cancelled";
            if (attempt === 50)
                state = "finished";
            await adapter.insertAttempt({
                runId: "retry-run",
                nodeId: "flaky-node",
                iteration: 0,
                attempt,
                state,
                startedAtMs: attempt * 100,
                finishedAtMs: attempt * 100 + 50,
                errorJson: state === "failed"
                    ? JSON.stringify({ message: `attempt ${attempt} failed` })
                    : null,
                metaJson: JSON.stringify({ kind: "agent" }),
                responseText: null,
                cached: false,
                jjPointer: null,
                jjCwd: repo.dir,
            });
        }
        const compact = runSmithers(["node", "flaky-node", "-r", "retry-run"], {
            cwd: repo.dir,
            format: null,
        });
        expect(compact.exitCode).toBe(0);
        expect(compact.stdout).toContain("49 prior attempts (47 failed, 2 cancelled)");
        expect(compact.stdout).not.toContain("Attempt 1 - failed");
        const expanded = runSmithers(["node", "flaky-node", "-r", "retry-run", "--attempts"], {
            cwd: repo.dir,
            format: null,
        });
        expect(expanded.exitCode).toBe(0);
        expect(expanded.stdout).toContain("Attempt 1 - failed");
        expect(expanded.stdout).toContain("Attempt 50 - finished");
    }
    finally {
        sqlite.close();
    }
});
test("node command --tools expands tool payloads and truncates large output", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
        await insertRun(adapter, "tools-run", "finished");
        await adapter.insertNode({
            runId: "tools-run",
            nodeId: "tools-node",
            iteration: 0,
            state: "finished",
            lastAttempt: 1,
            updatedAtMs: 3_000,
            outputTable: "node_output",
            label: null,
        });
        await adapter.insertAttempt({
            runId: "tools-run",
            nodeId: "tools-node",
            iteration: 0,
            attempt: 1,
            state: "finished",
            startedAtMs: 2_000,
            finishedAtMs: 2_800,
            errorJson: null,
            metaJson: JSON.stringify({ kind: "agent" }),
            responseText: null,
            cached: false,
            jjPointer: null,
            jjCwd: repo.dir,
        });
        await adapter.insertToolCall({
            runId: "tools-run",
            nodeId: "tools-node",
            iteration: 0,
            attempt: 1,
            seq: 1,
            toolName: "web-search",
            inputJson: JSON.stringify({ query: "large payload" }),
            outputJson: JSON.stringify({ blob: "x".repeat(100_000) }),
            startedAtMs: 2_100,
            finishedAtMs: 2_500,
            status: "success",
            errorJson: null,
        });
        const result = runSmithers(["node", "tools-node", "-r", "tools-run", "--tools"], {
            cwd: repo.dir,
            format: null,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Input:");
        expect(result.stdout).toContain("Output:");
        expect(result.stdout).toContain("truncated, use --json for full output");
    }
    finally {
        sqlite.close();
    }
});
test("node command handles pending node with no attempts", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
        await insertRun(adapter, "pending-run", "running");
        await adapter.insertNode({
            runId: "pending-run",
            nodeId: "queued-node",
            iteration: 0,
            state: "pending",
            lastAttempt: null,
            updatedAtMs: 2_000,
            outputTable: "node_output",
            label: null,
        });
        const result = runSmithers(["node", "queued-node", "-r", "pending-run"], {
            cwd: repo.dir,
            format: null,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Status: pending");
        expect(result.stdout).toContain("Attempts: 0");
    }
    finally {
        sqlite.close();
    }
});
test("node command resolves latest iteration by default and supports --iteration", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
        await insertRun(adapter, "loop-run", "finished");
        for (let iteration = 0; iteration < 5; iteration += 1) {
            await adapter.insertNode({
                runId: "loop-run",
                nodeId: "looped-node",
                iteration,
                state: iteration === 4 ? "finished" : "failed",
                lastAttempt: 1,
                updatedAtMs: 3_000 + iteration,
                outputTable: "node_output",
                label: null,
            });
            await adapter.insertAttempt({
                runId: "loop-run",
                nodeId: "looped-node",
                iteration,
                attempt: 1,
                state: iteration === 4 ? "finished" : "failed",
                startedAtMs: 1_000 + iteration * 10,
                finishedAtMs: 1_010 + iteration * 10,
                errorJson: iteration === 4
                    ? null
                    : JSON.stringify({ message: `iteration ${iteration} failed` }),
                metaJson: JSON.stringify({ kind: "agent" }),
                responseText: null,
                cached: false,
                jjPointer: null,
                jjCwd: repo.dir,
            });
        }
        const latest = runSmithers(["node", "looped-node", "-r", "loop-run"], {
            cwd: repo.dir,
            format: null,
        });
        expect(latest.exitCode).toBe(0);
        expect(latest.stdout).toContain("Node: looped-node (iteration 4)");
        const selected = runSmithers(["node", "looped-node", "-r", "loop-run", "--iteration", "2"], {
            cwd: repo.dir,
            format: null,
        });
        expect(selected.exitCode).toBe(0);
        expect(selected.stdout).toContain("Node: looped-node (iteration 2)");
    }
    finally {
        sqlite.close();
    }
});
test("node command reports non-existent node", async () => {
    const repo = createTempRepo();
    const { sqlite, adapter } = openRepoDb(repo);
    try {
        await insertRun(adapter, "missing-node-run", "finished");
        const result = runSmithers(["node", "bad-node", "-r", "missing-node-run"], {
            cwd: repo.dir,
            format: null,
        });
        expect(result.exitCode).toBe(4);
        expect(result.stdout).toContain("Node not found: bad-node");
    }
    finally {
        sqlite.close();
    }
});
