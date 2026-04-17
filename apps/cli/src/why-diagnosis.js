// @smithers-type-exports-begin
/** @typedef {import("./WhyBlockerKind.ts").WhyBlockerKind} WhyBlockerKind */
// @smithers-type-exports-end

import { Effect } from "effect";
import { isRunHeartbeatFresh } from "@smithers/engine";
import { computeRetryDelayMs } from "@smithers/scheduler/computeRetryDelayMs";
import { SmithersError } from "@smithers/errors";
import { formatAge } from "./format.js";
/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./WhyBlocker.ts").WhyBlocker} WhyBlocker */
/** @typedef {import("./WhyDiagnosis.ts").WhyDiagnosis} WhyDiagnosis */

const RECENT_EVENTS_LIMIT = 50;
const MAX_CTA_COMMANDS = 5;
/**
 * @param {string} nodeId
 * @param {number} iteration
 */
function nodeKey(nodeId, iteration) {
    return `${nodeId}::${iteration}`;
}
/**
 * @param {string} nodeId
 */
function logicalNodeId(nodeId) {
    const marker = nodeId.indexOf("@@");
    return marker >= 0 ? nodeId.slice(0, marker) : nodeId;
}
/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
/**
 * @param {string | null | undefined} raw
 * @returns {Record<string, unknown>}
 */
function parseObjectJson(raw) {
    if (!raw)
        return {};
    try {
        const parsed = JSON.parse(raw);
        return isRecord(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
/**
 * @param {unknown} value
 * @returns {number | null}
 */
function parseNumber(value) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return null;
}
/**
 * @param {unknown} value
 * @returns {string | null}
 */
function parseString(value) {
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}
/**
 * @param {unknown} value
 * @returns {boolean}
 */
function parseBoolean(value) {
    if (typeof value === "boolean")
        return value;
    if (typeof value === "string") {
        return value === "true" || value === "1";
    }
    return false;
}
/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function parseStringArray(raw) {
    if (typeof raw !== "string")
        return [];
    const trimmed = raw.trim();
    if (!trimmed)
        return [];
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return parsed
                    .filter((entry) => typeof entry === "string")
                    .map((entry) => entry.trim())
                    .filter(Boolean);
            }
        }
        catch {
            // fall through to comma parsing
        }
    }
    if (trimmed.includes(",")) {
        return trimmed
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean);
    }
    return [trimmed];
}
/**
 * @param {unknown} raw
 * @returns {RetryPolicy | undefined}
 */
function parseRetryPolicy(raw) {
    if (typeof raw !== "string" || raw.trim().length === 0)
        return undefined;
    try {
        const parsed = JSON.parse(raw);
        if (!isRecord(parsed))
            return undefined;
        const initialDelayMs = parseNumber(parsed.initialDelayMs);
        const backoffRaw = parseString(parsed.backoff);
        const backoff = backoffRaw === "fixed" || backoffRaw === "linear" || backoffRaw === "exponential"
            ? backoffRaw
            : undefined;
        if (initialDelayMs == null && !backoff)
            return undefined;
        return {
            ...(initialDelayMs != null ? { initialDelayMs: Math.max(0, Math.floor(initialDelayMs)) } : {}),
            ...(backoff ? { backoff } : {}),
        };
    }
    catch {
        return undefined;
    }
}
/**
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
function parseErrorSummary(raw) {
    if (!raw)
        return null;
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === "string")
            return parsed;
        if (isRecord(parsed)) {
            const name = parseString(parsed.name);
            const message = parseString(parsed.message);
            if (name && message)
                return `${name}: ${message}`;
            if (message)
                return message;
            return JSON.stringify(parsed);
        }
        return String(parsed);
    }
    catch {
        return raw;
    }
}
/**
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
    if (ms <= 0)
        return "0s";
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ${minutes % 60}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
}
/**
 * @param {number} now
 * @param {Array<number | null | undefined>} ...candidates
 * @returns {number}
 */
function waitingSinceFallback(now, ...candidates) {
    for (const value of candidates) {
        if (typeof value === "number" && Number.isFinite(value))
            return value;
    }
    return now;
}
/**
 * @param {string | null} [metaJson]
 * @returns {TimerSnapshot | null}
 */
function parseTimerSnapshot(metaJson) {
    const meta = parseObjectJson(metaJson);
    const timer = isRecord(meta.timer) ? meta.timer : null;
    if (!timer)
        return null;
    const timerId = parseString(timer.timerId);
    const firesAtMs = parseNumber(timer.firesAtMs);
    if (!timerId || firesAtMs == null)
        return null;
    return {
        timerId,
        firesAtMs: Math.floor(firesAtMs),
    };
}
/**
 * @param {DbEventRow} row
 * @returns {Record<string, unknown> | null}
 */
