import { Effect } from "effect";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { revertToJjPointer } from "@smithers-orchestrator/vcs/jj";
import * as BunContext from "@effect/platform-bun/BunContext";
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./TimeTravelOptions.ts").TimeTravelOptions} TimeTravelOptions */
/** @typedef {import("./TimeTravelResult.ts").TimeTravelResult} TimeTravelResult */

/**
 * @param {string} nodeId
 * @param {number} iteration
 */
function nodeKey(nodeId, iteration) {
    return `${nodeId}::${iteration}`;
}
/**
 * @param {Array<{ nodeId: string; iteration: number }>} nodes
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
 * @param {any[]} attempts
 * @param {number} [requestedAttempt]
 * @returns {AttemptRow | undefined}
 */
function selectAttempt(attempts, requestedAttempt) {
    if (requestedAttempt == null)
        return attempts[0];
    return attempts.find((attempt) => attempt.attempt === requestedAttempt);
}
/**
 * @param {NonNullable<AttemptRow>} targetAttempt
 * @param {any[]} attemptsForRun
 */
function findTargetAttemptOrder(targetAttempt, attemptsForRun) {
    return attemptsForRun.findIndex((attempt) => attempt.runId === targetAttempt.runId &&
        attempt.nodeId === targetAttempt.nodeId &&
        (attempt.iteration ?? 0) === (targetAttempt.iteration ?? 0) &&
        attempt.attempt === targetAttempt.attempt);
}
/**
 * @param {SmithersDb} adapter
 * @param {{ runId: string; targetNode: NonNullable<NodeRow>; targetAttempt: NonNullable<AttemptRow>; attemptsForRun: any[]; resetDependents: boolean; }} opts
 */
async function resolveResetNodes(adapter, opts) {
    const { runId, targetNode, targetAttempt, attemptsForRun, resetDependents } = opts;
    if (!resetDependents) {
        return [targetNode];
    }
    const nodes = await Effect.runPromise(adapter.listNodes(runId));
    const targetKey = nodeKey(targetNode.nodeId, targetNode.iteration ?? 0);
    const targetAttemptOrder = findTargetAttemptOrder(targetAttempt, attemptsForRun);
    const targetIteration = targetNode.iteration ?? 0;
    const cutoff = targetAttempt.startedAtMs;
    return nodes.filter((node) => {
        const currentKey = nodeKey(node.nodeId, node.iteration ?? 0);
        if (currentKey === targetKey)
            return true;
        if ((node.iteration ?? 0) > targetIteration)
            return true;
        let startedAfterTarget = false;
        let orderedAfterTarget = false;
        for (let index = 0; index < attemptsForRun.length; index += 1) {
            const attempt = attemptsForRun[index];
            if (attempt.nodeId !== node.nodeId ||
                (attempt.iteration ?? 0) !== (node.iteration ?? 0)) {
                continue;
            }
            if ((attempt.startedAtMs ?? 0) >= cutoff) {
                startedAfterTarget = true;
            }
            if (targetAttemptOrder >= 0 && index > targetAttemptOrder) {
                orderedAfterTarget = true;
            }
        }
        return startedAfterTarget || orderedAfterTarget;
    });
}
/**
 * @param {NonNullable<NodeRow>} existingNode
 */
function buildPendingNode(existingNode) {
    return {
        ...existingNode,
        state: "pending",
        updatedAtMs: nowMs(),
    };
}
/**
 * @param {SmithersDb} adapter
 * @param {TimeTravelOptions} opts
 * @returns {Promise<TimeTravelResult>}
 */
