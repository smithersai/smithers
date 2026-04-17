import { Effect, Layer } from "effect";
import { StorageService } from "./StorageService.js";
/** @typedef {import("./StorageServiceShape.ts").StorageServiceShape} StorageServiceShape */

/**
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 */
function nodeKey(runId, nodeId, iteration) {
    return `${runId}::${nodeId}::${iteration}`;
}
/**
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {number} attempt
 */
function attemptKey(runId, nodeId, iteration, attempt) {
    return `${nodeKey(runId, nodeId, iteration)}::${attempt}`;
}
/**
 * @param {OutputKey} key
 * @returns {string}
 */
function outputKey(key) {
    return JSON.stringify(Object.entries(key).sort(([left], [right]) => left.localeCompare(right)));
}
/**
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 */
function approvalKey(runId, nodeId, iteration) {
    return nodeKey(runId, nodeId, iteration);
}
/**
 * @param {string} runId
 * @param {string} ralphId
 */
function ralphKey(runId, ralphId) {
    return `${runId}::${ralphId}`;
}
/**
 * @param {string} runId
 * @param {string} sandboxId
 */
function sandboxKey(runId, sandboxId) {
    return `${runId}::${sandboxId}`;
}
/**
 * @template T
 * @param {readonly T[]} rows
 * @returns {T[]}
 */
function applyLimit(rows, limit = rows.length) {
    return rows.slice(0, Math.max(0, Math.floor(limit)));
}
/**
 * @param {EventRow} row
 * @param {EventHistoryQuery} [query]
 * @returns {boolean}
 */
function eventMatchesQuery(row, query = {}) {
    if (query.afterSeq !== undefined && row.seq <= query.afterSeq)
        return false;
    if (query.sinceTimestampMs !== undefined && row.timestampMs < query.sinceTimestampMs) {
        return false;
    }
    if (query.types && query.types.length > 0 && !query.types.includes(row.type)) {
        return false;
    }
    if (query.nodeId) {
        try {
            const payload = JSON.parse(row.payloadJson);
            if (payload.nodeId !== query.nodeId)
                return false;
        }
        catch {
            return false;
        }
    }
    return true;
}
/**
 * @returns {StorageServiceShape}
 */