function parseEventPayload(row) {
    try {
        const payload = JSON.parse(row.payloadJson);
        return isRecord(payload) ? payload : null;
    }
    catch {
        return null;
    }
}
/**
 * @param {string | null | undefined} xmlJson
 * @returns {Map<string, DescriptorMetadata>}
 */
function parseFrameDescriptorMetadata(xmlJson) {
    const metadata = new Map();
    if (!xmlJson)
        return metadata;
    let parsed;
    try {
        parsed = JSON.parse(xmlJson);
    }
    catch {
        return metadata;
    }
    if (!isRecord(parsed) || parsed.kind !== "element") {
        // Non-XML frame payloads (e.g. patch blobs) are ignored.
        return metadata;
    }
    /**
   * @param {unknown} node
   */
    const walk = (node) => {
        if (!isRecord(node))
            return;
        if (node.kind !== "element")
            return;
        const tag = parseString(node.tag) ?? "";
        const props = isRecord(node.props) ? node.props : {};
        const kind = tag === "smithers:task"
            ? "task"
            : tag === "smithers:wait-for-event"
                ? "wait-for-event"
                : tag === "smithers:timer"
                    ? "timer"
                    : tag === "smithers:subflow"
                        ? "subflow"
                        : "unknown";
        if (kind !== "unknown") {
            const id = parseString(props.id);
            if (id) {
                metadata.set(id, {
                    nodeId: id,
                    kind,
                    label: parseString(props.label),
                    dependsOn: parseStringArray(props.dependsOn),
                    continueOnFail: parseBoolean(props.continueOnFail),
                    retries: (() => {
                        const retries = parseNumber(props.retries);
                        return retries == null ? null : Math.max(0, Math.floor(retries));
                    })(),
                    heartbeatTimeoutMs: (() => {
                        const timeout = parseNumber(props.heartbeatTimeoutMs) ??
                            parseNumber(props.heartbeatTimeout);
                        return timeout == null || timeout <= 0
                            ? null
                            : Math.floor(timeout);
                    })(),
                    retryPolicy: parseRetryPolicy(props.retryPolicy),
                    eventName: parseString(props.__smithersEventName) ??
                        parseString(props.event) ??
                        null,
                    correlationId: parseString(props.__smithersCorrelationId) ??
                        parseString(props.correlationId) ??
                        null,
                    onTimeout: parseString(props.__smithersOnTimeout) ??
                        parseString(props.onTimeout) ??
                        null,
                    timerDuration: parseString(props.__smithersTimerDuration) ??
                        parseString(props.duration) ??
                        null,
                    timerUntil: parseString(props.__smithersTimerUntil) ??
                        parseString(props.until) ??
                        null,
                });
            }
        }
        const children = Array.isArray(node.children) ? node.children : [];
        for (const child of children) {
            walk(child);
        }
    };
    walk(parsed);
    return metadata;
}
/**
 * @param {Map<string, DescriptorMetadata>} metadataById
 * @param {string} nodeId
 * @returns {DescriptorMetadata | undefined}
 */
function resolveDescriptorMetadata(metadataById, nodeId) {
    return metadataById.get(nodeId) ?? metadataById.get(logicalNodeId(nodeId));
}
/**
 * @param {DescriptorMetadata | undefined} descriptor
 * @param {DbAttemptRow | undefined} attempt
 * @returns {number | null}
 */
function resolveHeartbeatTimeoutMs(descriptor, attempt) {
    if (descriptor?.heartbeatTimeoutMs != null) {
        return descriptor.heartbeatTimeoutMs;
    }
    if (!attempt?.metaJson)
        return null;
    const meta = parseObjectJson(attempt.metaJson);
    const timeout = parseNumber(meta.heartbeatTimeoutMs) ??
        parseNumber(meta.heartbeatTimeout);
    if (timeout == null || timeout <= 0)
        return null;
    return Math.floor(timeout);
}
/**
 * @param {DbNodeRow} node
 * @param {DbAttemptRow[]} attempts
 * @param {DescriptorMetadata | undefined} descriptor
 * @returns {RetryInsight | null}
 */
