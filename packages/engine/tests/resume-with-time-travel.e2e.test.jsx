/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { SmithersDb } from "@smithers/db/adapter";
import { Task, Workflow, runWorkflow } from "smithers-orchestrator";
import { captureSnapshot, loadSnapshot, listSnapshots, parseSnapshot, } from "@smithers/time-travel/snapshot";
import { replayFromCheckpoint } from "@smithers/time-travel/replay";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { outputSchemas } from "../../smithers/tests/schema.js";
import { Effect } from "effect";
/**
 * @param {Record<string, unknown>} input
 * @returns {Record<string, unknown>}
 */
function normalizeSnapshotInput(input) {
    if (!input || typeof input !== "object")
        return {};
    if ("payload" in input) {
        const payload = input.payload && typeof input.payload === "object"
            ? input.payload
            : {};
        const { runId: _runId, payload: _payload, ...rest } = input;
        return { ...payload, ...rest };
    }
    const { runId: _runId, ...rest } = input;
    return rest;
}
/**
 * @param {ReturnType<typeof parseSnapshot>} snapshot
 * @returns {SnapshotData}
 */
function toSnapshotData(snapshot) {
    return {
        nodes: Object.values(snapshot.nodes).map((node) => ({
            nodeId: node.nodeId,
            iteration: node.iteration,
            state: node.state,
            lastAttempt: node.lastAttempt,
            outputTable: node.outputTable,
            label: node.label,
        })),
        outputs: snapshot.outputs,
        ralph: Object.values(snapshot.ralph).map((ralph) => ({
            ralphId: ralph.ralphId,
            iteration: ralph.iteration,
            done: ralph.done,
        })),
        input: normalizeSnapshotInput(snapshot.input),
        vcsPointer: snapshot.vcsPointer,
        workflowHash: snapshot.workflowHash,
    };
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} sourceFrameNo
 * @param {number} checkpointFrameNo
 */
