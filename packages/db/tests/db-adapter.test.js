import { describe, expect, test } from "bun:test";
import { SmithersDb } from "../src/adapter.js";
import { ensureSmithersTables } from "../src/ensure.js";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { canonicalizeXml } from "@smithers/graph/utils/xml";
function createTestDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { adapter: new SmithersDb(db), db, sqlite };
}
const now = Date.now();
/**
 * @param {string} runId
 * @param {any} [extra]
 */
function runRow(runId, status = "running", extra = {}) {
    return {
        runId,
        workflowName: "test-workflow",
        status,
        createdAtMs: now,
        ...extra,
    };
}
/**
 * @param {string} runId
 * @param {string} nodeId
 * @param {any} [extra]
 */
function nodeRow(runId, nodeId, state = "pending", extra = {}) {
    return {
        runId,
        nodeId,
        iteration: 0,
        state,
        updatedAtMs: now,
        outputTable: "out",
        label: null,
        ...extra,
    };
}
/**
 * @param {string} runId
 * @param {number} frameNo
 * @param {any} [extra]
 */
function frameRow(runId, frameNo, extra = {}) {
    return {
        runId,
        frameNo,
        createdAtMs: now,
        xmlHash: `hash${frameNo}`,
        xmlJson: "{}",
        ...extra,
    };
}
/**
 * @param {string} taskState
 * @returns {string}
 */
function workflowFrameXml(taskState, includeReview = false) {
    return canonicalizeXml({
        kind: "element",
        tag: "smithers:workflow",
        props: { name: "db-adapter-test" },
        children: [
            {
                kind: "element",
                tag: "smithers:task",
                props: { id: "plan::0", state: taskState },
                children: [],
            },
            ...(includeReview
                ? [
                    {
                        kind: "element",
                        tag: "smithers:task",
                        props: { id: "review::0", state: "pending" },
                        children: [],
                    },
                ]
                : []),
        ],
    });
}
/**
 * @param {string} cacheKey
 * @param {any} [extra]
 */
function cacheRow(cacheKey, extra = {}) {
    return {
        cacheKey,
        createdAtMs: now,
        workflowName: "test",
        nodeId: "n1",
        outputTable: "out",
        schemaSig: "sig",
        payloadJson: '{"v":1}',
        ...extra,
    };
}
/**
 * @param {string} runId
 * @param {string} ralphId
 * @param {any} [extra]
 */
function ralphRow(runId, ralphId, extra = {}) {
    return {
        runId,
        ralphId,
        iteration: 0,
        done: false,
        updatedAtMs: now,
        ...extra,
    };
}
/**
 * @param {any} [extra]
 */