function buildRetryInsight(node, attempts, descriptor) {
    if (attempts.length === 0)
        return null;
    const failedAttempts = attempts.filter((attempt) => attempt.state === "failed");
    if (failedAttempts.length === 0)
        return null;
    failedAttempts.sort((a, b) => b.attempt - a.attempt);
    const newestAttempt = attempts[0];
    const latestFailed = failedAttempts[0];
    const latestFailedMeta = parseObjectJson(latestFailed.metaJson);
    const newestMeta = parseObjectJson(newestAttempt.metaJson);
    const retriesFromDescriptor = descriptor?.retries ?? null;
    const retriesFromAttempt = parseNumber(newestMeta.retries) ??
        parseNumber(latestFailedMeta.retries);
    const retries = retriesFromDescriptor != null
        ? retriesFromDescriptor
        : retriesFromAttempt != null
            ? Math.max(0, Math.floor(retriesFromAttempt))
            : null;
    const maxAttempts = retries != null ? retries + 1 : null;
    const failedCount = failedAttempts.length;
    const exhausted = maxAttempts != null ? failedCount >= maxAttempts : node.state === "failed";
    const retrying = !exhausted &&
        (node.state === "pending" ||
            node.state === "in-progress" ||
            node.state === "waiting-approval" ||
            node.state === "waiting-event" ||
            node.state === "waiting-timer");
    const retryPolicy = descriptor?.retryPolicy ??
        (() => {
            const candidate = newestMeta.retryPolicy ?? latestFailedMeta.retryPolicy;
            if (!isRecord(candidate))
                return undefined;
            const initialDelayMs = parseNumber(candidate.initialDelayMs);
            const backoffRaw = parseString(candidate.backoff);
            const backoff = backoffRaw === "fixed" || backoffRaw === "linear" || backoffRaw === "exponential"
                ? backoffRaw
                : undefined;
            if (initialDelayMs == null && !backoff)
                return undefined;
            return {
                ...(initialDelayMs != null ? { initialDelayMs: Math.max(0, Math.floor(initialDelayMs)) } : {}),
                ...(backoff ? { backoff } : {}),
            };
        })();
    let nextRetryAtMs = null;
    const lastFinishedAtMs = typeof latestFailed.finishedAtMs === "number"
        ? latestFailed.finishedAtMs
        : typeof latestFailed.startedAtMs === "number"
            ? latestFailed.startedAtMs
            : null;
    if (retrying && retryPolicy && lastFinishedAtMs != null) {
        const delayMs = computeRetryDelayMs(retryPolicy, latestFailed.attempt);
        if (delayMs > 0) {
            nextRetryAtMs = lastFinishedAtMs + delayMs;
        }
    }
    return {
        failedCount,
        maxAttempts,
        lastError: parseErrorSummary(latestFailed.errorJson),
        lastFailedAtMs: lastFinishedAtMs,
        exhausted,
        retrying,
        nextRetryAtMs,
    };
}
/**
 * @param {DbNodeRow} node
 * @param {DescriptorMetadata | undefined} descriptor
 * @param {DbAttemptRow[]} attempts
 * @param {ParsedEvent[]} events
 * @returns {{ signalName: string | null; correlationId: string | null }}
 */
function computeSignalName(node, descriptor, attempts, events) {
    let signalName = descriptor?.eventName ?? null;
    let correlationId = descriptor?.correlationId ?? null;
    for (const attempt of attempts) {
        const meta = parseObjectJson(attempt.metaJson);
        signalName =
            signalName ??
                parseString(meta.eventName) ??
                parseString(meta.event) ??
                parseString(meta.signalName) ??
                parseString(meta.signal) ??
                null;
        correlationId =
            correlationId ??
                parseString(meta.correlationId) ??
                null;
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        const payload = event.payload;
        if (!payload)
            continue;
        if (parseString(payload.nodeId) !== node.nodeId)
            continue;
        const iteration = parseNumber(payload.iteration);
        if (iteration != null && Math.floor(iteration) !== node.iteration)
            continue;
        signalName =
            signalName ??
                parseString(payload.eventName) ??
                parseString(payload.event) ??
                parseString(payload.signalName) ??
                parseString(payload.signal) ??
                null;
        correlationId =
            correlationId ??
                parseString(payload.correlationId) ??
                null;
        if (signalName && correlationId)
            break;
    }
    return { signalName, correlationId };
}
/**
 * @param {DbNodeRow} node
 * @param {DbAttemptRow[]} attempts
 * @param {ParsedEvent[]} events
 * @returns {TimerSnapshot | null}
 */
