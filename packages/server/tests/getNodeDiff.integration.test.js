import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers/db/ensure";
import { SmithersDb } from "@smithers/db/adapter";
import { getNodeDiffRoute } from "../src/gatewayRoutes/getNodeDiff.js";
function run(cwd, cmd, args) {
    const res = spawnSync(cmd, args, {
        cwd,
        encoding: "utf8",
    });
    if (res.status !== 0) {
        throw new Error(`${cmd} ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
    }
    return (res.stdout ?? "").trim();
}
function hasJj() {
    const res = spawnSync("jj", ["--version"], { encoding: "utf8" });
    return res.status === 0;
}
function setupDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return {
        sqlite,
        adapter: new SmithersDb(db),
    };
}
describe("getNodeDiffRoute integration (real jj)", () => {
    test("returns a real patch for a task-scoped change", async () => {
        if (!hasJj()) {
            expect(true).toBe(true);
            return;
        }
        const repoDir = mkdtempSync(join(tmpdir(), "smithers-node-diff-integration-"));
        const { sqlite, adapter } = setupDb();
        try {
            run(repoDir, "jj", ["git", "init"]);
            writeFileSync(join(repoDir, "foo.txt"), "base\n");
            run(repoDir, "jj", ["new"]);
            const baseRef = run(repoDir, "jj", [
                "log",
                "-r",
                "@-",
                "--no-graph",
                "--template",
                "commit_id",
            ]);
            writeFileSync(join(repoDir, "foo.txt"), "base\nadded by task\n");
            run(repoDir, "jj", ["new"]);
            const attemptEndRef = run(repoDir, "jj", [
                "log",
                "-r",
                "@-",
                "--no-graph",
                "--template",
                "commit_id",
            ]);
            writeFileSync(join(repoDir, "foo.txt"), "base\nadded by task\npost attempt\n");
            run(repoDir, "jj", ["new"]);
            const runId = "run-jj-integration";
            const nodeId = "task:write-file";
            await adapter.insertRun({
                runId,
                workflowName: "integration",
                status: "finished",
                createdAtMs: Date.now(),
                startedAtMs: Date.now() - 10_000,
                finishedAtMs: Date.now() - 1_000,
                vcsRevision: baseRef,
            });
            await adapter.insertNode({
                runId,
                nodeId,
                iteration: 0,
                state: "finished",
                lastAttempt: 1,
                updatedAtMs: Date.now() - 1_000,
                outputTable: "out",
                label: null,
            });
            await adapter.insertAttempt({
                runId,
                nodeId,
                iteration: 0,
                attempt: 1,
                state: "finished",
                startedAtMs: Date.now() - 8_000,
                finishedAtMs: Date.now() - 7_000,
                heartbeatAtMs: null,
                heartbeatDataJson: null,
                errorJson: null,
                jjPointer: attemptEndRef,
                responseText: null,
                jjCwd: repoDir,
                cached: false,
                metaJson: null,
            });
            const result = await getNodeDiffRoute({
                runId,
                nodeId,
                iteration: 0,
                resolveRun: async (id) => (id === runId ? { adapter } : null),
                emitEffect: async () => undefined,
            });
            expect(result.ok).toBe(true);
            if (result.ok) {
                const patchText = result.payload.patches.map((patch) => patch.diff).join("\n");
                expect(result.payload.patches.length).toBeGreaterThan(0);
                expect(patchText).toContain("foo.txt");
                expect(patchText).toContain("+added by task");
            }
        }
        finally {
            sqlite.close();
            rmSync(repoDir, { force: true, recursive: true });
        }
    });
});
