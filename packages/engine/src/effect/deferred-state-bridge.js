import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Effect, Exit } from "effect";
import { buildOutputRow, describeSchemaShape, selectOutputRow, stripAutoColumns, validateExistingOutput, validateOutput, } from "@smithers/db/output";
import { awaitApprovalDurableDeferred, awaitWaitForEventDurableDeferred, bridgeApprovalResolve, bridgeWaitForEventResolve, } from "./durable-deferred-bridge.js";
import { EventBus } from "../events.js";
import { buildHumanRequestId, getHumanTaskPrompt as getStoredHumanTaskPrompt, isHumanTaskMeta, } from "../human-requests.js";
import { parseAttemptMetaJson } from "./bridge-utils.js";
import { updateAsyncExternalWaitPending } from "@smithers/observability/metrics";
import { markdownComponents } from "@smithers/components/markdownComponents";
import { errorToJson } from "@smithers/errors/errorToJson";
import { SmithersError } from "@smithers/errors/SmithersError";
import { nowMs } from "@smithers/scheduler/nowMs";
/**
 * @typedef {"pending" | "waiting-approval" | "waiting-event" | "waiting-timer" | "finished" | "failed" | "skipped"} DeferredBridgeState
 */
/**
 * @typedef {{ handled: false; } | { handled: true; state: DeferredBridgeState; }} DeferredBridgeResolution
 */
/**
 * @typedef {(state: "pending" | "failed" | "skipped") => Promise<void>} DeferredBridgeStateEmitter
 */
/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers/db/adapter/ApprovalRow").ApprovalRow} ApprovalRow */
/** @typedef {import("@smithers/graph/TaskDescriptor").TaskDescriptor} TaskDescriptor */
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase<Record<string, unknown>>} BunSQLiteDatabase */

const timerDurationMultipliers = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
};
/**
 * @param {"approval" | "event"} kind
 * @param {number} delta
 */
async function updateAsyncExternalWaitPendingSafe(kind, delta) {
    try {
        await Effect.runPromise(updateAsyncExternalWaitPending(kind, delta));
    }
    catch { }
}
/**
 * @param {Pick<WaitForEventSnapshot, "waitAsync" | "resolvedSignalSeq"> | null | undefined} snapshot
 */
function shouldClearAsyncWaitMetric(snapshot) {
    return Boolean(snapshot?.waitAsync &&
        !Number.isFinite(Number(snapshot.resolvedSignalSeq)));
}
/**
 * @param {TaskDescriptor} desc
 */
function buildApprovalRequestJson(desc) {
    return JSON.stringify({
        mode: desc.approvalMode ?? "gate",
        waitAsync: desc.waitAsync === true,
        title: desc.label ?? null,
        summary: desc.meta && typeof desc.meta.requestSummary === "string"
            ? desc.meta.requestSummary
            : null,
        options: desc.approvalOptions ?? [],
        allowedScopes: desc.approvalAllowedScopes ?? [],
        allowedUsers: desc.approvalAllowedUsers ?? [],
        autoApprove: desc.approvalAutoApprove ?? null,
    });
}
/**
 * @param {TaskDescriptor} desc
 * @returns {string | null}
 */
function buildHumanRequestSchemaJson(desc) {
    if (!desc.outputSchema && !desc.outputTable) {
        return null;
    }
    return describeSchemaShape((desc.outputSchema ?? desc.outputTable), desc.outputSchema);
}
/**
 * @param {unknown} prompt
 * @returns {string}
 */
function renderHumanPromptToText(prompt) {
    if (prompt == null)
        return "";
    if (typeof prompt === "string")
        return prompt;
    if (typeof prompt === "number")
        return String(prompt);
    try {
        let element;
        if (React.isValidElement(prompt)) {
            element = React.cloneElement(prompt, {
                components: markdownComponents,
            });
        }
        else {
            element = React.createElement(React.Fragment, null, prompt);
        }
        return renderToStaticMarkup(element)
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }
    catch {
        const result = String(prompt ?? "");
        if (result === "[object Object]") {
            throw new SmithersError("MDX_PRELOAD_INACTIVE", "HumanTask prompt could not be rendered because the MDX preload is inactive.");
        }
        return result;
    }
}
/**
 * @param {Record<string, unknown> | null | undefined} meta
 * @param {string} fallback
 * @returns {string}
 */