function computeTimerSnapshot(node, attempts, events) {
    for (const attempt of attempts) {
        const parsed = parseTimerSnapshot(attempt.metaJson);
        if (parsed)
            return parsed;
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        const payload = event.payload;
        if (!payload)
            continue;
        const payloadNodeId = parseString(payload.nodeId) ?? parseString(payload.timerId);
        if (payloadNodeId !== node.nodeId)
            continue;
        const firesAtMs = parseNumber(payload.firesAtMs);
        if (firesAtMs == null)
            continue;
        return { timerId: node.nodeId, firesAtMs: Math.floor(firesAtMs) };
    }
    return null;
}
/**
 * @param {DbNodeRow[]} nodes
 * @returns {string | null}
 */
function firstCurrentNode(nodes) {
    const inProgress = nodes
        .filter((node) => node.state === "in-progress")
        .sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0));
    if (inProgress.length > 0)
        return inProgress[0].nodeId;
    const pending = nodes
        .filter((node) => node.state === "pending")
        .sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0));
    return pending[0]?.nodeId ?? null;
}
/**
 * @param {RetryInsight} insight
 * @param {number} nowMs
 * @returns {string}
 */
function describeRetryContext(insight, nowMs) {
    const lines = [];
    const attemptCountLabel = insight.maxAttempts != null
        ? `attempt ${insight.failedCount} of ${insight.maxAttempts}`
        : `attempt ${insight.failedCount}`;
    if (insight.lastError) {
        lines.push(`Previous attempt failed (${attemptCountLabel}):`);
        lines.push(`  ${insight.lastError}`);
    }
    else {
        lines.push(`Previous attempt failed (${attemptCountLabel}).`);
    }
    if (insight.retrying) {
        if (insight.nextRetryAtMs != null && insight.nextRetryAtMs > nowMs) {
            lines.push(`Retrying automatically in ${formatDuration(insight.nextRetryAtMs - nowMs)}`);
        }
        else {
            lines.push("Retrying automatically");
        }
    }
    return lines.join("\n");
}
/**
 * @param {string} value
 * @returns {string}
 */
function shellEscape(value) {
    if (/^[a-zA-Z0-9._/:-]+$/.test(value))
        return value;
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}
/**
 * @param {DbRunRow} run
 */
function buildResumeUnblocker(run, force = false) {
    const workflowArg = run.workflowPath ? shellEscape(run.workflowPath) : "<workflow>";
    const forceFlag = force ? " --force true" : "";
    return `smithers up ${workflowArg} --run-id ${run.runId} --resume true${forceFlag}`;
}
/**
 * @param {DbRunRow} run
 * @param {string} nodeId
 * @param {number} iteration
 */
function buildRetryTaskUnblocker(run, nodeId, iteration, force = false) {
    const workflowArg = run.workflowPath ? shellEscape(run.workflowPath) : "<workflow>";
    const forceFlag = force ? " --force true" : "";
    return `smithers retry-task ${workflowArg} --run-id ${run.runId} --node-id ${shellEscape(nodeId)} --iteration ${iteration}${forceFlag}`;
}
/**
 * @param {WhyBlocker[]} blockers
 * @returns {WhyBlocker[]}
 */