export function makeInMemoryStorageService() {
    const runs = new Map();
    const frames = [];
    const nodes = new Map();
    const outputs = new Map();
    const attempts = new Map();
    const approvals = new Map();
    const humanRequests = new Map();
    const alerts = new Map();
    const signals = [];
    const toolCalls = [];
    const sandboxes = new Map();
    const events = [];
    const ralphs = new Map();
    const caches = new Map();
    const crons = new Map();
    const scorerResults = [];
    /**
   * @param {string} tableName
   */
    const table = (tableName) => {
        const existing = outputs.get(tableName);
        if (existing)
            return existing;
        const created = new Map();
        outputs.set(tableName, created);
        return created;
    };
    return {
        rawQuery: (_queryString) => Effect.succeed([]),
        insertRun: (run) => Effect.sync(() => {
            runs.set(run.runId, run);
        }),
        updateRun: (runId, patch) => Effect.sync(() => {
            const current = runs.get(runId) ?? { runId, status: "running" };
            runs.set(runId, { ...current, ...patch });
        }),
        heartbeatRun: (runId, runtimeOwnerId, heartbeatAtMs) => Effect.sync(() => {
            const current = runs.get(runId) ?? { runId, status: "running" };
            runs.set(runId, { ...current, runtimeOwnerId, heartbeatAtMs });
        }),
        requestRunCancel: (runId, cancelRequestedAtMs) => Effect.sync(() => {
            const current = runs.get(runId) ?? { runId, status: "running" };
            runs.set(runId, { ...current, cancelRequestedAtMs });
        }),
        requestRunHijack: (runId, hijackRequestedAtMs, hijackTarget = null) => Effect.sync(() => {
            const current = runs.get(runId) ?? { runId, status: "running" };
            runs.set(runId, { ...current, hijackRequestedAtMs, hijackTarget });
        }),
        clearRunHijack: (runId) => Effect.sync(() => {
            const current = runs.get(runId);
            if (current) {
                runs.set(runId, { ...current, hijackRequestedAtMs: null, hijackTarget: null });
            }
        }),
        getRun: (runId) => Effect.sync(() => runs.get(runId) ?? null),
        listRunAncestry: (runId, limit = 1000) => Effect.sync(() => {
            const rows = [];
            let current = runs.get(runId);
            let depth = 0;
            while (current && rows.length < limit) {
                rows.push({
                    runId: current.runId,
                    parentRunId: current.parentRunId ?? null,
                    depth,
                });
                current = current.parentRunId ? runs.get(current.parentRunId) : undefined;
                depth += 1;
            }
            return rows;
        }),
        getLatestChildRun: (parentRunId) => Effect.sync(() => [...runs.values()]
            .filter((run) => run.parentRunId === parentRunId)
            .sort((left, right) => (right.createdAtMs ?? 0) - (left.createdAtMs ?? 0))[0] ??
            null),
        listRuns: (limit = 50, status) => Effect.sync(() => applyLimit([...runs.values()]
            .filter((run) => !status || run.status === status)
            .sort((left, right) => (right.createdAtMs ?? 0) - (left.createdAtMs ?? 0)), limit)),
        listStaleRunningRuns: (staleBeforeMs, limit = 1000) => Effect.sync(() => applyLimit([...runs.values()]
            .filter((run) => run.status === "running" &&
            (run.heartbeatAtMs == null || run.heartbeatAtMs < staleBeforeMs))
            .map((run) => ({
            runId: run.runId,
            workflowPath: run.workflowPath ?? null,
            heartbeatAtMs: run.heartbeatAtMs ?? null,
            runtimeOwnerId: run.runtimeOwnerId ?? null,
            status: run.status,
        })), limit)),
        claimRunForResume: (params) => Effect.sync(() => {
            const run = runs.get(params.runId);
            if (!run)
                return false;
            const expectedStatus = params.expectedStatus ?? "running";
            const requireStale = params.requireStale ?? expectedStatus === "running";
            const stale = run.heartbeatAtMs == null || run.heartbeatAtMs < params.staleBeforeMs;
            if (run.status !== expectedStatus)
                return false;
            if ((run.runtimeOwnerId ?? null) !== params.expectedRuntimeOwnerId)
                return false;
            if ((run.heartbeatAtMs ?? null) !== params.expectedHeartbeatAtMs)
                return false;
            if (requireStale && !stale)
                return false;
            runs.set(params.runId, {
                ...run,
                runtimeOwnerId: params.claimOwnerId,
                heartbeatAtMs: params.claimHeartbeatAtMs,
            });
            return true;
        }),
        releaseRunResumeClaim: (params) => Effect.sync(() => {
            const run = runs.get(params.runId);
            if (run?.runtimeOwnerId === params.claimOwnerId) {
                runs.set(params.runId, {
                    ...run,
                    runtimeOwnerId: params.restoreRuntimeOwnerId,
                    heartbeatAtMs: params.restoreHeartbeatAtMs,
                });
            }
        }),
        updateClaimedRun: (params) => Effect.sync(() => {
            const run = runs.get(params.runId);
            if (!run)
                return false;
            if (run.runtimeOwnerId !== params.expectedRuntimeOwnerId)
                return false;
            if ((run.heartbeatAtMs ?? null) !== params.expectedHeartbeatAtMs)
                return false;
            runs.set(params.runId, { ...run, ...params.patch });
            return true;
        }),
        insertNode: (node) => Effect.sync(() => {
            nodes.set(nodeKey(node.runId, node.nodeId, node.iteration), node);
        }),
        getNode: (runId, nodeId, iteration) => Effect.sync(() => nodes.get(nodeKey(runId, nodeId, iteration)) ?? null),
        listNodeIterations: (runId, nodeId) => Effect.sync(() => [...nodes.values()]
            .filter((node) => node.runId === runId && node.nodeId === nodeId)
            .sort((left, right) => left.iteration - right.iteration)),
        listNodes: (runId) => Effect.sync(() => [...nodes.values()]
            .filter((node) => node.runId === runId)
            .sort((left, right) => left.updatedAtMs - right.updatedAtMs)),
        countNodesByState: (runId) => Effect.sync(() => {
            const counts = new Map();
            for (const node of nodes.values()) {
                if (node.runId !== runId)
                    continue;
                counts.set(node.state, (counts.get(node.state) ?? 0) + 1);
            }
            return [...counts.entries()].map(([state, count]) => ({ state, count }));
        }),
        upsertOutputRow: (tableName, key, row) => Effect.sync(() => {
            table(tableName).set(outputKey(key), { ...row, ...key });
        }),
        deleteOutputRow: (tableName, key) => Effect.sync(() => {
            table(tableName).delete(outputKey(key));
        }),
        getRawNodeOutput: (tableName, runId, nodeId) => Effect.sync(() => [...table(tableName).values()].find((row) => row.runId === runId && row.nodeId === nodeId) ?? null),
        getRawNodeOutputForIteration: (tableName, runId, nodeId, iteration) => Effect.sync(() => [...table(tableName).values()].find((row) => row.runId === runId &&
            row.nodeId === nodeId &&
            Number(row.iteration) === iteration) ?? null),
        insertAttempt: (attempt) => Effect.sync(() => {
            attempts.set(attemptKey(attempt.runId, attempt.nodeId, attempt.iteration, attempt.attempt), attempt);
        }),
        updateAttempt: (runId, nodeId, iteration, attempt, patch) => Effect.sync(() => {
            const key = attemptKey(runId, nodeId, iteration, attempt);
            const current = attempts.get(key);
            if (current)
                attempts.set(key, { ...current, ...patch });
        }),
        heartbeatAttempt: (runId, nodeId, iteration, attempt, heartbeatAtMs, heartbeatDataJson = null) => Effect.sync(() => {
            const key = attemptKey(runId, nodeId, iteration, attempt);
            const current = attempts.get(key);
            if (current)
                attempts.set(key, { ...current, heartbeatAtMs, heartbeatDataJson });
        }),
        listAttempts: (runId, nodeId, iteration) => Effect.sync(() => [...attempts.values()]
            .filter((attempt) => attempt.runId === runId &&
            attempt.nodeId === nodeId &&
            attempt.iteration === iteration)
            .sort((left, right) => left.attempt - right.attempt)),
        listAttemptsForRun: (runId) => Effect.sync(() => [...attempts.values()]
            .filter((attempt) => attempt.runId === runId)
            .sort((left, right) => left.startedAtMs - right.startedAtMs)),
        getAttempt: (runId, nodeId, iteration, attempt) => Effect.sync(() => attempts.get(attemptKey(runId, nodeId, iteration, attempt)) ?? null),
        listInProgressAttempts: (runId) => Effect.sync(() => [...attempts.values()].filter((attempt) => attempt.runId === runId && attempt.state === "in-progress")),
        listAllInProgressAttempts: () => Effect.sync(() => [...attempts.values()].filter((attempt) => attempt.state === "in-progress")),
        insertFrame: (frame) => Effect.sync(() => {
            frames.push(frame);
        }),
        getLastFrame: (runId) => Effect.sync(() => frames
            .filter((frame) => frame.runId === runId)
            .sort((left, right) => right.frameNo - left.frameNo)[0] ?? null),
        deleteFramesAfter: (runId, frameNo) => Effect.sync(() => {
            for (let index = frames.length - 1; index >= 0; index -= 1) {
                const frame = frames[index];
                if (frame.runId === runId && frame.frameNo > frameNo) {
                    frames.splice(index, 1);
                }
            }
        }),
        listFrames: (runId, limit, afterFrameNo) => Effect.sync(() => applyLimit(frames
            .filter((frame) => frame.runId === runId &&
            (afterFrameNo === undefined || frame.frameNo > afterFrameNo))
            .sort((left, right) => right.frameNo - left.frameNo), limit)),
        insertOrUpdateApproval: (approval) => Effect.sync(() => {
            approvals.set(approvalKey(approval.runId, approval.nodeId, approval.iteration), approval);
        }),
        getApproval: (runId, nodeId, iteration) => Effect.sync(() => approvals.get(approvalKey(runId, nodeId, iteration)) ?? null),
        listPendingApprovals: (runId) => Effect.sync(() => [...approvals.values()].filter((approval) => approval.runId === runId && approval.status === "pending")),
        listAllPendingApprovals: () => Effect.sync(() => [...approvals.values()].filter((approval) => approval.status === "pending")),
        listApprovalHistoryForNode: (workflowName, nodeId, limit = 50) => Effect.sync(() => {
            const runIds = new Set([...runs.values()]
                .filter((run) => run.workflowName === workflowName)
                .map((run) => run.runId));
            return applyLimit([...approvals.values()]
                .filter((approval) => approval.nodeId === nodeId && runIds.has(approval.runId))
                .sort((left, right) => (right.requestedAtMs ?? 0) - (left.requestedAtMs ?? 0)), limit);
        }),
        insertHumanRequest: (row) => Effect.sync(() => {
            humanRequests.set(row.requestId, row);
        }),
        getHumanRequest: (requestId) => Effect.sync(() => humanRequests.get(requestId) ?? null),
        reopenHumanRequest: (requestId) => Effect.sync(() => {
            const current = humanRequests.get(requestId);
            if (current) {
                humanRequests.set(requestId, {
                    ...current,
                    status: "pending",
                    responseJson: null,
                    answeredAtMs: null,
                    answeredBy: null,
                });
            }
        }),
        expireStaleHumanRequests: (nowMs = Date.now()) => Effect.sync(() => {
            const expired = [];
            for (const current of humanRequests.values()) {
                if (current.status === "pending" &&
                    current.timeoutAtMs != null &&
                    current.timeoutAtMs <= nowMs) {
                    const next = { ...current, status: "expired" };
                    humanRequests.set(current.requestId, next);
                    expired.push(next);
                }
            }
            return expired;
        }),
        listPendingHumanRequests: (nowMs = Date.now()) => Effect.sync(() => [...humanRequests.values()]
            .filter((request) => request.status === "pending" &&
            (request.timeoutAtMs == null || request.timeoutAtMs > nowMs))
            .map((request) => {
            const run = runs.get(request.runId);
            const node = nodes.get(nodeKey(request.runId, request.nodeId, request.iteration));
            return {
                ...request,
                workflowName: run?.workflowName ?? null,
                runStatus: run?.status ?? null,
                nodeLabel: node?.label ?? null,
            };
        })),
        answerHumanRequest: (requestId, responseJson, answeredBy = null, answeredAtMs = Date.now()) => Effect.sync(() => {
            const current = humanRequests.get(requestId);
            if (current) {
                humanRequests.set(requestId, {
                    ...current,
                    status: "answered",
                    responseJson,
                    answeredBy,
                    answeredAtMs,
                });
            }
        }),
        cancelHumanRequest: (requestId) => Effect.sync(() => {
            const current = humanRequests.get(requestId);
            if (current)
                humanRequests.set(requestId, { ...current, status: "cancelled" });
        }),
        insertAlert: (row) => Effect.sync(() => {
            alerts.set(row.alertId, row);
        }),
        getAlert: (alertId) => Effect.sync(() => alerts.get(alertId) ?? null),
        listAlerts: (limit = 100, statuses) => Effect.sync(() => applyLimit([...alerts.values()]
            .filter((alert) => !statuses || statuses.includes(alert.status))
            .sort((left, right) => right.firedAtMs - left.firedAtMs), limit)),
        acknowledgeAlert: (alertId, acknowledgedAtMs = Date.now()) => Effect.sync(() => {
            const current = alerts.get(alertId);
            if (current)
                alerts.set(alertId, { ...current, status: "acknowledged", acknowledgedAtMs });
        }),
        resolveAlert: (alertId, resolvedAtMs = Date.now()) => Effect.sync(() => {
            const current = alerts.get(alertId);
            if (current)
                alerts.set(alertId, { ...current, status: "resolved", resolvedAtMs });
        }),
        silenceAlert: (alertId) => Effect.sync(() => {
            const current = alerts.get(alertId);
            if (current)
                alerts.set(alertId, { ...current, status: "silenced" });
        }),
        insertSignalWithNextSeq: (row) => Effect.sync(() => {
            const existing = signals.find((signal) => signal.runId === row.runId &&
                signal.signalName === row.signalName &&
                signal.correlationId === row.correlationId &&
                signal.payloadJson === row.payloadJson &&
                signal.receivedAtMs === row.receivedAtMs &&
                (signal.receivedBy ?? null) === (row.receivedBy ?? null));
            if (existing)
                return existing.seq;
            const seq = Math.max(-1, ...signals.filter((signal) => signal.runId === row.runId).map((signal) => signal.seq)) + 1;
            signals.push({ ...row, receivedBy: row.receivedBy ?? null, seq });
            return seq;
        }),
        getLastSignalSeq: (runId) => Effect.sync(() => {
            const values = signals.filter((signal) => signal.runId === runId).map((signal) => signal.seq);
            return values.length > 0 ? Math.max(...values) : null;
        }),
        listSignals: (runId, query = {}) => Effect.sync(() => applyLimit(signals
            .filter((signal) => signal.runId === runId &&
            (!query.signalName || signal.signalName === query.signalName) &&
            (query.correlationId === undefined ||
                signal.correlationId === query.correlationId) &&
            (query.receivedAfterMs === undefined ||
                signal.receivedAtMs >= query.receivedAfterMs))
            .sort((left, right) => left.seq - right.seq), query.limit ?? 200)),
        insertToolCall: (row) => Effect.sync(() => {
            toolCalls.push(row);
        }),
        listToolCalls: (runId, nodeId, iteration) => Effect.sync(() => toolCalls.filter((row) => row.runId === runId && row.nodeId === nodeId && row.iteration === iteration)),
        upsertSandbox: (row) => Effect.sync(() => {
            sandboxes.set(sandboxKey(row.runId, row.sandboxId), row);
        }),
        getSandbox: (runId, sandboxId) => Effect.sync(() => sandboxes.get(sandboxKey(runId, sandboxId)) ?? null),
        listSandboxes: (runId) => Effect.sync(() => [...sandboxes.values()].filter((row) => row.runId === runId)),
        insertEvent: (row) => Effect.sync(() => {
            events.push(row);
        }),
        insertEventWithNextSeq: (row) => Effect.sync(() => {
            const existing = events.find((event) => event.runId === row.runId &&
                event.timestampMs === row.timestampMs &&
                event.type === row.type &&
                event.payloadJson === row.payloadJson);
            if (existing)
                return existing.seq;
            const seq = Math.max(-1, ...events.filter((event) => event.runId === row.runId).map((event) => event.seq)) + 1;
            events.push({ ...row, seq });
            return seq;
        }),
        getLastEventSeq: (runId) => Effect.sync(() => {
            const values = events.filter((event) => event.runId === runId).map((event) => event.seq);
            return values.length > 0 ? Math.max(...values) : null;
        }),
        listEventHistory: (runId, query = {}) => Effect.sync(() => applyLimit(events
            .filter((event) => event.runId === runId && eventMatchesQuery(event, query))
            .sort((left, right) => left.seq - right.seq), query.limit ?? 200)),
        countEventHistory: (runId, query = {}) => Effect.sync(() => events.filter((event) => event.runId === runId && eventMatchesQuery(event, query))
            .length),
        listEvents: (runId, afterSeq, limit = 200) => Effect.sync(() => applyLimit(events
            .filter((event) => event.runId === runId && event.seq > afterSeq)
            .sort((left, right) => left.seq - right.seq), limit)),
        listEventsByType: (runId, type) => Effect.sync(() => events
            .filter((event) => event.runId === runId && event.type === type)
            .sort((left, right) => left.seq - right.seq)),
        insertOrUpdateRalph: (row) => Effect.sync(() => {
            ralphs.set(ralphKey(row.runId, row.ralphId), row);
        }),
        listRalph: (runId) => Effect.sync(() => [...ralphs.values()].filter((row) => row.runId === runId)),
        getRalph: (runId, ralphId) => Effect.sync(() => ralphs.get(ralphKey(runId, ralphId)) ?? null),
        insertCache: (row) => Effect.sync(() => {
            caches.set(row.cacheKey, row);
        }),
        getCache: (cacheKey) => Effect.sync(() => caches.get(cacheKey) ?? null),
        listCacheByNode: (nodeId, outputTable, limit = 20) => Effect.sync(() => applyLimit([...caches.values()]
            .filter((cache) => cache.nodeId === nodeId &&
            (!outputTable || cache.outputTable === outputTable))
            .sort((left, right) => right.createdAtMs - left.createdAtMs), limit)),
        upsertCron: (row) => Effect.sync(() => {
            crons.set(row.cronId, row);
        }),
        listCrons: (enabledOnly = true) => Effect.sync(() => [...crons.values()].filter((cron) => !enabledOnly || cron.enabled !== false)),
        updateCronRunTime: (cronId, lastRunAtMs, nextRunAtMs, errorJson = null) => Effect.sync(() => {
            const current = crons.get(cronId);
            if (current)
                crons.set(cronId, { ...current, lastRunAtMs, nextRunAtMs, errorJson });
        }),
        deleteCron: (cronId) => Effect.sync(() => {
            crons.delete(cronId);
        }),
        insertScorerResult: (row) => Effect.sync(() => {
            scorerResults.push(row);
        }),
        listScorerResults: (runId, nodeId) => Effect.sync(() => scorerResults
            .filter((row) => row.runId === runId && (!nodeId || row.nodeId === nodeId))
            .sort((left, right) => (left.scoredAtMs ?? 0) - (right.scoredAtMs ?? 0))),
        withTransaction: (_label, effect) => effect,
    };
}
export const InMemoryStorageLive = Layer.sync(StorageService, makeInMemoryStorageService);