function toolCallRow(extra = {}) {
    return {
        runId: "r1",
        nodeId: "n1",
        iteration: 0,
        attempt: 1,
        seq: 0,
        toolName: "bash",
        inputJson: '{"cmd":"ls"}',
        outputJson: '{"stdout":"file.txt"}',
        startedAtMs: now,
        status: "success",
        ...extra,
    };
}
describe("SmithersDb adapter", () => {
    test("insertRun and getRun", async () => {
        const { adapter } = createTestDb();
        await adapter.insertRun(runRow("r1"));
        const run = await adapter.getRun("r1");
        expect(run).toBeDefined();
        expect(run.runId).toBe("r1");
        expect(run.status).toBe("running");
    });
    test("updateRun changes status", async () => {
        const { adapter } = createTestDb();
        await adapter.insertRun(runRow("r1"));
        await adapter.updateRun("r1", { status: "finished" });
        const run = await adapter.getRun("r1");
        expect(run.status).toBe("finished");
    });
    test("listRuns returns recent runs", async () => {
        const { adapter } = createTestDb();
        await adapter.insertRun(runRow("r1", "running", { createdAtMs: now }));
        await adapter.insertRun(runRow("r2", "finished", { createdAtMs: now + 1 }));
        const runs = await adapter.listRuns();
        expect(runs.length).toBe(2);
        expect(runs[0].runId).toBe("r2");
    });
    test("listRuns filters by status", async () => {
        const { adapter } = createTestDb();
        await adapter.insertRun(runRow("r1", "running", { createdAtMs: now }));
        await adapter.insertRun(runRow("r2", "finished", { createdAtMs: now + 1 }));
        const runs = await adapter.listRuns(50, "finished");
        expect(runs.length).toBe(1);
        expect(runs[0].runId).toBe("r2");
    });
    test("listRuns leaves stale running rows as running (deriveRunState classifies them)", async () => {
        const { adapter } = createTestDb();
        await adapter.insertRun(runRow("stale", "running", {
            createdAtMs: now,
            heartbeatAtMs: now - 60_000,
        }));
        const runs = await adapter.listRuns();
        expect(runs).toHaveLength(1);
        expect(runs[0]?.status).toBe("running");
    });
    test("getRun leaves stale running rows as running (deriveRunState classifies them)", async () => {
        const { adapter } = createTestDb();
        await adapter.insertRun(runRow("stale-one", "running", {
            createdAtMs: now,
            heartbeatAtMs: now - 60_000,
        }));
        const run = await adapter.getRun("stale-one");
        expect(run?.status).toBe("running");
    });
    test("listRuns keeps fresh running runs as running", async () => {
        const { adapter } = createTestDb();
        await adapter.insertRun(runRow("fresh", "running", {
            createdAtMs: now,
            heartbeatAtMs: now - 1_000,
        }));
        const runs = await adapter.listRuns();
        expect(runs).toHaveLength(1);
        expect(runs[0]?.status).toBe("running");
    });
    test("listRuns respects limit", async () => {
        const { adapter } = createTestDb();
        for (let i = 0; i < 5; i++) {
            await adapter.insertRun(runRow(`r${i}`, "running", { createdAtMs: now + i }));
        }
        const runs = await adapter.listRuns(3);
        expect(runs.length).toBe(3);
    });
    test("insertNode and getNode", async () => {
        const { adapter } = createTestDb();
        await adapter.insertNode(nodeRow("r1", "n1"));
        const node = await adapter.getNode("r1", "n1", 0);
        expect(node).toBeDefined();
        expect(node.nodeId).toBe("n1");
        expect(node.state).toBe("pending");
    });
    test("listNodes returns all nodes for run", async () => {
        const { adapter } = createTestDb();
        await adapter.insertNode(nodeRow("r1", "n1"));
        await adapter.insertNode(nodeRow("r1", "n2", "finished"));
        const nodes = await adapter.listNodes("r1");
        expect(nodes.length).toBe(2);
    });
    test("insertAttempt and getAttempt", async () => {
        const { adapter } = createTestDb();
        await adapter.insertAttempt({
            runId: "r1",
            nodeId: "n1",
            iteration: 0,
            attempt: 1,
            state: "in-progress",
            startedAtMs: now,
        });
        const attempt = await adapter.getAttempt("r1", "n1", 0, 1);
        expect(attempt).toBeDefined();
        expect(attempt.state).toBe("in-progress");
    });
    test("updateAttempt changes state", async () => {
        const { adapter } = createTestDb();
        await adapter.insertAttempt({
            runId: "r1",
            nodeId: "n1",
            iteration: 0,
            attempt: 1,
            state: "in-progress",
            startedAtMs: now,
        });
        await adapter.updateAttempt("r1", "n1", 0, 1, {
            state: "finished",
            finishedAtMs: now + 100,
        });
        const attempt = await adapter.getAttempt("r1", "n1", 0, 1);
        expect(attempt.state).toBe("finished");
    });
    test("heartbeatAttempt updates heartbeat columns for in-progress attempt", async () => {
        const { adapter } = createTestDb();
        await adapter.insertAttempt({
            runId: "r1",
            nodeId: "n1",
            iteration: 0,
            attempt: 1,
            state: "in-progress",
            startedAtMs: now,
        });
        await adapter.heartbeatAttempt("r1", "n1", 0, 1, now + 500, JSON.stringify({ progress: 50 }));
        const attempt = await adapter.getAttempt("r1", "n1", 0, 1);
        expect(attempt?.heartbeatAtMs).toBe(now + 500);
        expect(attempt?.heartbeatDataJson).toBe(JSON.stringify({ progress: 50 }));
    });
    test("listAttempts returns attempts in descending order", async () => {
        const { adapter } = createTestDb();
        await adapter.insertAttempt({
            runId: "r1",
            nodeId: "n1",
            iteration: 0,
            attempt: 1,
            state: "failed",
            startedAtMs: now,
        });
        await adapter.insertAttempt({
            runId: "r1",
            nodeId: "n1",
            iteration: 0,
            attempt: 2,
            state: "in-progress",
            startedAtMs: now + 1,
        });
        const attempts = await adapter.listAttempts("r1", "n1", 0);
        expect(attempts.length).toBe(2);
        expect(attempts[0].attempt).toBe(2);
    });
    test("listInProgressAttempts", async () => {
        const { adapter } = createTestDb();
        await adapter.insertAttempt({
            runId: "r1",
            nodeId: "n1",
            iteration: 0,
            attempt: 1,
            state: "in-progress",
            startedAtMs: now,
        });
        await adapter.insertAttempt({
            runId: "r1",
            nodeId: "n2",
            iteration: 0,
            attempt: 1,
            state: "finished",
            startedAtMs: now,
        });
        const inProgress = await adapter.listInProgressAttempts("r1");
        expect(inProgress.length).toBe(1);
        expect(inProgress[0].nodeId).toBe("n1");
    });
    test("insertFrame and getLastFrame", async () => {
        const { adapter } = createTestDb();
        await adapter.insertFrame(frameRow("r1", 0));
        await adapter.insertFrame(frameRow("r1", 1));
        const last = await adapter.getLastFrame("r1");
        expect(last).toBeDefined();
        expect(last.frameNo).toBe(1);
    });
    test("insertFrame delta-encodes frames and reconstructs on read", async () => {
        const { adapter, sqlite } = createTestDb();
        const frame0 = workflowFrameXml("pending");
        const frame1 = workflowFrameXml("in-progress");
        const frame2 = workflowFrameXml("in-progress", true);
        await adapter.insertFrame(frameRow("r1", 0, { xmlJson: frame0, xmlHash: "h0" }));
        await adapter.insertFrame(frameRow("r1", 1, { xmlJson: frame1, xmlHash: "h1" }));
        await adapter.insertFrame(frameRow("r1", 2, { xmlJson: frame2, xmlHash: "h2" }));
        const rawRows = sqlite
            .query(`SELECT frame_no AS frameNo, encoding, xml_json AS xmlJson
         FROM _smithers_frames
         WHERE run_id = 'r1'
         ORDER BY frame_no ASC`)
            .all();
        expect(rawRows.map((row) => row.encoding)).toEqual(["keyframe", "delta", "delta"]);
        expect(rawRows[1].xmlJson.length).toBeLessThan(frame1.length);
        expect(rawRows[2].xmlJson.length).toBeLessThan(frame2.length);
        const frames = await adapter.listFrames("r1", 10);
        const byNo = new Map(frames.map((frame) => [frame.frameNo, frame]));
        expect(byNo.get(0)?.xmlJson).toBe(frame0);
        expect(byNo.get(1)?.xmlJson).toBe(frame1);
        expect(byNo.get(2)?.xmlJson).toBe(frame2);
    });
    test("insertFrame writes periodic keyframes", async () => {
        const { adapter, sqlite } = createTestDb();
        for (let i = 0; i <= 50; i += 1) {
            await adapter.insertFrame(frameRow("r1", i, {
                xmlJson: workflowFrameXml(i % 2 === 0 ? "pending" : "finished"),
                xmlHash: `h${i}`,
            }));
        }
        const row = sqlite
            .query(`SELECT encoding FROM _smithers_frames WHERE run_id = 'r1' AND frame_no = 50`)
            .get();
        expect(row.encoding).toBe("keyframe");
    });
    test("deleteFramesAfter removes later frames", async () => {
        const { adapter } = createTestDb();
        await adapter.insertFrame(frameRow("r1", 0));
        await adapter.insertFrame(frameRow("r1", 1));
        await adapter.insertFrame(frameRow("r1", 2));
        await adapter.deleteFramesAfter("r1", 0);
        const last = await adapter.getLastFrame("r1");
        expect(last.frameNo).toBe(0);
    });
    test("insertOrUpdateApproval and getApproval", async () => {
        const { adapter } = createTestDb();
        await adapter.insertOrUpdateApproval({
            runId: "r1",
            nodeId: "n1",
            iteration: 0,
            status: "pending",
            requestedAtMs: now,
        });
        const approval = await adapter.getApproval("r1", "n1", 0);
        expect(approval).toBeDefined();
        expect(approval.status).toBe("pending");
    });
    test("insertOrUpdateApproval updates on conflict", async () => {
        const { adapter } = createTestDb();
        await adapter.insertOrUpdateApproval({
            runId: "r1",
            nodeId: "n1",
            iteration: 0,
            status: "pending",
            requestedAtMs: now,
        });
        await adapter.insertOrUpdateApproval({
            runId: "r1",
            nodeId: "n1",
            iteration: 0,
            status: "approved",
            decidedAtMs: now + 100,
        });
        const approval = await adapter.getApproval("r1", "n1", 0);
        expect(approval.status).toBe("approved");
    });
    test("listAllPendingApprovals returns joined run and node context", async () => {
        const { adapter } = createTestDb();
        await adapter.insertRun(runRow("r1", "waiting-approval", {
            workflowName: "workflow-a",
            createdAtMs: now,
        }));
        await adapter.insertRun(runRow("r2", "waiting-approval", {
            workflowName: "workflow-b",
            createdAtMs: now + 1,
        }));
        await adapter.insertNode(nodeRow("r1", "deploy", "waiting-approval", {
            label: "Deploy gate",
        }));
        await adapter.insertNode(nodeRow("r2", "qa", "waiting-approval", {
            label: "QA gate",
        }));
        await adapter.insertOrUpdateApproval({
            runId: "r1",
            nodeId: "deploy",
            iteration: 0,
            status: "requested",
            requestedAtMs: now - 2000,
            note: "needs operator review",
        });
        await adapter.insertOrUpdateApproval({
            runId: "r2",
            nodeId: "qa",
            iteration: 0,
            status: "requested",
            requestedAtMs: now - 1000,
        });
        await adapter.insertOrUpdateApproval({
            runId: "r2",
            nodeId: "cleanup",
            iteration: 0,
            status: "approved",
            decidedAtMs: now,
        });
        const approvals = await adapter.listAllPendingApprovals();
        expect(approvals).toHaveLength(2);
        expect(approvals.map((approval) => approval.runId)).toEqual(["r1", "r2"]);
        expect(approvals[0]).toMatchObject({
            runId: "r1",
            nodeId: "deploy",
            workflowName: "workflow-a",
            nodeLabel: "Deploy gate",
            status: "requested",
            note: "needs operator review",
        });
    });
    test("insertCache and getCache", async () => {
        const { adapter } = createTestDb();
        await adapter.insertCache(cacheRow("key1"));
        const cached = await adapter.getCache("key1");
        expect(cached).toBeDefined();
        expect(cached.payloadJson).toBe('{"v":1}');
    });
    test("getCache returns undefined for missing key", async () => {
        const { adapter } = createTestDb();
        const cached = await adapter.getCache("nonexistent");
        expect(cached).toBeUndefined();
    });
    test("insertOrUpdateRalph and getRalph", async () => {
        const { adapter } = createTestDb();
        await adapter.insertOrUpdateRalph(ralphRow("r1", "loop1"));
        const ralph = await adapter.getRalph("r1", "loop1");
        expect(ralph).toBeDefined();
        expect(ralph.iteration).toBe(0);
        expect(ralph.done).toBeFalsy();
    });
    test("listRalph returns all ralph state for run", async () => {
        const { adapter } = createTestDb();
        await adapter.insertOrUpdateRalph(ralphRow("r1", "loop1"));
        await adapter.insertOrUpdateRalph(ralphRow("r1", "loop2", { iteration: 1, done: true }));
        const ralphs = await adapter.listRalph("r1");
        expect(ralphs.length).toBe(2);
    });
    test("insertEvent and listEvents", async () => {
        const { adapter } = createTestDb();
        await adapter.insertEvent({
            runId: "r1",
            seq: 0,
            timestampMs: now,
            type: "RunStarted",
            payloadJson: "{}",
        });
        await adapter.insertEvent({
            runId: "r1",
            seq: 1,
            timestampMs: now,
            type: "NodeStarted",
            payloadJson: "{}",
        });
        const events = await adapter.listEvents("r1", -1);
        expect(events.length).toBe(2);
    });
    test("listEvents respects afterSeq", async () => {
        const { adapter } = createTestDb();
        await adapter.insertEvent({
            runId: "r1",
            seq: 0,
            timestampMs: now,
            type: "RunStarted",
            payloadJson: "{}",
        });
        await adapter.insertEvent({
            runId: "r1",
            seq: 1,
            timestampMs: now,
            type: "NodeStarted",
            payloadJson: "{}",
        });
        const events = await adapter.listEvents("r1", 0);
        expect(events.length).toBe(1);
        expect(events[0].seq).toBe(1);
    });
    test("listEventHistory filters by node ID", async () => {
        const { adapter } = createTestDb();
        await adapter.insertEvent({
            runId: "r1",
            seq: 0,
            timestampMs: now,
            type: "NodeStarted",
            payloadJson: JSON.stringify({ nodeId: "task-a", attempt: 1 }),
        });
        await adapter.insertEvent({
            runId: "r1",
            seq: 1,
            timestampMs: now + 1_000,
            type: "NodeStarted",
            payloadJson: JSON.stringify({ nodeId: "task-b", attempt: 1 }),
        });
        const events = await adapter.listEventHistory("r1", {
            nodeId: "task-a",
            limit: 10,
        });
        expect(events.length).toBe(1);
        expect(events[0].seq).toBe(0);
    });
    test("listEventHistory composes type and since filters", async () => {
        const { adapter } = createTestDb();
        await adapter.insertEvent({
            runId: "r1",
            seq: 0,
            timestampMs: now - 10 * 60_000,
            type: "ToolCallStarted",
            payloadJson: JSON.stringify({ nodeId: "task-a", toolName: "web-search" }),
        });
        await adapter.insertEvent({
            runId: "r1",
            seq: 1,
            timestampMs: now - 2 * 60_000,
            type: "ToolCallFinished",
            payloadJson: JSON.stringify({
                nodeId: "task-a",
                toolName: "web-search",
                status: "success",
            }),
        });
        await adapter.insertEvent({
            runId: "r1",
            seq: 2,
            timestampMs: now - 2 * 60_000,
            type: "NodeFinished",
            payloadJson: JSON.stringify({ nodeId: "task-a" }),
        });
        const events = await adapter.listEventHistory("r1", {
            types: ["ToolCallStarted", "ToolCallFinished"],
            sinceTimestampMs: now - 5 * 60_000,
            limit: 10,
        });
        expect(events.length).toBe(1);
        expect(events[0].type).toBe("ToolCallFinished");
    });
    test("countEventHistory returns filtered count", async () => {
        const { adapter } = createTestDb();
        await adapter.insertEvent({
            runId: "r1",
            seq: 0,
            timestampMs: now,
            type: "ApprovalRequested",
            payloadJson: JSON.stringify({ nodeId: "gate" }),
        });
        await adapter.insertEvent({
            runId: "r1",
            seq: 1,
            timestampMs: now + 1_000,
            type: "ApprovalGranted",
            payloadJson: JSON.stringify({ nodeId: "gate" }),
        });
        await adapter.insertEvent({
            runId: "r1",
            seq: 2,
            timestampMs: now + 2_000,
            type: "NodeFinished",
            payloadJson: JSON.stringify({ nodeId: "task" }),
        });
        const count = await adapter.countEventHistory("r1", {
            types: ["ApprovalRequested", "ApprovalGranted"],
        });
        expect(count).toBe(2);
    });
    test("getLastEventSeq returns latest seq", async () => {
        const { adapter } = createTestDb();
        await adapter.insertEvent({
            runId: "r1",
            seq: 0,
            timestampMs: now,
            type: "A",
            payloadJson: "{}",
        });
        await adapter.insertEvent({
            runId: "r1",
            seq: 5,
            timestampMs: now,
            type: "B",
            payloadJson: "{}",
        });
        const lastSeq = await adapter.getLastEventSeq("r1");
        expect(lastSeq).toBe(5);
    });
    test("countNodesByState returns correct counts", async () => {
        const { adapter } = createTestDb();
        await adapter.insertNode(nodeRow("r1", "n1", "finished"));
        await adapter.insertNode(nodeRow("r1", "n2", "finished"));
        await adapter.insertNode(nodeRow("r1", "n3", "failed"));
        const counts = await adapter.countNodesByState("r1");
        const finished = counts.find((c) => c.state === "finished");
        const failed = counts.find((c) => c.state === "failed");
        expect(finished?.count).toBe(2);
        expect(failed?.count).toBe(1);
    });
    test("heartbeatRun updates timestamp", async () => {
        const { adapter } = createTestDb();
        const ownerId = "owner-1";
        await adapter.insertRun(runRow("r1", "running", { runtimeOwnerId: ownerId }));
        await adapter.heartbeatRun("r1", ownerId, now + 1000);
        const run = await adapter.getRun("r1");
        expect(run.heartbeatAtMs).toBe(now + 1000);
    });
    test("listStaleRunningRuns returns only stale running runs", async () => {
        const { adapter } = createTestDb();
        await adapter.insertRun(runRow("stale-running", "running", {
            heartbeatAtMs: now - 60_000,
        }));
        await adapter.insertRun(runRow("fresh-running", "running", {
            heartbeatAtMs: now,
        }));
        await adapter.insertRun(runRow("stale-finished", "finished", {
            heartbeatAtMs: now - 60_000,
        }));
        const stale = await adapter.listStaleRunningRuns(now - 30_000);
        const ids = stale.map((row) => row.runId);
        expect(ids).toContain("stale-running");
        expect(ids).not.toContain("fresh-running");
        expect(ids).not.toContain("stale-finished");
    });
    test("claimRunForResume succeeds only once for the same stale snapshot", async () => {
        const { adapter } = createTestDb();
        await adapter.insertRun(runRow("claim-once", "running", {
            runtimeOwnerId: "pid:999:owner",
            heartbeatAtMs: now - 60_000,
        }));
        const first = await adapter.claimRunForResume({
            runId: "claim-once",
            expectedRuntimeOwnerId: "pid:999:owner",
            expectedHeartbeatAtMs: now - 60_000,
            staleBeforeMs: now - 30_000,
            claimOwnerId: "supervisor:a",
            claimHeartbeatAtMs: now,
        });
        const second = await adapter.claimRunForResume({
            runId: "claim-once",
            expectedRuntimeOwnerId: "pid:999:owner",
            expectedHeartbeatAtMs: now - 60_000,
            staleBeforeMs: now - 30_000,
            claimOwnerId: "supervisor:b",
            claimHeartbeatAtMs: now + 1,
        });
        expect(first).toBe(true);
        expect(second).toBe(false);
        const run = await adapter.getRun("claim-once");
        expect(run?.runtimeOwnerId).toBe("supervisor:a");
        expect(run?.heartbeatAtMs).toBe(now);
    });
    test("releaseRunResumeClaim restores runtime owner and heartbeat", async () => {
        const { adapter } = createTestDb();
        await adapter.insertRun(runRow("claim-release", "running", {
            runtimeOwnerId: "supervisor:a",
            heartbeatAtMs: now,
        }));
        await adapter.releaseRunResumeClaim({
            runId: "claim-release",
            claimOwnerId: "supervisor:a",
            restoreRuntimeOwnerId: "pid:123:owner",
            restoreHeartbeatAtMs: now - 5000,
        });
        const run = await adapter.getRun("claim-release");
        expect(run?.runtimeOwnerId).toBe("pid:123:owner");
        expect(run?.heartbeatAtMs).toBe(now - 5000);
    });
    test("requestRunCancel sets cancelRequestedAtMs", async () => {
        const { adapter } = createTestDb();
        await adapter.insertRun(runRow("r1"));
        await adapter.requestRunCancel("r1", now + 500);
        const run = await adapter.getRun("r1");
        expect(run.cancelRequestedAtMs).toBe(now + 500);
    });
    test("getRun returns undefined for missing run", async () => {
        const { adapter } = createTestDb();
        const run = await adapter.getRun("nonexistent");
        expect(run).toBeUndefined();
    });
    test("listFrames returns frames with limit", async () => {
        const { adapter } = createTestDb();
        for (let i = 0; i < 5; i++) {
            await adapter.insertFrame(frameRow("r1", i));
        }
        const frames = await adapter.listFrames("r1", 3);
        expect(frames.length).toBe(3);
    });
    test("insertToolCall stores tool call", async () => {
        const { adapter } = createTestDb();
        await adapter.insertToolCall(toolCallRow());
    });
    test("listNodeIterations returns descending iterations for a node", async () => {
        const { adapter } = createTestDb();
        await adapter.insertNode(nodeRow("r1", "n1", "finished", { iteration: 1 }));
        await adapter.insertNode(nodeRow("r1", "n1", "finished", { iteration: 3 }));
        await adapter.insertNode(nodeRow("r1", "n1", "finished", { iteration: 2 }));
        const iterations = await adapter.listNodeIterations("r1", "n1");
        expect(iterations.map((row) => row.iteration)).toEqual([3, 2, 1]);
    });
    test("listToolCalls orders by attempt then seq", async () => {
        const { adapter } = createTestDb();
        await adapter.insertToolCall(toolCallRow({ attempt: 2, seq: 1 }));
        await adapter.insertToolCall(toolCallRow({ attempt: 1, seq: 2 }));
        await adapter.insertToolCall(toolCallRow({ attempt: 1, seq: 1 }));
        const calls = await adapter.listToolCalls("r1", "n1", 0);
        expect(calls.map((row) => `${row.attempt}:${row.seq}`)).toEqual([
            "1:1",
            "1:2",
            "2:1",
        ]);
    });
    test("listEventsByType filters events for a run", async () => {
        const { adapter } = createTestDb();
        await adapter.insertEvent({
            runId: "r1",
            seq: 0,
            timestampMs: now,
            type: "NodeStarted",
            payloadJson: "{}",
        });
        await adapter.insertEvent({
            runId: "r1",
            seq: 1,
            timestampMs: now,
            type: "TokenUsageReported",
            payloadJson: "{}",
        });
        await adapter.insertEvent({
            runId: "r2",
            seq: 0,
            timestampMs: now,
            type: "TokenUsageReported",
            payloadJson: "{}",
        });
        const events = await adapter.listEventsByType("r1", "TokenUsageReported");
        expect(events).toHaveLength(1);
        expect(events[0]?.runId).toBe("r1");
        expect(events[0]?.type).toBe("TokenUsageReported");
    });
});
