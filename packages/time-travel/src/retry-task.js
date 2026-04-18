import { Effect } from "effect";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
/** @typedef {import("./RetryTaskOptions.ts").RetryTaskOptions} RetryTaskOptions */
/** @typedef {import("./RetryTaskResult.ts").RetryTaskResult} RetryTaskResult */
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */

/**
 * @param {string} nodeId
 * @param {number} iteration
 */
function buildNodeKey(nodeId, iteration) {
    return `${nodeId}::${iteration}`;
}
/**
 * @param {Array<{ nodeId: string; iteration: number }>} nodes
 * @returns {string[]}
 */
function uniqueNodeIds(nodes) {
    const seen = new Set();
    const result = [];
    for (const node of nodes) {
        if (seen.has(node.nodeId))
            continue;
        seen.add(node.nodeId);
        result.push(node.nodeId);
    }
    return result;
}
/**
 * @param {string | null | undefined} status
 */
function isActiveRunStatus(status) {
    return (status === "running" ||
        status === "waiting-approval" ||
        status === "waiting-event" ||
        status === "waiting-timer");
}
/**
 * @param {SmithersDb} adapter
 * @param {Required<Pick<RetryTaskOptions, "runId" | "resetDependents">> & { targetNode: any; }} opts
 */
async function resolveResetNodes(adapter, opts) {
    const { runId, targetNode, resetDependents } = opts;
    if (!resetDependents) {
        return [targetNode];
    }
    const nodes = await adapter.listNodes(runId);
    const attempts = await adapter.listAttemptsForRun(runId);
    const attemptOrder = new Map();
    for (let index = 0; index < attempts.length; index += 1) {
        const attempt = attempts[index];
        attemptOrder.set(buildNodeKey(attempt.nodeId, attempt.iteration ?? 0), index);
    }
    const targetKey = buildNodeKey(targetNode.nodeId, targetNode.iteration ?? 0);
    const targetOrder = attemptOrder.get(targetKey);
    const targetIteration = targetNode.iteration ?? 0;
    const targetUpdatedAtMs = targetNode.updatedAtMs ?? 0;
    return nodes.filter((node) => {
        const nodeIteration = node.iteration ?? 0;
        const nodeKey = buildNodeKey(node.nodeId, nodeIteration);
        if (nodeKey === targetKey)
            return true;
        if (nodeIteration > targetIteration)
            return true;
        const nodeOrder = attemptOrder.get(nodeKey);
        if (targetOrder !== undefined && nodeOrder !== undefined) {
            return nodeOrder > targetOrder;
        }
        return (node.updatedAtMs ?? 0) > targetUpdatedAtMs;
    });
}
/**
 * @param {RetryTaskOptions} opts
 * @param {{ runId: string; nodeId: string; iteration: number; resetNodes: string[]; success: boolean; error?: string; }} payload
 */
function emitRetryFinished(opts, payload) {
    opts.onProgress?.({
        type: "RetryTaskFinished",
        ...payload,
        timestampMs: nowMs(),
    });
}
/**
 * @param {SmithersDb} adapter
 * @param {RetryTaskOptions} opts
 * @returns {Promise<RetryTaskResult>}
 */
export async function retryTask(adapter, opts) {
    const runId = opts.runId;
    const nodeId = opts.nodeId;
    const iteration = opts.iteration ?? 0;
    const resetDependents = opts.resetDependents ?? true;
    const force = opts.force ?? false;
    const node = await adapter.getNode(runId, nodeId, iteration);
    if (!node) {
        const error = `Node not found: ${runId}/${nodeId}/${iteration}`;
        emitRetryFinished(opts, {
            runId,
            nodeId,
            iteration,
            resetNodes: [],
            success: false,
            error,
        });
        return { success: false, resetNodes: [], error };
    }
    const run = await adapter.getRun(runId);
    if (!run) {
        const error = `Run not found: ${runId}`;
        emitRetryFinished(opts, {
            runId,
            nodeId,
            iteration,
            resetNodes: [],
            success: false,
            error,
        });
        return { success: false, resetNodes: [], error };
    }
    if (!force && isActiveRunStatus(run.status)) {
        const error = `Run is still running: ${runId}`;
        emitRetryFinished(opts, {
            runId,
            nodeId,
            iteration,
            resetNodes: [],
            success: false,
            error,
        });
        return { success: false, resetNodes: [], error };
    }
    const resetNodes = await resolveResetNodes(adapter, {
        runId,
        targetNode: node,
        resetDependents,
    });
    const resetNodeIds = uniqueNodeIds(resetNodes.map((candidate) => ({
        nodeId: candidate.nodeId,
        iteration: candidate.iteration ?? 0,
    })));
    const attemptsByNode = new Map();
    for (const resetNode of resetNodes) {
        const resetIteration = resetNode.iteration ?? 0;
        attemptsByNode.set(buildNodeKey(resetNode.nodeId, resetIteration), await adapter.listAttempts(runId, resetNode.nodeId, resetIteration));
    }
    opts.onProgress?.({
        type: "RetryTaskStarted",
        runId,
        nodeId,
        iteration,
        resetDependents,
        resetNodes: resetNodeIds,
        timestampMs: nowMs(),
    });
    const resetTimestampMs = nowMs();
    await adapter.withTransaction("retry-task-reset", Effect.gen(function* () {
        for (const resetNode of resetNodes) {
            const resetIteration = resetNode.iteration ?? 0;
            const attempts = attemptsByNode.get(buildNodeKey(resetNode.nodeId, resetIteration)) ??
                [];
            for (const attempt of attempts) {
                if (attempt.state !== "failed" &&
                    attempt.state !== "in-progress" &&
                    attempt.state !== "waiting-approval" &&
                    attempt.state !== "waiting-event" &&
                    attempt.state !== "waiting-timer") {
                    continue;
                }
                const patch = { state: "cancelled" };
                if (attempt.finishedAtMs == null) {
                    patch.finishedAtMs = resetTimestampMs;
                }
                yield* adapter.updateAttemptEffect(runId, resetNode.nodeId, resetIteration, attempt.attempt, patch);
            }
            if (resetNode.outputTable) {
                yield* adapter.deleteOutputRowEffect(resetNode.outputTable, {
                    runId,
                    nodeId: resetNode.nodeId,
                    iteration: resetIteration,
                });
            }
            yield* adapter.insertNodeEffect({
                runId,
                nodeId: resetNode.nodeId,
                iteration: resetIteration,
                state: "pending",
                lastAttempt: resetNode.lastAttempt ?? null,
                updatedAtMs: resetTimestampMs,
                outputTable: resetNode.outputTable ?? "",
                label: resetNode.label ?? null,
            });
        }
        yield* adapter.updateRunEffect(runId, {
            status: "running",
            finishedAtMs: null,
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
            hijackRequestedAtMs: null,
            hijackTarget: null,
            errorJson: null,
        });
    }));
    emitRetryFinished(opts, {
        runId,
        nodeId,
        iteration,
        resetNodes: resetNodeIds,
        success: true,
    });
    return {
        success: true,
        resetNodes: resetNodeIds,
    };
}
