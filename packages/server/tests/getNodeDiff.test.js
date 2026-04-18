import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { getNodeDiffRoute } from "../src/gatewayRoutes/getNodeDiff.js";
function createTestDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return {
        sqlite,
        adapter: new SmithersDb(db),
    };
}
function runRow(runId, extra = {}) {
    return {
        runId,
        workflowName: "node-diff-test",
        status: "running",
        createdAtMs: Date.now(),
        ...extra,
    };
}
function nodeRow(runId, nodeId, iteration = 0, extra = {}) {
    return {
        runId,
        nodeId,
        iteration,
        state: "finished",
        lastAttempt: 1,
        updatedAtMs: Date.now(),
        outputTable: "out",
        label: null,
        ...extra,
    };
}
function attemptRow(runId, nodeId, iteration = 0, extra = {}) {
    return {
        runId,
        nodeId,
        iteration,
        attempt: 1,
        state: "finished",
        startedAtMs: Date.now() - 1_000,
        finishedAtMs: Date.now() - 500,
        heartbeatAtMs: null,
        heartbeatDataJson: null,
        errorJson: null,
        jjPointer: "end-ref",
        responseText: null,
        jjCwd: "/tmp/node-diff-test",
        cached: false,
        metaJson: null,
        ...extra,
    };
}
describe("getNodeDiffRoute", () => {
    test("valid request cache miss returns DiffBundle", async () => {
        const { sqlite, adapter } = createTestDb();
        const runId = "run-diff-miss";
        const nodeId = "task:diff";
        await adapter.insertRun(runRow(runId, { vcsRevision: "base-ref" }));
        await adapter.insertNode(nodeRow(runId, nodeId));
        await adapter.insertAttempt(attemptRow(runId, nodeId, 0));
        let computeCalls = 0;
        const result = await getNodeDiffRoute({
            runId,
            nodeId,
            iteration: 0,
            resolveRun: async (id) => (id === runId ? { adapter } : null),
            computeDiffBundleImpl: async (baseRef, cwd, seq) => {
                computeCalls += 1;
                return {
                    seq: seq ?? 1,
                    baseRef,
                    patches: [{ path: "foo.txt", operation: "modify", diff: `cwd:${cwd}` }],
                };
            },
            getCurrentPointerImpl: async () => "end-ref",
            resolveCommitPointerImpl: async (pointer) => pointer,
            restorePointerImpl: async () => ({ success: true }),
            emitEffect: async () => undefined,
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.payload.baseRef).toBe("base-ref");
            expect(result.payload.patches).toHaveLength(1);
        }
        expect(computeCalls).toBe(1);
        const cached = await adapter.getNodeDiffCache(runId, nodeId, 0, "base-ref");
        expect(cached).toBeDefined();
        sqlite.close();
    });
    test("valid request cache hit returns cached bundle without VCS call", async () => {
        const { sqlite, adapter } = createTestDb();
        const runId = "run-diff-hit";
        const nodeId = "task:diff";
        await adapter.insertRun(runRow(runId, { vcsRevision: "base-ref-hit" }));
        await adapter.insertNode(nodeRow(runId, nodeId));
        await adapter.insertAttempt(attemptRow(runId, nodeId, 0));
        await getNodeDiffRoute({
            runId,
            nodeId,
            iteration: 0,
            resolveRun: async () => ({ adapter }),
            computeDiffBundleImpl: async (baseRef) => ({
                seq: 1,
                baseRef,
                patches: [{ path: "a", operation: "modify", diff: "x" }],
            }),
            getCurrentPointerImpl: async () => "end-ref",
            resolveCommitPointerImpl: async (pointer) => pointer,
            restorePointerImpl: async () => ({ success: true }),
            emitEffect: async () => undefined,
        });
        let computeCalls = 0;
        let resolvePointerCalls = 0;
        let restoreCalls = 0;
        const result = await getNodeDiffRoute({
            runId,
            nodeId,
            iteration: 0,
            resolveRun: async () => ({ adapter }),
            computeDiffBundleImpl: async () => {
                computeCalls += 1;
                throw new Error("compute should not run on cache hit");
            },
            getCurrentPointerImpl: async () => {
                throw new Error("VCS pointer should not be queried on cache hit");
            },
            resolveCommitPointerImpl: async () => {
                resolvePointerCalls += 1;
                throw new Error("commit pointer should not be resolved on cache hit");
            },
            restorePointerImpl: async () => {
                restoreCalls += 1;
                throw new Error("restore should not run on cache hit");
            },
            emitEffect: async () => undefined,
        });
        expect(result.ok).toBe(true);
        expect(computeCalls).toBe(0);
        expect(resolvePointerCalls).toBe(0);
        expect(restoreCalls).toBe(0);
        sqlite.close();
    });
    test("AttemptNotFinished is returned for in-progress attempts", async () => {
        const { sqlite, adapter } = createTestDb();
        const runId = "run-diff-not-finished";
        const nodeId = "task:running";
        await adapter.insertRun(runRow(runId, { vcsRevision: "base-ref-running" }));
        await adapter.insertNode(nodeRow(runId, nodeId, 0, { state: "in-progress" }));
        await adapter.insertAttempt(attemptRow(runId, nodeId, 0, {
            state: "in-progress",
            finishedAtMs: null,
            jjPointer: null,
        }));
        const result = await getNodeDiffRoute({
            runId,
            nodeId,
            iteration: 0,
            resolveRun: async () => ({ adapter }),
            emitEffect: async () => undefined,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.code).toBe("AttemptNotFinished");
        }
        sqlite.close();
    });
    test("10 concurrent identical calls do one compute and write one cache row", async () => {
        const { sqlite, adapter } = createTestDb();
        const runId = "run-diff-flight";
        const nodeId = "task:flight";
        await adapter.insertRun(runRow(runId, { vcsRevision: "base-flight" }));
        await adapter.insertNode(nodeRow(runId, nodeId));
        await adapter.insertAttempt(attemptRow(runId, nodeId, 0));
        let computeCalls = 0;
        const calls = Array.from({ length: 10 }, () => getNodeDiffRoute({
            runId,
            nodeId,
            iteration: 0,
            resolveRun: async () => ({ adapter }),
            computeDiffBundleImpl: async (baseRef, _cwd, seq) => {
                computeCalls += 1;
                await Bun.sleep(20);
                return {
                    seq: seq ?? 1,
                    baseRef,
                    patches: [{ path: "f", operation: "modify", diff: "hunk" }],
                };
            },
            getCurrentPointerImpl: async () => "end-ref",
            resolveCommitPointerImpl: async (pointer) => pointer,
            restorePointerImpl: async () => ({ success: true }),
            emitEffect: async () => undefined,
        }));
        const results = await Promise.all(calls);
        expect(results.every((entry) => entry.ok)).toBe(true);
        expect(computeCalls).toBe(1);
        const row = sqlite
            .query(`SELECT COUNT(*) AS count FROM _smithers_node_diffs WHERE run_id = ? AND node_id = ? AND iteration = ?`)
            .get(runId, nodeId, 0);
        expect(Number(row?.count ?? 0)).toBe(1);
        sqlite.close();
    });
    test("input boundaries return typed validation errors", async () => {
        const resolveRun = async () => null;
        const invalidRun = await getNodeDiffRoute({
            runId: "",
            nodeId: "task:1",
            iteration: 0,
            resolveRun,
            emitEffect: async () => undefined,
        });
        const invalidNode = await getNodeDiffRoute({
            runId: "run_ok",
            nodeId: "task;rm -rf",
            iteration: 0,
            resolveRun,
            emitEffect: async () => undefined,
        });
        const invalidIterationNegative = await getNodeDiffRoute({
            runId: "run_ok",
            nodeId: "task:1",
            iteration: -1,
            resolveRun,
            emitEffect: async () => undefined,
        });
        const invalidIterationOverflow = await getNodeDiffRoute({
            runId: "run_ok",
            nodeId: "task:1",
            iteration: 2_147_483_648,
            resolveRun,
            emitEffect: async () => undefined,
        });
        expect(invalidRun.ok).toBe(false);
        if (!invalidRun.ok)
            expect(invalidRun.error.code).toBe("InvalidRunId");
        expect(invalidNode.ok).toBe(false);
        if (!invalidNode.ok)
            expect(invalidNode.error.code).toBe("InvalidNodeId");
        expect(invalidIterationNegative.ok).toBe(false);
        if (!invalidIterationNegative.ok)
            expect(invalidIterationNegative.error.code).toBe("InvalidIteration");
        expect(invalidIterationOverflow.ok).toBe(false);
        if (!invalidIterationOverflow.ok)
            expect(invalidIterationOverflow.error.code).toBe("InvalidIteration");
    });
    test("runId > 64 chars returns InvalidRunId", async () => {
        const result = await getNodeDiffRoute({
            runId: "a".repeat(65),
            nodeId: "task:1",
            iteration: 0,
            resolveRun: async () => null,
            emitEffect: async () => undefined,
        });
        expect(result.ok).toBe(false);
        if (!result.ok)
            expect(result.error.code).toBe("InvalidRunId");
    });
    test("empty nodeId returns InvalidNodeId", async () => {
        const result = await getNodeDiffRoute({
            runId: "run_ok",
            nodeId: "",
            iteration: 0,
            resolveRun: async () => null,
            emitEffect: async () => undefined,
        });
        expect(result.ok).toBe(false);
        if (!result.ok)
            expect(result.error.code).toBe("InvalidNodeId");
    });
    test("nodeId > 128 chars returns InvalidNodeId", async () => {
        const result = await getNodeDiffRoute({
            runId: "run_ok",
            nodeId: "a".repeat(129),
            iteration: 0,
            resolveRun: async () => null,
            emitEffect: async () => undefined,
        });
        expect(result.ok).toBe(false);
        if (!result.ok)
            expect(result.error.code).toBe("InvalidNodeId");
    });
    test("cross-run request returns RunNotFound when scope does not match", async () => {
        const { sqlite, adapter } = createTestDb();
        const runId = "run-scope-ok";
        await adapter.insertRun(runRow(runId, { vcsRevision: "base" }));
        await adapter.insertNode(nodeRow(runId, "task:x"));
        await adapter.insertAttempt(attemptRow(runId, "task:x", 0));
        const result = await getNodeDiffRoute({
            runId: "run-scope-other",
            nodeId: "task:x",
            iteration: 0,
            resolveRun: async (id) => (id === runId ? { adapter } : null),
            emitEffect: async () => undefined,
        });
        expect(result.ok).toBe(false);
        if (!result.ok)
            expect(result.error.code).toBe("RunNotFound");
        sqlite.close();
    });
    test("iteration on task that never ran returns AttemptNotFound", async () => {
        const { sqlite, adapter } = createTestDb();
        const runId = "run-no-attempt";
        const nodeId = "task:no-attempt";
        await adapter.insertRun(runRow(runId, { vcsRevision: "base" }));
        await adapter.insertNode(nodeRow(runId, nodeId));
        const result = await getNodeDiffRoute({
            runId,
            nodeId,
            iteration: 0,
            resolveRun: async () => ({ adapter }),
            emitEffect: async () => undefined,
        });
        expect(result.ok).toBe(false);
        if (!result.ok)
            expect(result.error.code).toBe("AttemptNotFound");
        sqlite.close();
    });
    test("NodeNotFound is returned for unknown nodeId", async () => {
        const { sqlite, adapter } = createTestDb();
        const runId = "run-no-node";
        await adapter.insertRun(runRow(runId, { vcsRevision: "base" }));
        const result = await getNodeDiffRoute({
            runId,
            nodeId: "task:missing",
            iteration: 0,
            resolveRun: async () => ({ adapter }),
            emitEffect: async () => undefined,
        });
        expect(result.ok).toBe(false);
        if (!result.ok)
            expect(result.error.code).toBe("NodeNotFound");
        sqlite.close();
    });
    test("empty patches are returned when task finished without file changes", async () => {
        const { sqlite, adapter } = createTestDb();
        const runId = "run-empty-diff";
        const nodeId = "task:empty";
        await adapter.insertRun(runRow(runId, { vcsRevision: "base-empty" }));
        await adapter.insertNode(nodeRow(runId, nodeId));
        await adapter.insertAttempt(attemptRow(runId, nodeId, 0));
        const result = await getNodeDiffRoute({
            runId,
            nodeId,
            iteration: 0,
            resolveRun: async () => ({ adapter }),
            computeDiffBundleImpl: async (baseRef, _cwd, seq) => ({
                seq: seq ?? 1,
                baseRef,
                patches: [],
            }),
            getCurrentPointerImpl: async () => "end-ref",
            resolveCommitPointerImpl: async (pointer) => pointer,
            restorePointerImpl: async () => ({ success: true }),
            emitEffect: async () => undefined,
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.payload.patches).toHaveLength(0);
        }
        sqlite.close();
    });
    test("100 files changed yields all patches in bundle", async () => {
        const { sqlite, adapter } = createTestDb();
        const runId = "run-many-files";
        const nodeId = "task:many";
        await adapter.insertRun(runRow(runId, { vcsRevision: "base-many" }));
        await adapter.insertNode(nodeRow(runId, nodeId));
        await adapter.insertAttempt(attemptRow(runId, nodeId, 0));
        const result = await getNodeDiffRoute({
            runId,
            nodeId,
            iteration: 0,
            resolveRun: async () => ({ adapter }),
            computeDiffBundleImpl: async (baseRef, _cwd, seq) => ({
                seq: seq ?? 1,
                baseRef,
                patches: Array.from({ length: 100 }, (_unused, idx) => ({
                    path: `file-${idx}.txt`,
                    operation: "modify",
                    diff: `hunk-${idx}`,
                })),
            }),
            getCurrentPointerImpl: async () => "end-ref",
            resolveCommitPointerImpl: async (pointer) => pointer,
            restorePointerImpl: async () => ({ success: true }),
            emitEffect: async () => undefined,
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.payload.patches).toHaveLength(100);
        }
        sqlite.close();
    });
    test("binary file changes populate binaryContent on patch", async () => {
        const { sqlite, adapter } = createTestDb();
        const runId = "run-binary";
        const nodeId = "task:binary";
        await adapter.insertRun(runRow(runId, { vcsRevision: "base-binary" }));
        await adapter.insertNode(nodeRow(runId, nodeId));
        await adapter.insertAttempt(attemptRow(runId, nodeId, 0));
        const result = await getNodeDiffRoute({
            runId,
            nodeId,
            iteration: 0,
            resolveRun: async () => ({ adapter }),
            computeDiffBundleImpl: async (baseRef, _cwd, seq) => ({
                seq: seq ?? 1,
                baseRef,
                patches: [
                    {
                        path: "image.png",
                        operation: "modify",
                        diff: "",
                        binaryContent: "base64data",
                    },
                ],
            }),
            getCurrentPointerImpl: async () => "end-ref",
            resolveCommitPointerImpl: async (pointer) => pointer,
            restorePointerImpl: async () => ({ success: true }),
            emitEffect: async () => undefined,
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.payload.patches[0].binaryContent).toBe("base64data");
        }
        sqlite.close();
    });
    test("rename operation is reflected in patch", async () => {
        const { sqlite, adapter } = createTestDb();
        const runId = "run-rename";
        const nodeId = "task:rename";
        await adapter.insertRun(runRow(runId, { vcsRevision: "base-rename" }));
        await adapter.insertNode(nodeRow(runId, nodeId));
        await adapter.insertAttempt(attemptRow(runId, nodeId, 0));
        const result = await getNodeDiffRoute({
            runId,
            nodeId,
            iteration: 0,
            resolveRun: async () => ({ adapter }),
            computeDiffBundleImpl: async (baseRef, _cwd, seq) => ({
                seq: seq ?? 1,
                baseRef,
                patches: [
                    {
                        path: "new-name.txt",
                        oldPath: "old-name.txt",
                        operation: "rename",
                        diff: "similarity index 100%",
                    },
                ],
            }),
            getCurrentPointerImpl: async () => "end-ref",
            resolveCommitPointerImpl: async (pointer) => pointer,
            restorePointerImpl: async () => ({ success: true }),
            emitEffect: async () => undefined,
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            const patch = result.payload.patches[0];
            expect(patch.operation).toBe("rename");
            expect(patch.oldPath).toBe("old-name.txt");
        }
        sqlite.close();
    });
    test("non-UTF8 filenames survive round-trip through the diff bundle", async () => {
        const { sqlite, adapter } = createTestDb();
        const runId = "run-unicode";
        const nodeId = "task:unicode";
        await adapter.insertRun(runRow(runId, { vcsRevision: "base-unicode" }));
        await adapter.insertNode(nodeRow(runId, nodeId));
        await adapter.insertAttempt(attemptRow(runId, nodeId, 0));
        const tricky = "résumé-✓-日本語.txt";
        const result = await getNodeDiffRoute({
            runId,
            nodeId,
            iteration: 0,
            resolveRun: async () => ({ adapter }),
            computeDiffBundleImpl: async (baseRef, _cwd, seq) => ({
                seq: seq ?? 1,
                baseRef,
                patches: [
                    {
                        path: tricky,
                        operation: "add",
                        diff: `+${tricky}`,
                    },
                ],
            }),
            getCurrentPointerImpl: async () => "end-ref",
            resolveCommitPointerImpl: async (pointer) => pointer,
            restorePointerImpl: async () => ({ success: true }),
            emitEffect: async () => undefined,
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.payload.patches[0].path).toBe(tricky);
        }
        const cached = await adapter.getNodeDiffCache(runId, nodeId, 0, "base-unicode");
        expect(cached?.diffJson).toContain("résumé");
        sqlite.close();
    });
    test("diff exceeding max bytes returns DiffTooLarge", async () => {
        const { sqlite, adapter } = createTestDb();
        const runId = "run-too-large";
        const nodeId = "task:big";
        await adapter.insertRun(runRow(runId, { vcsRevision: "base-big" }));
        await adapter.insertNode(nodeRow(runId, nodeId));
        await adapter.insertAttempt(attemptRow(runId, nodeId, 0));
        const giant = "A".repeat(51 * 1024 * 1024);
        const result = await getNodeDiffRoute({
            runId,
            nodeId,
            iteration: 0,
            resolveRun: async () => ({ adapter }),
            computeDiffBundleImpl: async (baseRef, _cwd, seq) => ({
                seq: seq ?? 1,
                baseRef,
                patches: [{ path: "big.txt", operation: "modify", diff: giant }],
            }),
            getCurrentPointerImpl: async () => "end-ref",
            resolveCommitPointerImpl: async (pointer) => pointer,
            restorePointerImpl: async () => ({ success: true }),
            emitEffect: async () => undefined,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.code).toBe("DiffTooLarge");
            expect(result.error.message).toContain("truncated");
        }
        sqlite.close();
    });
    test("VcsError is surfaced when computeDiffBundle fails with generic vcs message", async () => {
        const { sqlite, adapter } = createTestDb();
        const runId = "run-vcs-err";
        const nodeId = "task:vcs";
        await adapter.insertRun(runRow(runId, { vcsRevision: "base-vcs" }));
        await adapter.insertNode(nodeRow(runId, nodeId));
        await adapter.insertAttempt(attemptRow(runId, nodeId, 0));
        const result = await getNodeDiffRoute({
            runId,
            nodeId,
            iteration: 0,
            resolveRun: async () => ({ adapter }),
            computeDiffBundleImpl: async () => {
                throw new Error("network down");
            },
            resolveCommitPointerImpl: async (pointer) => pointer,
            emitEffect: async () => undefined,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.code).toBe("VcsError");
        }
        sqlite.close();
    });
    test("WorkingTreeDirty is returned when compute surfaces a dirty working copy", async () => {
        const { sqlite, adapter } = createTestDb();
        const runId = "run-wt-dirty";
        const nodeId = "task:dirty";
        await adapter.insertRun(runRow(runId, { vcsRevision: "base-dirty" }));
        await adapter.insertNode(nodeRow(runId, nodeId));
        await adapter.insertAttempt(attemptRow(runId, nodeId, 0));
        const result = await getNodeDiffRoute({
            runId,
            nodeId,
            iteration: 0,
            resolveRun: async () => ({ adapter }),
            computeDiffBundleImpl: async () => {
                throw new Error("working copy has conflicts, cannot restore");
            },
            resolveCommitPointerImpl: async (pointer) => pointer,
            emitEffect: async () => undefined,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.code).toBe("WorkingTreeDirty");
        }
        sqlite.close();
    });
    test("Blocker #1: retry attempt does not pick another node's attempt as base", async () => {
        const { sqlite, adapter } = createTestDb();
        const runId = "run-retry-base";
        const cwd = "/tmp/retry-base";
        const nodeA = "task:A";
        const nodeB = "task:B";
        await adapter.insertRun(runRow(runId, { vcsRevision: "base-run" }));
        await adapter.insertNode(nodeRow(runId, nodeA, 0, { lastAttempt: 1 }));
        await adapter.insertNode(nodeRow(runId, nodeB, 0, { lastAttempt: 2 }));
        // Node A attempt 1 finishes first.
        await adapter.insertAttempt(attemptRow(runId, nodeA, 0, {
            attempt: 1,
            startedAtMs: 1_000,
            finishedAtMs: 1_500,
            jjPointer: "ptr-A1",
            jjCwd: cwd,
        }));
        // Node B attempt 1 runs next.
        await adapter.insertAttempt(attemptRow(runId, nodeB, 0, {
            attempt: 1,
            startedAtMs: 1_600,
            finishedAtMs: 2_000,
            jjPointer: "ptr-B1",
            jjCwd: cwd,
        }));
        // Node B retries — attempt 2 is the one we ask for a diff of.
        await adapter.insertAttempt(attemptRow(runId, nodeB, 0, {
            attempt: 2,
            startedAtMs: 2_100,
            finishedAtMs: 2_500,
            jjPointer: "ptr-B2",
            jjCwd: cwd,
        }));
        let seenBaseRef = null;
        const result = await getNodeDiffRoute({
            runId,
            nodeId: nodeB,
            iteration: 0,
            resolveRun: async () => ({ adapter }),
            computeDiffBundleImpl: async (baseRef, _cwd, seq) => {
                seenBaseRef = baseRef;
                return { seq: seq ?? 1, baseRef, patches: [] };
            },
            resolveCommitPointerImpl: async (pointer) => pointer,
            emitEffect: async () => undefined,
        });
        expect(result.ok).toBe(true);
        // Must be B's own previous attempt (ptr-B1) — not A's (ptr-A1).
        expect(seenBaseRef).toBe("ptr-B1");
        sqlite.close();
    });
    test("Blocker #8: git-backed run returns a clear VcsError", async () => {
        const { sqlite, adapter } = createTestDb();
        const runId = "run-git-backed";
        const nodeId = "task:git";
        await adapter.insertRun(runRow(runId, { vcsType: "git", vcsRevision: "HEAD" }));
        await adapter.insertNode(nodeRow(runId, nodeId));
        await adapter.insertAttempt(attemptRow(runId, nodeId, 0, {
            jjPointer: null,
            jjCwd: null,
        }));
        const result = await getNodeDiffRoute({
            runId,
            nodeId,
            iteration: 0,
            resolveRun: async () => ({ adapter }),
            emitEffect: async () => undefined,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.code).toBe("VcsError");
            expect(result.error.message).toMatch(/git/i);
        }
        sqlite.close();
    });
});