function getHumanTaskPrompt(meta, fallback) {
    const renderedPrompt = renderHumanPromptToText(meta?.prompt);
    return renderedPrompt.trim().length > 0
        ? renderedPrompt
        : getStoredHumanTaskPrompt(meta, fallback);
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {TaskDescriptor} desc
 * @param {number} requestedAtMs
 */
async function ensurePendingHumanRequest(adapter, runId, desc, requestedAtMs) {
    if (!isHumanTaskMeta(desc.meta)) {
        return;
    }
    const requestId = buildHumanRequestId(runId, desc.nodeId, desc.iteration);
    const existing = await Effect.runPromise(adapter.getHumanRequest(requestId));
    if (existing) {
        return;
    }
    await Effect.runPromise(adapter.insertHumanRequest({
        requestId,
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        kind: "json",
        status: "pending",
        prompt: getHumanTaskPrompt(desc.meta, desc.label ?? desc.nodeId),
        schemaJson: buildHumanRequestSchemaJson(desc),
        optionsJson: null,
        responseJson: null,
        requestedAtMs,
        answeredAtMs: null,
        answeredBy: null,
        timeoutAtMs: typeof desc.timeoutMs === "number" ? requestedAtMs + desc.timeoutMs : null,
    }));
}
const HUMAN_REQUEST_REOPEN_ERROR_CODES = new Set([
    "HUMAN_TASK_INVALID_JSON",
    "HUMAN_TASK_VALIDATION_FAILED",
]);
/**
 * @param {string | null} [errorJson]
 * @returns {string | null}
 */
function parseAttemptErrorCode(errorJson) {
    if (!errorJson) {
        return null;
    }
    try {
        const parsed = JSON.parse(errorJson);
        return typeof parsed?.code === "string" ? parsed.code : null;
    }
    catch {
        return null;
    }
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {TaskDescriptor} desc
 */
async function reconcileHumanRequestValidationFailure(adapter, runId, desc) {
    if (!isHumanTaskMeta(desc.meta)) {
        return undefined;
    }
    const requestId = buildHumanRequestId(runId, desc.nodeId, desc.iteration);
    const request = await Effect.runPromise(adapter.getHumanRequest(requestId));
    if (!request || request.status !== "answered") {
        return request;
    }
    const attempts = await Effect.runPromise(adapter.listAttempts(runId, desc.nodeId, desc.iteration));
    const latestAttempt = attempts[0];
    if (latestAttempt?.state !== "failed" ||
        !HUMAN_REQUEST_REOPEN_ERROR_CODES.has(parseAttemptErrorCode(latestAttempt?.errorJson) ?? "")) {
        return request;
    }
    if (typeof request.answeredAtMs === "number" &&
        typeof latestAttempt?.finishedAtMs === "number" &&
        request.answeredAtMs > latestAttempt.finishedAtMs) {
        return request;
    }
    await Effect.runPromise(adapter.reopenHumanRequest(requestId));
    return {
        ...request,
        status: "pending",
        responseJson: null,
        answeredAtMs: null,
        answeredBy: null,
    };
}
/**
 * @param {TaskDescriptor} desc
 */
function defaultAutoApprovalDecision(desc) {
    if (desc.approvalMode === "select") {
        const selected = desc.approvalOptions?.[0]?.key;
        return selected ? { selected, notes: "Automatically selected" } : null;
    }
    if (desc.approvalMode === "rank") {
        const ranked = desc.approvalOptions?.map((option) => option.key) ?? [];
        return { ranked, notes: "Automatically ranked" };
    }
    return null;
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {TaskDescriptor} desc
 */
async function shouldAutoApprove(adapter, runId, desc) {
    const config = desc.approvalAutoApprove;
    if (!config) {
        return false;
    }
    if (config.revertOnMet) {
        return false;
    }
    if (config.conditionMet === false) {
        return false;
    }
    const after = typeof config.after === "number" ? config.after : 0;
    if (after <= 0) {
        return true;
    }
    const run = await Effect.runPromise(adapter.getRun(runId));
    if (!run?.workflowName) {
        return false;
    }
    const history = await Effect.runPromise(adapter.listApprovalHistoryForNode(run.workflowName, desc.nodeId, after + 10));
    let consecutive = 0;
    for (const entry of history) {
        if (entry.runId === runId) {
            continue;
        }
        if (entry.autoApproved) {
            continue;
        }
        if (entry.status === "approved") {
            consecutive += 1;
            if (consecutive >= after) {
                return true;
            }
            continue;
        }
        if (entry.status === "denied") {
            return false;
        }
    }
    return false;
}
/**
 * @param {TaskDescriptor} desc
 * @returns {boolean}
 */
export function isBridgeManagedTimerTask(desc) {
    return Boolean(desc.meta && desc.meta.__timer);
}
/**
 * @param {TaskDescriptor} desc
 * @returns {boolean}
 */
export function isBridgeManagedWaitForEventTask(desc) {
    return Boolean(desc.meta && desc.meta.__waitForEvent);
}
/**
 * @param {TaskDescriptor} desc
 * @returns {TimerType}
 */
function parseTimerType(desc) {
    const raw = desc.meta?.__timerType;
    return raw === "absolute" ? "absolute" : "duration";
}
/**
 * @param {TaskDescriptor} desc
 * @returns {string}
 */
function parseWaitForEventSignalName(desc) {
    const signalName = String(desc.meta?.__eventName ?? "").trim();
    if (!signalName) {
        throw new SmithersError("INVALID_INPUT", `WaitForEvent ${desc.nodeId} is missing event metadata.`, { nodeId: desc.nodeId });
    }
    return signalName;
}
/**
 * @param {TaskDescriptor} desc
 * @returns {string | undefined}
 */
function parseWaitForEventCorrelationId(desc) {
    const raw = desc.meta?.__correlationId;
    return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}
/**
 * @param {TaskDescriptor} desc
 * @returns {WaitForEventOnTimeout}
 */
function parseWaitForEventOnTimeout(desc) {
    const raw = desc.meta?.__onTimeout;
    return raw === "continue" || raw === "skip" ? raw : "fail";
}
/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function parseOptionalFiniteNumber(value) {
    if (value == null || value === "") {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
/**
 * @param {TaskDescriptor} desc
 * @param {number} startedAtMs
 * @returns {WaitForEventSnapshot}
 */
function buildWaitForEventSnapshot(desc, startedAtMs) {
    return {
        signalName: parseWaitForEventSignalName(desc),
        correlationId: parseWaitForEventCorrelationId(desc),
        onTimeout: parseWaitForEventOnTimeout(desc),
        timeoutMs: typeof desc.timeoutMs === "number" && Number.isFinite(desc.timeoutMs)
            ? desc.timeoutMs
            : null,
        waitAsync: desc.waitAsync === true,
        startedAtMs,
    };
}
/**
 * @param {string | null} [metaJson]
 * @returns {WaitForEventSnapshot | null}
 */
function parseWaitForEventSnapshot(metaJson) {
    const meta = parseAttemptMetaJson(metaJson);
    const waitForEvent = meta.waitForEvent;
    if (!waitForEvent ||
        typeof waitForEvent !== "object" ||
        Array.isArray(waitForEvent)) {
        return null;
    }
    const signalName = typeof waitForEvent.signalName === "string"
        ? waitForEvent.signalName
        : null;
    const startedAtMs = Number(waitForEvent.startedAtMs);
    if (!signalName || !Number.isFinite(startedAtMs)) {
        return null;
    }
    const timeoutMsRaw = waitForEvent.timeoutMs;
    const timeoutMs = timeoutMsRaw == null || timeoutMsRaw === ""
        ? null
        : Number.isFinite(Number(timeoutMsRaw))
            ? Number(timeoutMsRaw)
            : null;
    const resolvedSignalSeqRaw = waitForEvent.resolvedSignalSeq;
    const receivedAtMsRaw = waitForEvent.receivedAtMs;
    const timedOutAtMsRaw = waitForEvent.timedOutAtMs;
    return {
        signalName,
        correlationId: typeof waitForEvent.correlationId === "string"
            ? waitForEvent.correlationId
            : undefined,
        onTimeout: waitForEvent.onTimeout === "continue" ||
            waitForEvent.onTimeout === "skip"
            ? waitForEvent.onTimeout
            : "fail",
        timeoutMs,
        waitAsync: waitForEvent.waitAsync === true,
        startedAtMs,
        resolvedSignalSeq: parseOptionalFiniteNumber(resolvedSignalSeqRaw),
        receivedAtMs: parseOptionalFiniteNumber(receivedAtMsRaw),
        timedOutAtMs: parseOptionalFiniteNumber(timedOutAtMsRaw),
    };
}
/**
 * @param {WaitForEventSnapshot} snapshot
 * @returns {Record<string, unknown>}
 */
function buildWaitForEventAttemptMeta(snapshot) {
    return {
        kind: "wait-for-event",
        waitForEvent: {
            signalName: snapshot.signalName,
            correlationId: snapshot.correlationId ?? null,
            onTimeout: snapshot.onTimeout,
            timeoutMs: snapshot.timeoutMs,
            waitAsync: snapshot.waitAsync === true,
            startedAtMs: snapshot.startedAtMs,
            resolvedSignalSeq: snapshot.resolvedSignalSeq ?? null,
            receivedAtMs: snapshot.receivedAtMs ?? null,
            timedOutAtMs: snapshot.timedOutAtMs ?? null,
        },
    };
}
/**
 * @param {string} raw
 * @param {string} nodeId
 * @returns {number}
 */
function parseTimerDurationMs(raw, nodeId) {
    const input = raw.trim().toLowerCase();
    const match = input.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
    if (!match) {
        throw new SmithersError("INVALID_INPUT", `Timer ${nodeId} has invalid duration "${raw}". Use formats like 500ms, 10s, 2m.`, { nodeId, duration: raw });
    }
    const value = Number(match[1]);
    const unit = match[2] ?? "ms";
    const multiplier = timerDurationMultipliers[unit];
    const ms = Math.floor(value * multiplier);
    if (!Number.isFinite(ms) || ms < 0) {
        throw new SmithersError("INVALID_INPUT", `Timer ${nodeId} duration "${raw}" is not valid.`, { nodeId, duration: raw });
    }
    return ms;
}
/**
 * @param {string} raw
 * @param {string} nodeId
 * @returns {number}
 */
function parseTimerUntilMs(raw, nodeId) {
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) {
        throw new SmithersError("INVALID_INPUT", `Timer ${nodeId} has invalid "until" timestamp "${raw}".`, { nodeId, until: raw });
    }
    return Math.floor(parsed);
}
/**
 * @param {TaskDescriptor} desc
 * @param {number} createdAtMs
 * @returns {TimerSnapshot}
 */
function buildTimerSnapshot(desc, createdAtMs) {
    const timerType = parseTimerType(desc);
    const timerId = desc.nodeId;
    if (timerType === "duration") {
        const duration = String(desc.meta?.__timerDuration ?? "").trim();
        if (!duration) {
            throw new SmithersError("INVALID_INPUT", `Timer ${timerId} is missing duration metadata.`, { nodeId: timerId });
        }
        const delayMs = parseTimerDurationMs(duration, timerId);
        return {
            timerId,
            timerType,
            duration,
            createdAtMs,
            firesAtMs: createdAtMs + delayMs,
        };
    }
    const until = String(desc.meta?.__timerUntil ?? "").trim();
    if (!until) {
        throw new SmithersError("INVALID_INPUT", `Timer ${timerId} is missing until metadata.`, { nodeId: timerId });
    }
    return {
        timerId,
        timerType,
        until,
        createdAtMs,
        firesAtMs: parseTimerUntilMs(until, timerId),
    };
}
/**
 * @param {string | null} [metaJson]
 * @returns {TimerSnapshot | null}
 */
function parseTimerSnapshot(metaJson) {
    const meta = parseAttemptMetaJson(metaJson);
    const timer = meta.timer;
    if (!timer || typeof timer !== "object" || Array.isArray(timer))
        return null;
    const timerId = typeof timer.timerId === "string" ? timer.timerId : null;
    const timerType = timer.timerType === "absolute" ? "absolute" : "duration";
    const createdAtMs = Number(timer.createdAtMs);
    const firesAtMs = Number(timer.firesAtMs);
    if (!timerId || !Number.isFinite(createdAtMs) || !Number.isFinite(firesAtMs)) {
        return null;
    }
    const firedAtRaw = timer.firedAtMs;
    const firedAtMs = Number.isFinite(Number(firedAtRaw))
        ? Number(firedAtRaw)
        : undefined;
    return {
        timerId,
        timerType,
        createdAtMs,
        firesAtMs,
        firedAtMs,
        duration: typeof timer.duration === "string"
            ? timer.duration
            : undefined,
        until: typeof timer.until === "string"
            ? timer.until
            : undefined,
    };
}
/**
 * @param {TimerSnapshot} snapshot
 * @returns {Record<string, unknown>}
 */
function buildTimerAttemptMeta(snapshot) {
    return {
        kind: "timer",
        timer: {
            timerId: snapshot.timerId,
            timerType: snapshot.timerType,
            duration: snapshot.duration ?? null,
            until: snapshot.until ?? null,
            createdAtMs: snapshot.createdAtMs,
            firesAtMs: snapshot.firesAtMs,
            firedAtMs: snapshot.firedAtMs ?? null,
        },
    };
}
/**
 * @param {TaskDescriptor} desc
 * @param {string} runId
 * @param {unknown} payload
 * @returns {Record<string, unknown>}
 */
function validateDeferredOutputPayload(desc, runId, payload) {
    if (!desc.outputTable) {
        throw new SmithersError("TASK_MISSING_OUTPUT", `Task ${desc.nodeId} is missing a resolved output table.`, { nodeId: desc.nodeId });
    }
    const cleanPayload = stripAutoColumns(payload);
    const payloadWithKeys = buildOutputRow(desc.outputTable, runId, desc.nodeId, desc.iteration, cleanPayload);
    let validation = validateOutput(desc.outputTable, payloadWithKeys);
    if (validation.ok && desc.outputSchema) {
        const zodResult = desc.outputSchema.safeParse(cleanPayload);
        if (!zodResult.success) {
            validation = { ok: false, error: zodResult.error };
        }
    }
    if (!validation.ok) {
        throw validation.error;
    }
    return validation.data;
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {TaskDescriptor} desc
 * @param {EventBus} eventBus
 * @returns {Promise<DeferredBridgeResolution>}
 */
async function resolveTimerTaskStateBridge(adapter, runId, desc, eventBus) {
    if (!isBridgeManagedTimerTask(desc)) {
        return { handled: false };
    }
    const now = nowMs();
    const attempts = await Effect.runPromise(adapter.listAttempts(runId, desc.nodeId, desc.iteration));
    const latest = attempts[0];
    const latestTimerSnapshot = parseTimerSnapshot(latest?.metaJson);
    if (!latest) {
        const snapshot = buildTimerSnapshot(desc, now);
        const attemptNo = 1;
        const immediateFire = snapshot.firesAtMs <= now;
        const initialState = immediateFire ? "finished" : "waiting-timer";
        const firedAtMs = immediateFire ? now : undefined;
        const metaJson = JSON.stringify(buildTimerAttemptMeta({
            ...snapshot,
            firedAtMs,
        }));
        const nodeState = immediateFire ? "finished" : "waiting-timer";
        await adapter.withTransaction("timer-start", Effect.gen(function* () {
            yield* adapter.insertAttempt({
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                attempt: attemptNo,
                state: initialState,
                startedAtMs: now,
                finishedAtMs: immediateFire ? now : null,
                errorJson: null,
                jjPointer: null,
                jjCwd: null,
                cached: false,
                metaJson,
                responseText: null,
            });
            yield* adapter.insertNode({
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                state: nodeState,
                lastAttempt: attemptNo,
                updatedAtMs: now,
                outputTable: desc.outputTableName,
                label: desc.label ?? null,
            });
        }));
        await Effect.runPromise(eventBus.emitEventWithPersist({
            type: "TimerCreated",
            runId,
            timerId: desc.nodeId,
            firesAtMs: snapshot.firesAtMs,
            timerType: snapshot.timerType,
            timestampMs: now,
        }));
        if (immediateFire) {
            await Effect.runPromise(eventBus.emitEventWithPersist({
                type: "TimerFired",
                runId,
                timerId: desc.nodeId,
                firesAtMs: snapshot.firesAtMs,
                firedAtMs: now,
                delayMs: Math.max(0, now - snapshot.firesAtMs),
                timestampMs: now,
            }));
            await Effect.runPromise(eventBus.emitEventWithPersist({
                type: "NodeFinished",
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                attempt: attemptNo,
                timestampMs: now,
            }));
        }
        else {
            await Effect.runPromise(eventBus.emitEventWithPersist({
                type: "NodeWaitingTimer",
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                firesAtMs: snapshot.firesAtMs,
                timestampMs: now,
            }));
        }
        return { handled: true, state: nodeState };
    }
    if (latest.state === "waiting-timer") {
        const snapshot = latestTimerSnapshot ?? buildTimerSnapshot(desc, now);
        if (snapshot.firesAtMs > now) {
            await Effect.runPromise(adapter.insertNode({
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                state: "waiting-timer",
                lastAttempt: latest.attempt,
                updatedAtMs: now,
                outputTable: desc.outputTableName,
                label: desc.label ?? null,
            }));
            return { handled: true, state: "waiting-timer" };
        }
        const firedAtMs = now;
        const firedSnapshot = {
            ...snapshot,
            firedAtMs,
        };
        await adapter.withTransaction("timer-fire", Effect.gen(function* () {
            yield* adapter.updateAttempt(runId, desc.nodeId, desc.iteration, latest.attempt, {
                state: "finished",
                finishedAtMs: firedAtMs,
                metaJson: JSON.stringify(buildTimerAttemptMeta(firedSnapshot)),
            });
            yield* adapter.insertNode({
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                state: "finished",
                lastAttempt: latest.attempt,
                updatedAtMs: firedAtMs,
                outputTable: desc.outputTableName,
                label: desc.label ?? null,
            });
        }));
        await Effect.runPromise(eventBus.emitEventWithPersist({
            type: "TimerFired",
            runId,
            timerId: desc.nodeId,
            firesAtMs: snapshot.firesAtMs,
            firedAtMs,
            delayMs: Math.max(0, firedAtMs - snapshot.firesAtMs),
            timestampMs: firedAtMs,
        }));
        await Effect.runPromise(eventBus.emitEventWithPersist({
            type: "NodeFinished",
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            attempt: latest.attempt,
            timestampMs: firedAtMs,
        }));
        return { handled: true, state: "finished" };
    }
    if (latest.state === "finished") {
        await Effect.runPromise(adapter.insertNode({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: "finished",
            lastAttempt: latest.attempt,
            updatedAtMs: now,
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
        }));
        return { handled: true, state: "finished" };
    }
    if (latest.state === "cancelled") {
        await Effect.runPromise(adapter.insertNode({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: "skipped",
            lastAttempt: latest.attempt,
            updatedAtMs: now,
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
        }));
        return { handled: true, state: "skipped" };
    }
    if (latest.state === "failed") {
        await Effect.runPromise(adapter.insertNode({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: "failed",
            lastAttempt: latest.attempt,
            updatedAtMs: now,
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
        }));
        return { handled: true, state: "failed" };
    }
    return { handled: false };
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {TaskDescriptor} desc
 * @param {number} attemptNo
 * @param {unknown} error
 * @param {WaitForEventSnapshot} snapshot
 * @param {DeferredBridgeStateEmitter} [emitStateEvent]
 * @returns {Promise<DeferredBridgeResolution>}
 */
async function failWaitForEventTaskBridge(adapter, runId, desc, attemptNo, error, snapshot, emitStateEvent) {
    const finishedAtMs = nowMs();
    const errorJson = JSON.stringify(errorToJson(error));
    await adapter.withTransaction("wait-event-fail", Effect.gen(function* () {
        yield* adapter.updateAttempt(runId, desc.nodeId, desc.iteration, attemptNo, {
            state: "failed",
            finishedAtMs,
            errorJson,
            metaJson: JSON.stringify(buildWaitForEventAttemptMeta(snapshot)),
        });
        yield* adapter.insertNode({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: "failed",
            lastAttempt: attemptNo,
            updatedAtMs: finishedAtMs,
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
        });
    }));
    if (shouldClearAsyncWaitMetric(snapshot)) {
        await updateAsyncExternalWaitPendingSafe("event", -1);
    }
    await emitStateEvent?.("failed");
    return { handled: true, state: "failed" };
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {TaskDescriptor} desc
 * @param {number} attemptNo
 * @param {unknown} payload
 * @param {WaitForEventSnapshot} snapshot
 * @returns {Promise<DeferredBridgeResolution>}
 */
async function finishWaitForEventTaskBridge(adapter, runId, desc, attemptNo, payload, snapshot) {
    const outputPayload = validateDeferredOutputPayload(desc, runId, payload);
    const finishedAtMs = nowMs();
    await adapter.withTransaction("wait-event-finish", Effect.gen(function* () {
        yield* adapter.upsertOutputRow(desc.outputTable, { runId, nodeId: desc.nodeId, iteration: desc.iteration }, outputPayload);
        yield* adapter.updateAttempt(runId, desc.nodeId, desc.iteration, attemptNo, {
            state: "finished",
            finishedAtMs,
            errorJson: null,
            metaJson: JSON.stringify(buildWaitForEventAttemptMeta(snapshot)),
        });
        yield* adapter.insertNode({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: "finished",
            lastAttempt: attemptNo,
            updatedAtMs: finishedAtMs,
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
        });
    }));
    if (shouldClearAsyncWaitMetric(snapshot)) {
        await updateAsyncExternalWaitPendingSafe("event", -1);
    }
    return { handled: true, state: "finished" };
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {TaskDescriptor} desc
 * @param {number} attemptNo
 * @param {WaitForEventSnapshot} snapshot
 * @param {DeferredBridgeStateEmitter} [emitStateEvent]
 * @returns {Promise<DeferredBridgeResolution>}
 */
async function resolveWaitForEventTimeoutBridge(adapter, runId, desc, attemptNo, snapshot, emitStateEvent) {
    const finishedAtMs = nowMs();
    const timeoutSnapshot = {
        ...snapshot,
        timedOutAtMs: finishedAtMs,
    };
    if (snapshot.onTimeout === "continue") {
        try {
            return await finishWaitForEventTaskBridge(adapter, runId, desc, attemptNo, null, timeoutSnapshot);
        }
        catch (error) {
            return failWaitForEventTaskBridge(adapter, runId, desc, attemptNo, error, timeoutSnapshot, emitStateEvent);
        }
    }
    if (snapshot.onTimeout === "skip") {
        await adapter.withTransaction("wait-event-skip", Effect.gen(function* () {
            yield* adapter.updateAttempt(runId, desc.nodeId, desc.iteration, attemptNo, {
                state: "skipped",
                finishedAtMs,
                errorJson: null,
                metaJson: JSON.stringify(buildWaitForEventAttemptMeta(timeoutSnapshot)),
            });
            yield* adapter.insertNode({
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                state: "skipped",
                lastAttempt: attemptNo,
                updatedAtMs: finishedAtMs,
                outputTable: desc.outputTableName,
                label: desc.label ?? null,
            });
        }));
        if (shouldClearAsyncWaitMetric(timeoutSnapshot)) {
            await updateAsyncExternalWaitPendingSafe("event", -1);
        }
        await emitStateEvent?.("skipped");
        return { handled: true, state: "skipped" };
    }
    return failWaitForEventTaskBridge(adapter, runId, desc, attemptNo, new SmithersError("TASK_TIMEOUT", `WaitForEvent ${desc.nodeId} timed out after ${snapshot.timeoutMs ?? 0}ms.`, {
        nodeId: desc.nodeId,
        signalName: snapshot.signalName,
        correlationId: snapshot.correlationId ?? null,
        timeoutMs: snapshot.timeoutMs ?? 0,
    }), timeoutSnapshot, emitStateEvent);
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {TaskDescriptor} desc
 * @param {WaitForEventSnapshot} snapshot
 * @param {number} [startedAtMs]
 */
async function syncWaitForEventDurableDeferredFromDb(adapter, runId, desc, snapshot, startedAtMs) {
    const [signal] = await Effect.runPromise(adapter.listSignals(runId, {
        signalName: snapshot.signalName,
        correlationId: snapshot.correlationId ?? null,
        receivedAfterMs: typeof startedAtMs === "number" ? startedAtMs : undefined,
        limit: 1,
    }));
    if (!signal) {
        return;
    }
    await bridgeWaitForEventResolve(adapter, runId, desc.nodeId, desc.iteration, {
        signalName: signal.signalName,
        correlationId: signal.correlationId ?? null,
        payloadJson: signal.payloadJson,
        seq: signal.seq,
        receivedAtMs: signal.receivedAtMs,
    });
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {TaskDescriptor} desc
 * @param {ApprovalRow | null | undefined} approval
 */
async function syncApprovalDurableDeferredFromDb(adapter, runId, desc, approval) {
    if (approval?.status !== "approved" && approval?.status !== "denied") {
        return;
    }
    await bridgeApprovalResolve(adapter, runId, desc.nodeId, desc.iteration, {
        approved: approval.status === "approved",
        note: approval.note ?? null,
        decidedBy: approval.decidedBy ?? null,
        decisionJson: approval.decisionJson ?? null,
        autoApproved: approval.autoApproved ?? false,
    });
}
/**
 * @param {SmithersDb} adapter
 * @param {BunSQLiteDatabase} db
 * @param {string} runId
 * @param {TaskDescriptor} desc
 * @param {EventBus} _eventBus
 * @param {DeferredBridgeStateEmitter} [emitStateEvent]
 * @returns {Promise<DeferredBridgeResolution>}
 */
async function resolveWaitForEventTaskStateBridge(adapter, db, runId, desc, _eventBus, emitStateEvent) {
    if (!isBridgeManagedWaitForEventTask(desc)) {
        return { handled: false };
    }
    const now = nowMs();
    const attempts = await Effect.runPromise(adapter.listAttempts(runId, desc.nodeId, desc.iteration));
    let latest = attempts[0];
    let latestSnapshot = parseWaitForEventSnapshot(latest?.metaJson);
    if (!latest) {
        const snapshot = buildWaitForEventSnapshot(desc, now);
        const metaJson = JSON.stringify(buildWaitForEventAttemptMeta(snapshot));
        await adapter.withTransaction("wait-event-start", Effect.gen(function* () {
            yield* adapter.insertAttempt({
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                attempt: 1,
                state: "waiting-event",
                startedAtMs: now,
                finishedAtMs: null,
                errorJson: null,
                jjPointer: null,
                jjCwd: null,
                cached: false,
                metaJson,
                responseText: null,
            });
            yield* adapter.insertNode({
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                state: "waiting-event",
                lastAttempt: 1,
                updatedAtMs: now,
                outputTable: desc.outputTableName,
                label: desc.label ?? null,
            });
        }));
        if (snapshot.waitAsync) {
            await updateAsyncExternalWaitPendingSafe("event", 1);
        }
        latest = {
            attempt: 1,
            state: "waiting-event",
            startedAtMs: now,
            metaJson,
        };
        latestSnapshot = snapshot;
        if (snapshot.timeoutMs === null || snapshot.timeoutMs > 0) {
            return { handled: true, state: "waiting-event" };
        }
    }
    if (desc.outputTable) {
        const outputRow = await selectOutputRow(db, desc.outputTable, {
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
        });
        if (outputRow) {
            const valid = validateExistingOutput(desc.outputTable, outputRow);
            if (valid.ok) {
                await Effect.runPromise(adapter.insertNode({
                    runId,
                    nodeId: desc.nodeId,
                    iteration: desc.iteration,
                    state: "finished",
                    lastAttempt: latest?.attempt ?? null,
                    updatedAtMs: nowMs(),
                    outputTable: desc.outputTableName,
                    label: desc.label ?? null,
                }));
                return { handled: true, state: "finished" };
            }
        }
    }
    if (latest.state === "waiting-event") {
        const snapshot = latestSnapshot ?? buildWaitForEventSnapshot(desc, latest.startedAtMs ?? now);
        await syncWaitForEventDurableDeferredFromDb(adapter, runId, desc, snapshot, latest.startedAtMs);
        const awaited = await awaitWaitForEventDurableDeferred(adapter, runId, desc.nodeId, desc.iteration);
        if (awaited._tag === "Complete" && Exit.isSuccess(awaited.exit)) {
            const signal = awaited.exit.value;
            const resolvedSnapshot = {
                ...snapshot,
                resolvedSignalSeq: signal.seq,
                receivedAtMs: signal.receivedAtMs,
            };
            try {
                return await finishWaitForEventTaskBridge(adapter, runId, desc, latest.attempt, JSON.parse(signal.payloadJson), resolvedSnapshot);
            }
            catch (error) {
                return failWaitForEventTaskBridge(adapter, runId, desc, latest.attempt, error, resolvedSnapshot, emitStateEvent);
            }
        }
        const timeoutMs = typeof snapshot.timeoutMs === "number" && Number.isFinite(snapshot.timeoutMs)
            ? snapshot.timeoutMs
            : null;
        if (timeoutMs !== null &&
            typeof latest.startedAtMs === "number" &&
            latest.startedAtMs + timeoutMs <= now) {
            return resolveWaitForEventTimeoutBridge(adapter, runId, desc, latest.attempt, snapshot, emitStateEvent);
        }
        await Effect.runPromise(adapter.insertNode({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: "waiting-event",
            lastAttempt: latest.attempt,
            updatedAtMs: now,
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
        }));
        return { handled: true, state: "waiting-event" };
    }
    if (latest.state === "finished") {
        await Effect.runPromise(adapter.insertNode({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: "finished",
            lastAttempt: latest.attempt,
            updatedAtMs: now,
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
        }));
        return { handled: true, state: "finished" };
    }
    if (latest.state === "skipped") {
        await Effect.runPromise(adapter.insertNode({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: "skipped",
            lastAttempt: latest.attempt,
            updatedAtMs: now,
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
        }));
        await emitStateEvent?.("skipped");
        return { handled: true, state: "skipped" };
    }
    if (latest.state === "cancelled") {
        await Effect.runPromise(adapter.insertNode({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: "skipped",
            lastAttempt: latest.attempt,
            updatedAtMs: now,
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
        }));
        await emitStateEvent?.("skipped");
        return { handled: true, state: "skipped" };
    }
    if (latest.state === "failed") {
        await Effect.runPromise(adapter.insertNode({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: "failed",
            lastAttempt: latest.attempt,
            updatedAtMs: now,
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
        }));
        await emitStateEvent?.("failed");
        return { handled: true, state: "failed" };
    }
    return { handled: false };
}
/**
 * @param {SmithersDb} adapter
 * @param {BunSQLiteDatabase} db
 * @param {string} runId
 * @param {TaskDescriptor} desc
 * @param {EventBus} eventBus
 * @param {DeferredBridgeStateEmitter} [emitStateEvent]
 * @returns {Promise<DeferredBridgeResolution>}
 */
async function resolveApprovalTaskStateBridge(adapter, db, runId, desc, eventBus, emitStateEvent) {
    if (!desc.needsApproval) {
        return { handled: false };
    }
    let approval = await Effect.runPromise(adapter.getApproval(runId, desc.nodeId, desc.iteration));
    if (!approval) {
        const requestedAtMs = nowMs();
        const requestJson = buildApprovalRequestJson(desc);
        if (await shouldAutoApprove(adapter, runId, desc)) {
            const decisionJson = JSON.stringify(defaultAutoApprovalDecision(desc));
            approval = {
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                status: "approved",
                requestedAtMs: desc.approvalAutoApprove?.audit ? requestedAtMs : null,
                decidedAtMs: requestedAtMs,
                note: "Auto-approved",
                decidedBy: "smithers:auto",
                requestJson,
                decisionJson,
                autoApproved: true,
            };
            await Effect.runPromise(adapter.insertOrUpdateApproval(approval));
            await bridgeApprovalResolve(adapter, runId, desc.nodeId, desc.iteration, {
                approved: true,
                note: approval.note,
                decidedBy: approval.decidedBy,
                decisionJson,
                autoApproved: true,
            });
            await Effect.runPromise(eventBus.emitEventWithPersist({
                type: "ApprovalAutoApproved",
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                timestampMs: requestedAtMs,
            }));
        }
        else {
            approval = {
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                status: "requested",
                requestedAtMs,
                decidedAtMs: null,
                note: null,
                decidedBy: null,
                requestJson,
                decisionJson: null,
                autoApproved: false,
            };
            await Effect.runPromise(adapter.insertOrUpdateApproval(approval));
            if (desc.waitAsync) {
                await updateAsyncExternalWaitPendingSafe("approval", 1);
            }
            await Effect.runPromise(eventBus.emitEventWithPersist({
                type: "ApprovalRequested",
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                timestampMs: requestedAtMs,
            }));
            await Effect.runPromise(eventBus.emitEventWithPersist({
                type: "NodeWaitingApproval",
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                timestampMs: requestedAtMs,
            }));
            await ensurePendingHumanRequest(adapter, runId, desc, requestedAtMs);
        }
    }
    if (approval?.status === "requested") {
        await ensurePendingHumanRequest(adapter, runId, desc, approval.requestedAtMs ?? nowMs());
    }
    const humanRequest = await reconcileHumanRequestValidationFailure(adapter, runId, desc);
    if (approval?.status === "approved" && humanRequest?.status === "pending") {
        await Effect.runPromise(adapter.insertNode({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: "waiting-approval",
            lastAttempt: null,
            updatedAtMs: nowMs(),
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
        }));
        return { handled: true, state: "waiting-approval" };
    }
    await syncApprovalDurableDeferredFromDb(adapter, runId, desc, approval);
    const awaited = await awaitApprovalDurableDeferred(adapter, runId, desc.nodeId, desc.iteration);
    if (awaited._tag !== "Complete" || !Exit.isSuccess(awaited.exit)) {
        await Effect.runPromise(adapter.insertNode({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: "waiting-approval",
            lastAttempt: null,
            updatedAtMs: nowMs(),
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
        }));
        return { handled: true, state: "waiting-approval" };
    }
    approval = (await Effect.runPromise(adapter.getApproval(runId, desc.nodeId, desc.iteration)) ?? approval);
    if (approval?.status === "denied") {
        if (desc.approvalMode !== "gate" && desc.approvalOnDeny !== "fail") {
            const outputRow = await selectOutputRow(db, desc.outputTable, {
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
            });
            if (outputRow) {
                const valid = validateExistingOutput(desc.outputTable, outputRow);
                if (valid.ok) {
                    await Effect.runPromise(adapter.insertNode({
                        runId,
                        nodeId: desc.nodeId,
                        iteration: desc.iteration,
                        state: "finished",
                        lastAttempt: null,
                        updatedAtMs: nowMs(),
                        outputTable: desc.outputTableName,
                        label: desc.label ?? null,
                    }));
                    return { handled: true, state: "finished" };
                }
            }
            await Effect.runPromise(adapter.insertNode({
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                state: "pending",
                lastAttempt: null,
                updatedAtMs: nowMs(),
                outputTable: desc.outputTableName,
                label: desc.label ?? null,
            }));
            await emitStateEvent?.("pending");
            return { handled: true, state: "pending" };
        }
        const state = desc.continueOnFail
            ? "skipped"
            : "failed";
        await Effect.runPromise(adapter.insertNode({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state,
            lastAttempt: null,
            updatedAtMs: nowMs(),
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
        }));
        await emitStateEvent?.(state);
        return { handled: true, state };
    }
    if (approval?.status === "approved") {
        return { handled: false };
    }
    await Effect.runPromise(adapter.insertNode({
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        state: "waiting-approval",
        lastAttempt: null,
        updatedAtMs: nowMs(),
        outputTable: desc.outputTableName,
        label: desc.label ?? null,
    }));
    return { handled: true, state: "waiting-approval" };
}
/**
 * @param {SmithersDb} adapter
 * @param {BunSQLiteDatabase} db
 * @param {string} runId
 * @param {TaskDescriptor} desc
 * @param {EventBus} eventBus
 * @param {DeferredBridgeStateEmitter} [emitStateEvent]
 * @returns {Promise<DeferredBridgeResolution>}
 */
export async function resolveDeferredTaskStateBridge(adapter, db, runId, desc, eventBus, emitStateEvent) {
    const timer = await resolveTimerTaskStateBridge(adapter, runId, desc, eventBus);
    if (timer.handled) {
        return timer;
    }
    const waitForEvent = await resolveWaitForEventTaskStateBridge(adapter, db, runId, desc, eventBus, emitStateEvent);
    if (waitForEvent.handled) {
        return waitForEvent;
    }
    return resolveApprovalTaskStateBridge(adapter, db, runId, desc, eventBus, emitStateEvent);
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {EventBus} eventBus
 * @param {string} reason
 */
export async function cancelPendingTimersBridge(adapter, runId, eventBus, reason) {
    const nodes = await Effect.runPromise(adapter.listNodes(runId));
    for (const node of nodes) {
        if (node.state !== "waiting-timer")
            continue;
        const attempts = await Effect.runPromise(adapter.listAttempts(runId, node.nodeId, node.iteration ?? 0));
        const waiting = attempts.find((attempt) => attempt.state === "waiting-timer");
        if (!waiting)
            continue;
        const cancelledAtMs = nowMs();
        await adapter.withTransaction("cancel-pending-timer", Effect.gen(function* () {
            yield* adapter.updateAttempt(runId, node.nodeId, node.iteration ?? 0, waiting.attempt, {
                state: "cancelled",
                finishedAtMs: cancelledAtMs,
            });
            yield* adapter.insertNode({
                runId,
                nodeId: node.nodeId,
                iteration: node.iteration ?? 0,
                state: "cancelled",
                lastAttempt: waiting.attempt,
                updatedAtMs: cancelledAtMs,
                outputTable: node.outputTable ?? "",
                label: node.label ?? null,
            });
        }));
        await Effect.runPromise(eventBus.emitEventWithPersist({
            type: "TimerCancelled",
            runId,
            timerId: node.nodeId,
            timestampMs: cancelledAtMs,
        }));
        await Effect.runPromise(eventBus.emitEventWithPersist({
            type: "NodeCancelled",
            runId,
            nodeId: node.nodeId,
            iteration: node.iteration ?? 0,
            attempt: waiting.attempt,
            reason,
            timestampMs: cancelledAtMs,
        }));
    }
}