async function copySnapshotToCheckpoint(adapter, runId, sourceFrameNo, checkpointFrameNo) {
    const snapshot = await loadSnapshot(adapter, runId, sourceFrameNo);
    if (!snapshot) {
        throw new Error(`Missing snapshot ${runId}:${sourceFrameNo}`);
    }
    await captureSnapshot(adapter, runId, checkpointFrameNo, toSnapshotData(parseSnapshot(snapshot)));
}
describe("resume with time travel", () => {
    test("fork from checkpoint preserves completed task outputs", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers(outputSchemas);
        try {
            const adapter = new SmithersDb(db);
            const originalCalls = [];
            const replayCalls = [];
            const parentRunId = "resume-time-travel-parent";
            const workflow = smithers(() => (<Workflow name="resume-time-travel-preserve">
          <Task id="analyze" output={outputs.outputA}>
            {() => {
                    originalCalls.push("analyze");
                    replayCalls.push("analyze");
                    return { value: 1 };
                }}
          </Task>
          <Task id="implement" output={outputs.outputB}>
            {() => {
                    originalCalls.push("implement");
                    replayCalls.push("implement");
                    return { value: 2 };
                }}
          </Task>
          <Task id="test" output={outputs.outputC}>
            {() => {
                    originalCalls.push("test");
                    replayCalls.push("test");
                    return { value: 3 };
                }}
          </Task>
        </Workflow>));
            const first = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: parentRunId,
            }));
            expect(first.status).toBe("finished");
            expect(originalCalls).toEqual(["analyze", "implement", "test"]);
            const parentSnapshots = await listSnapshots(adapter, parentRunId);
            const sourceFrameNo = parentSnapshots[parentSnapshots.length - 1].frameNo;
            const checkpointFrameNo = sourceFrameNo + 100;
            await copySnapshotToCheckpoint(adapter, parentRunId, sourceFrameNo, checkpointFrameNo);
            const replay = await replayFromCheckpoint(adapter, {
                parentRunId,
                frameNo: checkpointFrameNo,
                resetNodes: ["implement", "test"],
            });
            const forked = parseSnapshot(replay.snapshot);
            expect(forked.nodes["analyze::0"]?.state).toBe("finished");
            expect(forked.nodes["implement::0"]?.state).toBe("pending");
            expect(forked.nodes["test::0"]?.state).toBe("pending");
            replayCalls.length = 0;
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: replay.runId,
                resume: true,
            }));
            expect(resumed.status).toBe("finished");
            expect(replayCalls).toEqual(["implement", "test"]);
            const analyzeAttempts = await adapter.listAttempts(replay.runId, "analyze", 0);
            const implementAttempts = await adapter.listAttempts(replay.runId, "implement", 0);
            const testAttempts = await adapter.listAttempts(replay.runId, "test", 0);
            expect(analyzeAttempts).toHaveLength(0);
            expect(implementAttempts).toHaveLength(1);
            expect(testAttempts).toHaveLength(1);
            const analyzeRows = await db
                .select()
                .from(tables.outputA)
                .where(eq(tables.outputA.runId, replay.runId));
            const implementRows = await db
                .select()
                .from(tables.outputB)
                .where(eq(tables.outputB.runId, replay.runId));
            const testRows = await db
                .select()
                .from(tables.outputC)
                .where(eq(tables.outputC.runId, replay.runId));
            expect(analyzeRows).toHaveLength(1);
            expect(analyzeRows[0]).toMatchObject({
                runId: replay.runId,
                nodeId: "analyze",
                iteration: 0,
                value: 1,
            });
            expect(implementRows).toHaveLength(1);
            expect(implementRows[0]).toMatchObject({
                runId: replay.runId,
                nodeId: "implement",
                iteration: 0,
                value: 2,
            });
            expect(testRows).toHaveLength(1);
            expect(testRows[0]).toMatchObject({
                runId: replay.runId,
                nodeId: "test",
                iteration: 0,
                value: 3,
            });
        }
        finally {
            cleanup();
        }
    });
    test("replay with input overrides changes behavior", async () => {
        const { smithers, outputs, tables, db, cleanup } = createTestSmithers(outputSchemas);
        try {
            const adapter = new SmithersDb(db);
            const parentRunId = "resume-time-travel-input-overrides";
            const seenVariants = [];
            const workflow = smithers((ctx) => (<Workflow name="resume-time-travel-input-overrides">
          <Task id="analyze" output={outputs.outputA}>
            {() => {
                    seenVariants.push(String(ctx.input.variant));
                    return { value: ctx.input.variant === "B" ? 2 : 1 };
                }}
          </Task>
        </Workflow>));
            const first = await Effect.runPromise(runWorkflow(workflow, {
                input: { variant: "A" },
                runId: parentRunId,
            }));
            expect(first.status).toBe("finished");
            expect(seenVariants).toEqual(["A"]);
            const parentSnapshots = await listSnapshots(adapter, parentRunId);
            const sourceFrameNo = parentSnapshots[parentSnapshots.length - 1].frameNo;
            const checkpointFrameNo = sourceFrameNo + 200;
            await copySnapshotToCheckpoint(adapter, parentRunId, sourceFrameNo, checkpointFrameNo);
            const replay = await replayFromCheckpoint(adapter, {
                parentRunId,
                frameNo: checkpointFrameNo,
                inputOverrides: { variant: "B" },
                resetNodes: ["analyze"],
            });
            const forked = parseSnapshot(replay.snapshot);
            expect(forked.input).toEqual({ variant: "B" });
            expect(forked.nodes["analyze::0"]?.state).toBe("pending");
            seenVariants.length = 0;
            const resumed = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: replay.runId,
                resume: true,
            }));
            expect(resumed.status).toBe("finished");
            expect(seenVariants).toEqual(["B"]);
            const replayRows = await db
                .select()
                .from(tables.outputA)
                .where(eq(tables.outputA.runId, replay.runId));
            expect(replayRows).toHaveLength(1);
            expect(replayRows[0]).toMatchObject({
                runId: replay.runId,
                nodeId: "analyze",
                iteration: 0,
                value: 2,
            });
        }
        finally {
            cleanup();
        }
    });
    test("fork from mid-workflow checkpoint", async () => {
        const { smithers, outputs, db, cleanup } = createTestSmithers(outputSchemas);
        try {
            const adapter = new SmithersDb(db);
            const parentRunId = "resume-time-travel-mid-workflow";
            const checkpointFrames = [];
            const checkpointCopies = [];
            const workflow = smithers(() => (<Workflow name="resume-time-travel-mid-workflow">
          <Task id="analyze" output={outputs.outputA}>
            {{ value: 1 }}
          </Task>
          <Task id="implement" output={outputs.outputB}>
            {{ value: 2 }}
          </Task>
          <Task id="test" output={outputs.outputC}>
            {{ value: 3 }}
          </Task>
        </Workflow>));
            const result = await Effect.runPromise(runWorkflow(workflow, {
                input: {},
                runId: parentRunId,
                onProgress: (event) => {
                    if (event.type !== "FrameCommitted")
                        return;
                    const checkpointFrameNo = 1000 + event.frameNo;
                    checkpointFrames.push(checkpointFrameNo);
                    checkpointCopies.push(copySnapshotToCheckpoint(adapter, parentRunId, event.frameNo, checkpointFrameNo));
                },
            }));
            expect(result.status).toBe("finished");
            await Promise.all(checkpointCopies);
            expect(checkpointFrames.length).toBeGreaterThan(0);
            let earlyCheckpointFrameNo = null;
            for (const checkpointFrameNo of checkpointFrames.sort((a, b) => a - b)) {
                const checkpoint = await loadSnapshot(adapter, parentRunId, checkpointFrameNo);
                if (!checkpoint)
                    continue;
                const parsed = parseSnapshot(checkpoint);
                if (parsed.nodes["analyze::0"]?.state === "finished" &&
                    parsed.nodes["implement::0"]?.state === "pending" &&
                    parsed.nodes["test::0"]?.state === "pending") {
                    earlyCheckpointFrameNo = checkpointFrameNo;
                    break;
                }
            }
            expect(earlyCheckpointFrameNo).toBeTruthy();
            const replay = await replayFromCheckpoint(adapter, {
                parentRunId,
                frameNo: earlyCheckpointFrameNo,
            });
            const forked = parseSnapshot(replay.snapshot);
            expect(forked.nodes["analyze::0"]?.state).toBe("finished");
            expect(forked.nodes["implement::0"]?.state).toBe("pending");
            expect(forked.nodes["test::0"]?.state).toBe("pending");
        }
        finally {
            cleanup();
        }
    });
});