export async function timeTravel(adapter, opts) {
    const runId = opts.runId;
    const nodeId = opts.nodeId;
    const iteration = opts.iteration ?? 0;
    const resetDependents = opts.resetDependents ?? true;
    const restoreVcs = opts.restoreVcs ?? true;
    const attempts = await Effect.runPromise(adapter.listAttempts(runId, nodeId, iteration));
    const targetAttempt = selectAttempt(attempts, opts.attempt);
    if (!targetAttempt) {
        return {
            success: false,
            vcsRestored: false,
            resetNodes: [],
            error: `Attempt not found: ${runId}/${nodeId}/${iteration}/${opts.attempt ?? "latest"}`,
        };
    }
    const targetAttemptNo = targetAttempt.attempt;
    const jjPointer = targetAttempt.jjPointer ?? undefined;
    const targetNode = await Effect.runPromise(adapter.getNode(runId, nodeId, iteration));
    if (!targetNode) {
        return {
            success: false,
            vcsRestored: false,
            resetNodes: [],
            error: `Node not found: ${runId}/${nodeId}/${iteration}`,
        };
    }
    opts.onProgress?.({
        type: "TimeTravelStarted",
        runId,
        nodeId,
        iteration,
        attempt: targetAttemptNo,
        jjPointer,
        timestampMs: nowMs(),
    });
    let vcsRestored = false;
    if (restoreVcs && jjPointer) {
        const vcsResult = await Effect.runPromise(revertToJjPointer(jjPointer, targetAttempt.jjCwd ?? undefined).pipe(Effect.provide(BunContext.layer)));
        vcsRestored = vcsResult.success;
        if (!vcsResult.success) {
            const error = vcsResult.error ?? "Failed to restore VCS state";
            opts.onProgress?.({
                type: "TimeTravelFinished",
                runId,
                nodeId,
                iteration,
                attempt: targetAttemptNo,
                jjPointer,
                success: false,
                vcsRestored,
                resetNodes: [],
                error,
                timestampMs: nowMs(),
            });
            return {
                success: false,
                jjPointer,
                vcsRestored,
                resetNodes: [],
                error,
            };
        }
    }
    const attemptsForRun = await Effect.runPromise(adapter.listAttemptsForRun(runId));
    const resetNodes = await resolveResetNodes(adapter, {
        runId,
        targetNode,
        targetAttempt,
        attemptsForRun,
        resetDependents,
    });
    const resetNodeIds = uniqueNodeIds(resetNodes.map((node) => ({
        nodeId: node.nodeId,
        iteration: node.iteration ?? 0,
    })));
    const attemptsByNode = new Map();
    for (const resetNode of resetNodes) {
        attemptsByNode.set(nodeKey(resetNode.nodeId, resetNode.iteration ?? 0), attemptsForRun.filter((attempt) => attempt.nodeId === resetNode.nodeId &&
            (attempt.iteration ?? 0) === (resetNode.iteration ?? 0)));
    }
    await adapter.withTransaction("time-travel", Effect.gen(function* () {
        const frames = yield* adapter.listFrames(runId, 1_000_000);
        const cutoff = targetAttempt.startedAtMs;
        let lastValidFrameNo = -1;
        for (const frame of frames) {
            if (frame.createdAtMs <= cutoff && frame.frameNo > lastValidFrameNo) {
                lastValidFrameNo = frame.frameNo;
            }
        }
        if (lastValidFrameNo >= 0) {
            yield* adapter.deleteFramesAfter(runId, lastValidFrameNo);
        }
        for (const resetNode of resetNodes) {
            const attemptsForNode = attemptsByNode.get(nodeKey(resetNode.nodeId, resetNode.iteration ?? 0)) ??
                [];
            for (const attempt of attemptsForNode) {
                if ((attempt.startedAtMs ?? 0) < cutoff || attempt.state === "cancelled") {
                    continue;
                }
                const patch = { state: "cancelled" };
                if (attempt.finishedAtMs == null) {
                    patch.finishedAtMs = nowMs();
                }
                yield* adapter.updateAttempt(runId, resetNode.nodeId, resetNode.iteration ?? 0, attempt.attempt, patch);
            }
            if (resetNode.outputTable) {
                yield* adapter.deleteOutputRow(resetNode.outputTable, {
                    runId,
                    nodeId: resetNode.nodeId,
                    iteration: resetNode.iteration ?? 0,
                });
            }
            yield* adapter.insertNode(buildPendingNode(resetNode));
        }
        yield* adapter.updateRun(runId, {
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
    opts.onProgress?.({
        type: "TimeTravelFinished",
        runId,
        nodeId,
        iteration,
        attempt: targetAttemptNo,
        jjPointer,
        success: true,
        vcsRestored,
        resetNodes: resetNodeIds,
        timestampMs: nowMs(),
    });
    return {
        success: true,
        jjPointer,
        vcsRestored,
        resetNodes: resetNodeIds,
    };
}