function dedupeBlockers(blockers) {
    const seen = new Set();
    const deduped = [];
    for (const blocker of blockers) {
        const key = `${blocker.kind}:${blocker.nodeId}:${blocker.iteration ?? 0}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        deduped.push(blocker);
    }
    return deduped;
}
/**
 * @param {{ run: DbRunRow; nodes: DbNodeRow[]; approvals: DbApprovalRow[]; attempts: DbAttemptRow[]; events: DbEventRow[]; lastFrame: DbFrameRow | undefined; nowMs: number; }} params
 * @returns {WhyDiagnosis}
 */
function buildDiagnosis(params) {
    const { run, nodes, approvals, attempts, events, lastFrame, nowMs, } = params;
    const runId = run.runId;
    const status = run.status === "continued" && run.finishedAtMs == null
        ? "running"
        : String(run.status ?? "unknown");
    const descriptorMetadata = parseFrameDescriptorMetadata(lastFrame?.xmlJson);
    const parsedEvents = events.map((row) => ({
        row,
        payload: parseEventPayload(row),
    }));
    const nodesByKey = new Map();
    const nodesByLogicalId = new Map();
    for (const node of nodes) {
        const key = nodeKey(node.nodeId, node.iteration ?? 0);
        nodesByKey.set(key, node);
        const logical = logicalNodeId(node.nodeId);
        const existing = nodesByLogicalId.get(logical);
        if (existing) {
            existing.push(node);
        }
        else {
            nodesByLogicalId.set(logical, [node]);
        }
    }
    for (const group of nodesByLogicalId.values()) {
        group.sort((left, right) => (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0));
    }
    const attemptsByNode = new Map();
    for (const attempt of attempts) {
        const key = nodeKey(attempt.nodeId, attempt.iteration ?? 0);
        const existing = attemptsByNode.get(key);
        if (existing) {
            existing.push(attempt);
        }
        else {
            attemptsByNode.set(key, [attempt]);
        }
    }
    for (const group of attemptsByNode.values()) {
        group.sort((a, b) => b.attempt - a.attempt);
    }
    const retryInsightsByNode = new Map();
    for (const node of nodes) {
        const key = nodeKey(node.nodeId, node.iteration ?? 0);
        const insight = buildRetryInsight(node, attemptsByNode.get(key) ?? [], resolveDescriptorMetadata(descriptorMetadata, node.nodeId));
        if (insight)
            retryInsightsByNode.set(key, insight);
    }
    const blockers = [];
    for (const approval of approvals) {
        if (approval.status !== "requested")
            continue;
        const key = nodeKey(approval.nodeId, approval.iteration ?? 0);
        const node = nodesByKey.get(key);
        const retryInsight = retryInsightsByNode.get(key);
        const waitingSince = waitingSinceFallback(nowMs, approval.requestedAtMs, node?.updatedAtMs, run.startedAtMs, run.createdAtMs);
        const contextParts = [];
        if (retryInsight && !retryInsight.exhausted) {
            contextParts.push(describeRetryContext(retryInsight, nowMs));
        }
        contextParts.push(`Deny instead: smithers deny ${runId} --node ${approval.nodeId} --iteration ${approval.iteration ?? 0}`);
        blockers.push({
            kind: "waiting-approval",
            nodeId: approval.nodeId,
            iteration: approval.iteration ?? 0,
            reason: "Approval requested — no decision yet",
            waitingSince,
            unblocker: approvals.length > 1
                ? `smithers approve ${runId} --node ${approval.nodeId} --iteration ${approval.iteration ?? 0}`
                : `smithers approve ${runId}`,
            context: contextParts.join("\n\n"),
            ...(retryInsight
                ? {
                    attempt: retryInsight.failedCount,
                    maxAttempts: retryInsight.maxAttempts,
                }
                : {}),
        });
    }
    for (const node of nodes.filter((entry) => entry.state === "waiting-event")) {
        const key = nodeKey(node.nodeId, node.iteration ?? 0);
        const descriptor = resolveDescriptorMetadata(descriptorMetadata, node.nodeId);
        const nodeAttempts = attemptsByNode.get(key) ?? [];
        const { signalName, correlationId } = computeSignalName(node, descriptor, nodeAttempts, parsedEvents);
        const signalArg = signalName ? shellEscape(signalName) : "<signal-name>";
        const correlationFlag = correlationId ? ` --correlation ${shellEscape(correlationId)}` : "";
        const retryInsight = retryInsightsByNode.get(key);
        const contextParts = [];
        if (correlationId) {
            contextParts.push(`Correlation: ${correlationId}`);
        }
        if (descriptor?.onTimeout) {
            contextParts.push(`On timeout: ${descriptor.onTimeout}`);
        }
        if (retryInsight && !retryInsight.exhausted) {
            contextParts.push(describeRetryContext(retryInsight, nowMs));
        }
        blockers.push({
            kind: "waiting-event",
            nodeId: node.nodeId,
            iteration: node.iteration ?? 0,
            reason: signalName
                ? `waiting for signal '${signalName}'`
                : "waiting for signal",
            waitingSince: waitingSinceFallback(nowMs, node.updatedAtMs, run.startedAtMs, run.createdAtMs),
            unblocker: `smithers signal ${runId} ${signalArg} --data '{}'${correlationFlag}`,
            ...(contextParts.length > 0 ? { context: contextParts.join("\n") } : {}),
            signalName,
            ...(retryInsight
                ? {
                    attempt: retryInsight.failedCount,
                    maxAttempts: retryInsight.maxAttempts,
                }
                : {}),
        });
    }
    for (const node of nodes.filter((entry) => entry.state === "waiting-timer")) {
        const key = nodeKey(node.nodeId, node.iteration ?? 0);
        const snapshot = computeTimerSnapshot(node, attemptsByNode.get(key) ?? [], parsedEvents);
        const firesAtMs = snapshot?.firesAtMs ?? null;
        const remainingMs = firesAtMs == null ? null : Math.max(0, firesAtMs - nowMs);
        const timerLabel = snapshot?.timerId ?? node.nodeId;
        const contextParts = [];
        if (firesAtMs != null) {
            contextParts.push(`Fires at: ${new Date(firesAtMs).toISOString()}`);
            contextParts.push(`Time remaining: ${formatDuration(Math.max(0, firesAtMs - nowMs))}`);
        }
        blockers.push({
            kind: "waiting-timer",
            nodeId: node.nodeId,
            iteration: node.iteration ?? 0,
            reason: `waiting for timer '${timerLabel}'`,
            waitingSince: waitingSinceFallback(nowMs, node.updatedAtMs, run.startedAtMs, run.createdAtMs),
            unblocker: buildResumeUnblocker(run),
            ...(contextParts.length > 0 ? { context: contextParts.join("\n") } : {}),
            firesAtMs,
            remainingMs,
        });
    }
    for (const node of nodes.filter((entry) => entry.state === "in-progress")) {
        const key = nodeKey(node.nodeId, node.iteration ?? 0);
        const nodeAttempts = attemptsByNode.get(key) ?? [];
        const inProgressAttempt = nodeAttempts.find((attempt) => attempt.state === "in-progress");
        if (!inProgressAttempt)
            continue;
        const descriptor = resolveDescriptorMetadata(descriptorMetadata, node.nodeId);
        const heartbeatTimeoutMs = resolveHeartbeatTimeoutMs(descriptor, inProgressAttempt);
        if (heartbeatTimeoutMs == null)
            continue;
        const lastHeartbeatAtMs = typeof inProgressAttempt.heartbeatAtMs === "number"
            ? inProgressAttempt.heartbeatAtMs
            : typeof inProgressAttempt.startedAtMs === "number"
                ? inProgressAttempt.startedAtMs
                : null;
        if (lastHeartbeatAtMs == null)
            continue;
        const staleForMs = Math.max(0, nowMs - lastHeartbeatAtMs);
        if (staleForMs <= heartbeatTimeoutMs)
            continue;
        blockers.push({
            kind: "stale-task-heartbeat",
            nodeId: node.nodeId,
            iteration: node.iteration ?? 0,
            reason: `task ${node.nodeId} hasn't heartbeated in ${formatDuration(staleForMs)} (timeout: ${formatDuration(heartbeatTimeoutMs)})`,
            waitingSince: waitingSinceFallback(nowMs, lastHeartbeatAtMs, node.updatedAtMs, run.startedAtMs),
            unblocker: buildRetryTaskUnblocker(run, node.nodeId, node.iteration ?? 0, run.status === "running"),
            context: `Attempt ${inProgressAttempt.attempt}`,
            attempt: inProgressAttempt.attempt,
            maxAttempts: descriptor?.retries != null ? descriptor.retries + 1 : null,
        });
    }
    for (const node of nodes.filter((entry) => entry.state === "failed")) {
        const key = nodeKey(node.nodeId, node.iteration ?? 0);
        const insight = retryInsightsByNode.get(key);
        if (!insight)
            continue;
        if (!insight.exhausted && status !== "failed")
            continue;
        blockers.push({
            kind: "retries-exhausted",
            nodeId: node.nodeId,
            iteration: node.iteration ?? 0,
            reason: insight.lastError
                ? `All retries exhausted. Last error: ${insight.lastError}`
                : "All retries exhausted.",
            waitingSince: waitingSinceFallback(nowMs, insight.lastFailedAtMs, node.updatedAtMs, run.finishedAtMs, run.startedAtMs),
            unblocker: buildResumeUnblocker(run),
            context: insight.maxAttempts != null
                ? `Attempt ${insight.failedCount} of ${insight.maxAttempts}`
                : `Attempt ${insight.failedCount}`,
            attempt: insight.failedCount,
            maxAttempts: insight.maxAttempts,
        });
    }
    const primaryBlockedNodes = new Set(blockers.map((blocker) => nodeKey(blocker.nodeId, blocker.iteration ?? 0)));
    for (const node of nodes) {
        const key = nodeKey(node.nodeId, node.iteration ?? 0);
        if (primaryBlockedNodes.has(key))
            continue;
        const insight = retryInsightsByNode.get(key);
        if (!insight || insight.exhausted || !insight.retrying)
            continue;
        blockers.push({
            kind: "retry-backoff",
            nodeId: node.nodeId,
            iteration: node.iteration ?? 0,
            reason: insight.nextRetryAtMs != null && insight.nextRetryAtMs > nowMs
                ? `Previous attempt failed — retrying automatically in ${formatDuration(insight.nextRetryAtMs - nowMs)}`
                : "Previous attempt failed — retrying automatically",
            waitingSince: waitingSinceFallback(nowMs, insight.lastFailedAtMs, node.updatedAtMs, run.startedAtMs),
            unblocker: buildRetryTaskUnblocker(run, node.nodeId, node.iteration ?? 0, run.status === "running"),
            context: describeRetryContext(insight, nowMs),
            attempt: insight.failedCount,
            maxAttempts: insight.maxAttempts,
        });
    }
    for (const node of nodes.filter((entry) => entry.state === "pending")) {
        const descriptor = resolveDescriptorMetadata(descriptorMetadata, node.nodeId);
        const dependsOn = descriptor?.dependsOn ?? [];
        if (dependsOn.length === 0)
            continue;
        for (const dependencyId of dependsOn) {
            const candidateNodes = nodesByLogicalId.get(logicalNodeId(dependencyId)) ?? [];
            const failedDependency = candidateNodes.find((candidate) => candidate.state === "failed");
            if (!failedDependency)
                continue;
            const failedDescriptor = resolveDescriptorMetadata(descriptorMetadata, failedDependency.nodeId);
            if (failedDescriptor?.continueOnFail)
                continue;
            blockers.push({
                kind: "dependency-failed",
                nodeId: node.nodeId,
                iteration: node.iteration ?? 0,
                reason: `Node ${node.nodeId} is blocked because dependency ${failedDependency.nodeId} failed.`,
                waitingSince: waitingSinceFallback(nowMs, node.updatedAtMs, failedDependency.updatedAtMs, run.startedAtMs),
                unblocker: buildResumeUnblocker(run),
                dependencyNodeId: failedDependency.nodeId,
            });
            break;
        }
    }
    if (status === "running" && !isRunHeartbeatFresh(run, nowMs)) {
        const lastHeartbeatAtMs = typeof run.heartbeatAtMs === "number" ? run.heartbeatAtMs : null;
        blockers.push({
            kind: "stale-heartbeat",
            nodeId: "(run-level)",
            iteration: null,
            reason: lastHeartbeatAtMs != null
                ? `Run appears orphaned (last heartbeat ${formatDuration(Math.max(0, nowMs - lastHeartbeatAtMs))} ago)`
                : "Run appears orphaned (no heartbeat recorded)",
            waitingSince: waitingSinceFallback(nowMs, lastHeartbeatAtMs, run.startedAtMs, run.createdAtMs),
            unblocker: buildResumeUnblocker(run, true),
        });
    }
    const dedupedBlockers = dedupeBlockers(blockers);
    let summary;
    if (status === "finished") {
        summary = "Run is finished, nothing is blocked.";
    }
    else if (status === "cancelled") {
        summary =
            typeof run.finishedAtMs === "number"
                ? `Run was cancelled at ${new Date(run.finishedAtMs).toISOString()}.`
                : "Run was cancelled.";
    }
    else if (status === "running" &&
        isRunHeartbeatFresh(run, nowMs) &&
        dedupedBlockers.length === 0) {
        const currentNode = firstCurrentNode(nodes);
        summary = currentNode
            ? `Run is executing normally. Currently on node ${currentNode}.`
            : "Run is executing normally.";
    }
    else if (dedupedBlockers.length === 0) {
        summary = `Run is ${status}. No blockers were identified.`;
    }
    else {
        summary = `Run ${runId} is ${status}`;
    }
    return {
        runId,
        status,
        summary,
        generatedAtMs: nowMs,
        blockers: dedupedBlockers.sort((left, right) => left.waitingSince - right.waitingSince),
        currentNodeId: firstCurrentNode(nodes),
    };
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Effect.Effect<WhyDiagnosis, SmithersError>}
 */
