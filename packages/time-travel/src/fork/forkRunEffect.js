import { Effect, Metric } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { smithersBranches, smithersSnapshots } from "../schema.js";
import { loadSnapshot } from "../snapshot/loadSnapshotEffect.js";
import { parseSnapshot } from "../snapshot/parseSnapshot.js";
import { runForksCreated } from "../runForksCreated.js";
import { expandResetSet } from "./_helpers.js";
/** @typedef {import("../BranchInfo.ts").BranchInfo} BranchInfo */
/** @typedef {import("../ForkParams.ts").ForkParams} ForkParams */
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("../snapshot/Snapshot.ts").Snapshot} Snapshot */

/**
 * @param {SmithersDb} adapter
 * @param {ForkParams} params
 * @returns {Effect.Effect<{ runId: string; branch: BranchInfo; snapshot: Snapshot }, SmithersError>}
 */
export function forkRun(adapter, params) {
    return Effect.gen(function* () {
        const { parentRunId, frameNo, inputOverrides, resetNodes, branchLabel, forkDescription } = params;
        // 1. Load source snapshot
        const source = yield* loadSnapshot(adapter, parentRunId, frameNo);
        if (!source) {
            return yield* Effect.fail(new SmithersError("SNAPSHOT_NOT_FOUND", `No snapshot found for run=${parentRunId} frame=${frameNo}`, { frameNo, runId: parentRunId }));
        }
        // 2. Create new run ID
        const childRunId = crypto.randomUUID();
        const ts = nowMs();
        const parentRun = yield* Effect.tryPromise({
            try: () => adapter.getRun(parentRunId),
            catch: (cause) => toSmithersError(cause, "load parent run metadata", {
                code: "DB_QUERY_FAILED",
                details: { runId: parentRunId },
            }),
        });
        // 3. Optionally override input and reset nodes
        let nodesJson = source.nodesJson;
        let inputJson = source.inputJson;
        if (inputOverrides) {
            const existingInput = JSON.parse(source.inputJson);
            inputJson = JSON.stringify({ ...existingInput, ...inputOverrides });
        }
        if (resetNodes && resetNodes.length > 0) {
            const parsed = parseSnapshot(source);
            const keysToReset = expandResetSet(parsed.nodes, resetNodes);
            const nodesArr = JSON.parse(source.nodesJson);
            const updatedNodes = nodesArr.map((n) => {
                const key = `${n.nodeId}::${n.iteration}`;
                if (keysToReset.includes(key) || resetNodes.includes(n.nodeId)) {
                    return { ...n, state: "pending", lastAttempt: null };
                }
                return n;
            });
            nodesJson = JSON.stringify(updatedNodes);
        }
        // 4. Insert snapshot for the child run at frame 0
        const childSnapshot = {
            runId: childRunId,
            frameNo: 0,
            nodesJson,
            outputsJson: source.outputsJson,
            ralphJson: source.ralphJson,
            inputJson,
            vcsPointer: source.vcsPointer,
            workflowHash: source.workflowHash,
            contentHash: source.contentHash,
            createdAtMs: ts,
        };
        yield* Effect.tryPromise({
            try: () => adapter.db
                .insert(smithersSnapshots)
                .values(childSnapshot)
                .onConflictDoUpdate({
                target: [smithersSnapshots.runId, smithersSnapshots.frameNo],
                set: childSnapshot,
            }),
            catch: (cause) => toSmithersError(cause, "insert forked snapshot", {
                code: "DB_WRITE_FAILED",
                details: { frameNo: 0, runId: childRunId },
            }),
        });
        if (parentRun) {
            yield* Effect.tryPromise({
                try: () => adapter.insertRun({
                    runId: childRunId,
                    parentRunId,
                    workflowName: parentRun.workflowName,
                    workflowPath: parentRun.workflowPath ?? null,
                    workflowHash: source.workflowHash ?? parentRun.workflowHash ?? null,
                    status: parentRun.status === "running" ? "failed" : parentRun.status,
                    createdAtMs: ts,
                    startedAtMs: null,
                    finishedAtMs: parentRun.finishedAtMs ?? ts,
                    heartbeatAtMs: null,
                    runtimeOwnerId: null,
                    cancelRequestedAtMs: null,
                    hijackRequestedAtMs: null,
                    hijackTarget: null,
                    vcsType: parentRun.vcsType ?? null,
                    vcsRoot: parentRun.vcsRoot ?? null,
                    vcsRevision: source.vcsPointer ?? parentRun.vcsRevision ?? null,
                    errorJson: null,
                    configJson: parentRun.configJson ?? null,
                }),
                catch: (cause) => toSmithersError(cause, "insert forked run", {
                    code: "DB_WRITE_FAILED",
                    details: { runId: childRunId },
                }),
            });
        }
        // 5. Record branch relationship
        const branch = {
            runId: childRunId,
            parentRunId,
            parentFrameNo: frameNo,
            branchLabel: branchLabel ?? null,
            forkDescription: forkDescription ?? null,
            createdAtMs: ts,
        };
        yield* Effect.tryPromise({
            try: () => adapter.db
                .insert(smithersBranches)
                .values(branch)
                .onConflictDoUpdate({
                target: smithersBranches.runId,
                set: branch,
            }),
            catch: (cause) => toSmithersError(cause, "insert branch", {
                code: "DB_WRITE_FAILED",
                details: { runId: childRunId },
            }),
        });
        yield* Metric.increment(runForksCreated);
        yield* Effect.logInfo("Run forked").pipe(Effect.annotateLogs({
            parentRunId,
            parentFrameNo: String(frameNo),
            childRunId,
            branchLabel: branchLabel ?? "",
        }));
        return { runId: childRunId, branch, snapshot: childSnapshot };
    }).pipe(Effect.annotateLogs({
        parentRunId: params.parentRunId,
        parentFrameNo: String(params.frameNo),
    }), Effect.withLogSpan("time-travel:fork-run"));
}