export function diagnoseRunEffect(adapter, runId, nowMs = Date.now()) {
    return Effect.withLogSpan("why:diagnose")(Effect.gen(function* () {
        const [run, nodes, approvals, attempts, lastSeq, lastFrame] = yield* Effect.all([
            adapter.getRunEffect(runId),
            adapter.listNodesEffect(runId),
            adapter.listPendingApprovalsEffect(runId),
            adapter.listAttemptsForRunEffect(runId),
            adapter.getLastEventSeqEffect(runId),
            adapter.getLastFrameEffect(runId),
        ]);
        if (!run) {
            return yield* Effect.fail(new SmithersError("RUN_NOT_FOUND", `Run not found: ${runId}`));
        }
        const afterSeq = Math.max(-1, (lastSeq ?? -1) - RECENT_EVENTS_LIMIT);
        const events = yield* adapter.listEventHistoryEffect(runId, {
            afterSeq,
            limit: RECENT_EVENTS_LIMIT,
        });
        const diagnosis = buildDiagnosis({
            run: run,
            nodes: nodes ?? [],
            approvals: approvals ?? [],
            attempts: attempts ?? [],
            events: events ?? [],
            lastFrame: lastFrame,
            nowMs,
        });
        return yield* Effect.succeed(diagnosis).pipe(Effect.annotateLogs({
            status: diagnosis.status,
            blockerCount: diagnosis.blockers.length,
        }));
    })).pipe(Effect.annotateLogs({ runId }));
}
/**
 * @param {WhyDiagnosis} diagnosis
 * @returns {string}
 */
export function renderWhyDiagnosisHuman(diagnosis) {
    if (diagnosis.status === "finished") {
        return "Run is finished, nothing is blocked.";
    }
    if (diagnosis.status === "cancelled") {
        return diagnosis.summary;
    }
    if (diagnosis.status === "running" &&
        diagnosis.blockers.length === 0 &&
        diagnosis.summary.startsWith("Run is executing normally")) {
        return diagnosis.summary;
    }
    const lines = [];
    lines.push(`Run ${diagnosis.runId} is ${diagnosis.status}`);
    if (diagnosis.blockers.length === 0) {
        lines.push("");
        lines.push(diagnosis.summary);
        return lines.join("\n");
    }
    for (const blocker of diagnosis.blockers) {
        lines.push("");
        lines.push(`  Blocked node:  ${blocker.nodeId} (iteration ${blocker.iteration ?? 0})`);
        lines.push(`  Waiting since: ${formatAge(blocker.waitingSince)} (${new Date(blocker.waitingSince).toISOString()})`);
        lines.push(`  Reason:        ${blocker.reason}`);
        lines.push(`  Unblock:       ${blocker.unblocker}`);
        if (typeof blocker.firesAtMs === "number") {
            lines.push(`  Fires at:      ${new Date(blocker.firesAtMs).toISOString()}`);
        }
        if (typeof blocker.remainingMs === "number") {
            lines.push(`  Time remaining:${blocker.remainingMs >= 0 ? " " : ""}${formatDuration(Math.max(0, blocker.remainingMs))}`);
        }
        if (blocker.context) {
            lines.push("");
            for (const line of blocker.context.split("\n")) {
                lines.push(`  ${line}`);
            }
        }
    }
    return lines.join("\n");
}
/**
 * @param {string} command
 * @returns {string}
 */
function stripSmithersPrefix(command) {
    return command.startsWith("smithers ") ? command.slice("smithers ".length) : command;
}
/**
 * @param {WhyDiagnosis} diagnosis
 * @returns {Array<{ command: string; description: string }>}
 */
export function diagnosisCtaCommands(diagnosis) {
    const mapping = {
        "waiting-approval": "Approve pending gate",
        "waiting-event": "Send expected signal",
        "waiting-timer": "Resume once timer is due",
        "stale-task-heartbeat": "Retry timed-out task",
        "retry-backoff": "Retry blocked node",
        "retries-exhausted": "Resume run after fixing failure",
        "stale-heartbeat": "Force resume orphaned run",
        "dependency-failed": "Resume after dependency fix",
    };
    const unique = new Map();
    for (const blocker of diagnosis.blockers) {
        const command = stripSmithersPrefix(blocker.unblocker);
        if (!command || command.includes("<"))
            continue;
        if (!unique.has(command)) {
            unique.set(command, {
                command,
                description: mapping[blocker.kind] ?? "Unblock run",
            });
        }
        if (unique.size >= MAX_CTA_COMMANDS)
            break;
    }
    const ctas = [...unique.values()];
    ctas.push({ command: `inspect ${diagnosis.runId}`, description: "Inspect run state" }, { command: `logs ${diagnosis.runId}`, description: "Tail run logs" });
    const deduped = new Map();
    for (const entry of ctas) {
        if (!deduped.has(entry.command))
            deduped.set(entry.command, entry);
    }
    return [...deduped.values()].slice(0, MAX_CTA_COMMANDS + 2);
}
