import { Effect } from "effect";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { buildPlanTree } from "./buildPlanTree.js";
import { buildStateKey } from "./buildStateKey.js";
import { cloneTaskStateMap } from "./cloneTaskStateMap.js";
import { parseStateKey } from "./parseStateKey.js";
import { scheduleTasks } from "./scheduleTasks.js";
/** @typedef {import("./ApprovalResolution.ts").ApprovalResolution} ApprovalResolution */
/** @typedef {import("./EngineDecision.ts").EngineDecision} EngineDecision */
/** @typedef {import("./RenderContext.ts").RenderContext} RenderContext */
/** @typedef {import("./RunResult.ts").RunResult} RunResult */
/** @typedef {import("./ScheduleResult.ts").ScheduleResult} ScheduleResult */
/** @typedef {import("./TaskOutput.ts").TaskOutput} TaskOutput */
/** @typedef {import("./WaitReason.ts").WaitReason} WaitReason */

/** @typedef {import("./WorkflowSessionOptions.ts").WorkflowSessionOptions} WorkflowSessionOptions */
/** @typedef {import("./WorkflowSessionService.ts").WorkflowSessionService} WorkflowSessionService */

/**
 * @returns {string}
 */
function defaultRunId() {
    return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
/**
 * @param {readonly TaskDescriptor[]} tasks
 * @returns {Map<string, TaskDescriptor>}
 */
function descriptorMap(tasks) {
    const map = new Map();
    for (const task of tasks) {
        map.set(task.nodeId, task);
    }
    return map;
}
/**
 * @param {SessionState} state
 * @param {string} nodeId
 * @param {number} [iteration]
 * @returns {TaskDescriptor | undefined}
 */
function findDescriptor(state, nodeId, iteration) {
    const descriptor = state.descriptors.get(nodeId);
    if (descriptor && (iteration == null || descriptor.iteration === iteration)) {
        return descriptor;
    }
    return [...state.descriptors.values()].find((candidate) => candidate.nodeId === nodeId &&
        (iteration == null || candidate.iteration === iteration));
}
/**
 * @param {Pick<TaskDescriptor, "nodeId" | "iteration">} descriptor
 */
function stateKeyFor(descriptor) {
    return buildStateKey(descriptor.nodeId, descriptor.iteration);
}
/**
 * @param {WorkflowGraph} graph
 * @returns {string}
 */
function mountedSignature(graph) {
    return [...graph.mountedTaskIds].sort().join("\n");
}
/**
 * @param {SessionState} state
 * @param {number} [iterationOverride]
 * @returns {RenderContext}
 */
function renderContext(state, iterationOverride) {
    const ralphIterations = [...state.ralphState.values()].map((value) => value.iteration);
    return {
        runId: state.runId,
        graph: state.graph,
        iteration: iterationOverride ??
            (ralphIterations.length === 1 ? ralphIterations[0] : 0),
        taskStates: cloneTaskStateMap(state.states),
        outputs: new Map(state.outputs),
        ralphIterations: new Map([...state.ralphState.entries()].map(([id, value]) => [id, value.iteration])),
    };
}
/**
 * @param {SessionState} state
 * @param {number} currentTimeMs
 * @returns {WaitReason | undefined}
 */
function findWaitingReason(state, currentTimeMs) {
    for (const descriptor of state.descriptors.values()) {
        const taskState = state.states.get(stateKeyFor(descriptor));
        if (taskState === "waiting-approval") {
            return { _tag: "Approval", nodeId: descriptor.nodeId };
        }
        if (taskState === "waiting-event") {
            const eventName = typeof descriptor.meta?.__eventName === "string"
                ? descriptor.meta.__eventName
                : "";
            return { _tag: "Event", eventName };
        }
        if (taskState === "waiting-timer") {
            return {
                _tag: "Timer",
                resumeAtMs: timerResumeAtMs(descriptor, currentTimeMs),
            };
        }
    }
    return undefined;
}
/**
 * @param {TaskDescriptor} descriptor
 * @param {number} nowMs
 * @returns {number}
 */
function timerResumeAtMs(descriptor, nowMs) {
    const until = descriptor.meta?.__timerUntil;
    if (typeof until === "string" && until.length > 0) {
        const parsed = Date.parse(until);
        if (Number.isFinite(parsed))
            return parsed;
    }
    const duration = descriptor.meta?.__timerDuration;
    if (typeof duration === "string") {
        const ms = parseDurationMs(duration);
        if (ms != null)
            return nowMs + ms;
    }
    return nowMs;
}
/**
 * @param {string} value
 * @returns {number | null}
 */
function parseDurationMs(value) {
    const trimmed = value.trim();
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(trimmed);
    if (!match)
        return null;
    const amount = Number(match[1]);
    const unit = match[2] ?? "ms";
    if (!Number.isFinite(amount))
        return null;
    switch (unit) {
        case "h":
            return amount * 60 * 60 * 1000;
        case "m":
            return amount * 60 * 1000;
        case "s":
            return amount * 1000;
        case "ms":
        default:
            return amount;
    }
}
/**
 * @param {TaskDescriptor} descriptor
 * @param {number} failureCount
 * @returns {number}
 */
function retryDelayMs(descriptor, failureCount) {
    const policy = descriptor.retryPolicy;
    if (!policy)
        return 0;
    const initial = policy.initialDelayMs ?? 0;
    if (policy.backoff === "exponential") {
        const multiplier = policy.multiplier ?? 2;
        const computed = initial * Math.pow(multiplier, Math.max(0, failureCount - 1));
        return Math.min(policy.maxDelayMs ?? computed, computed);
    }
    if (policy.backoff === "linear") {
        const computed = initial * Math.max(1, failureCount);
        return Math.min(policy.maxDelayMs ?? computed, computed);
    }
    return initial;
}
/**
 * @param {TaskDescriptor} descriptor
 * @param {unknown} error
 * @returns {boolean}
 */
function isRetryableFailure(descriptor, error) {
    const payloadCode = error && typeof error === "object" && typeof error.code === "string"
        ? error.code
        : undefined;
    const normalized = toSmithersError(error);
    const code = payloadCode ?? normalized.code;
    const isAgentTask = Boolean(descriptor.agent);
    const nonRetryableComputeCodes = new Set([
        "INVALID_OUTPUT",
        "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
        "HEARTBEAT_PAYLOAD_TOO_LARGE",
    ]);
    if (!isAgentTask && nonRetryableComputeCodes.has(code)) {
        return false;
    }
    return true;
}
/**
 * @param {unknown} error
 * @param {string} label
 * @returns {EngineDecision}
 */
function failedDecision(error, label) {
    return {
        _tag: "Failed",
        error: toSmithersError(error, label, { code: "SESSION_ERROR" }),
    };
}
/**
 * @param {WorkflowSessionOptions} [options]
 * @returns {WorkflowSessionService}
 */
export function makeWorkflowSession(options = {}) {
    const nowMs = options.nowMs ?? (() => Date.now());
    const state = {
        runId: options.runId ?? defaultRunId(),
        graph: null,
        plan: null,
        descriptors: new Map(),
        states: new Map(),
        outputs: new Map(),
        failures: new Map(),
        retryCounts: new Map(),
        retryWait: new Map(),
        approvals: new Set(),
        ralphState: new Map(options.initialRalphState ?? []),
        schedule: null,
        cancelled: false,
        lastMountedSignature: null,
    };
    /**
   * @param {Pick<TaskOutput, "nodeId" | "iteration">} output
   * @returns {string}
   */
    function outputKey(output) {
        return buildStateKey(output.nodeId, output.iteration);
    }
    /**
   * @param {RunResult["status"]} [status]
   * @returns {EngineDecision}
   */
    function finishedResult(status = "finished") {
        return {
            _tag: "Finished",
            result: {
                runId: state.runId,
                status,
                output: [...state.outputs.values()].at(-1)?.output,
            },
        };
    }
    /**
   * @returns {ScheduleResult}
   */
    function computeSchedule() {
        const result = scheduleTasks(state.plan, state.states, state.descriptors, state.ralphState, state.retryWait, nowMs());
        state.schedule = {
            plan: state.plan,
            result,
            computedAtMs: nowMs(),
        };
        return result;
    }
    /**
   * @param {WorkflowGraph} graph
   * @param {{ readonly pruneUnmounted?: boolean }} [opts]
   */
    function markGraph(graph, opts = {}) {
        state.graph = graph;
        state.descriptors = descriptorMap(graph.tasks);
        const { plan, ralphs } = buildPlanTree(graph.xml, state.ralphState);
        state.plan = plan;
        if (opts.pruneUnmounted) {
            const mounted = new Set(graph.mountedTaskIds);
            for (const [key, taskState] of [...state.states.entries()]) {
                if (mounted.has(key))
                    continue;
                if (taskState === "in-progress") {
                    state.states.set(key, "cancelled");
                }
                else {
                    state.states.delete(key);
                }
                state.retryWait.delete(key);
            }
        }
        for (const ralph of ralphs) {
            const existing = state.ralphState.get(ralph.id);
            if (ralph.until) {
                state.ralphState.set(ralph.id, {
                    iteration: existing?.iteration ?? 0,
                    done: true,
                });
            }
            else if (!existing) {
                state.ralphState.set(ralph.id, { iteration: 0, done: false });
            }
        }
        for (const task of graph.tasks) {
            const key = stateKeyFor(task);
            if (!state.states.has(key)) {
                state.states.set(key, "pending");
            }
        }
    }
    /**
   * @param {TaskOutput} output
   */
    function markTaskFinished(output) {
        const key = outputKey(output);
        state.states.set(key, "finished");
        state.outputs.set(key, output);
        state.retryWait.delete(key);
    }
    /**
   * @param {number} [iteration]
   * @returns {EngineDecision}
   */
    function decideAfterOutputChange(iteration) {
        if (options.requireRerenderOnOutputChange) {
            return { _tag: "ReRender", context: renderContext(state, iteration) };
        }
        return decide();
    }
    /**
   * @param {TaskDescriptor} descriptor
   * @param {ApprovalResolution} resolution
   */
    function applyApprovalResolution(descriptor, resolution) {
        const key = stateKeyFor(descriptor);
        if (resolution.approved) {
            state.approvals.add(key);
            state.states.set(key, "pending");
        }
        else if (descriptor.approvalOnDeny === "skip") {
            state.states.set(key, "skipped");
        }
        else if (descriptor.approvalOnDeny === "continue") {
            state.states.set(key, "finished");
            state.outputs.set(key, {
                nodeId: descriptor.nodeId,
                iteration: descriptor.iteration,
                output: resolution,
            });
        }
        else {
            state.states.set(key, "failed");
            state.failures.set(key, resolution);
        }
    }
    /**
   * @param {TaskDescriptor} descriptor
   * @param {unknown} error
   * @returns {EngineDecision}
   */
    function applyFailure(descriptor, error) {
        const key = stateKeyFor(descriptor);
        const failureCount = (state.retryCounts.get(key) ?? 0) + 1;
        state.retryCounts.set(key, failureCount);
        const retryable = isRetryableFailure(descriptor, error);
        const canRetry = retryable &&
            (descriptor.retries === Infinity || failureCount <= descriptor.retries);
        if (canRetry) {
            const delay = retryDelayMs(descriptor, failureCount);
            state.states.set(key, "pending");
            if (delay > 0) {
                state.retryWait.set(key, nowMs() + delay);
            }
            else {
                state.retryWait.delete(key);
            }
            return decide();
        }
        state.states.set(key, "failed");
        state.failures.set(key, error);
        return decide();
    }
    function ralphStatePayload() {
        return {
            ralphState: Object.fromEntries([...state.ralphState.entries()].map(([id, value]) => [
                id,
                { iteration: value.iteration, done: value.done },
            ])),
        };
    }
    /**
   * @returns {EngineDecision}
   */
    function decide(depth = 0) {
        if (depth > 10) {
            return { _tag: "Wait", reason: { _tag: "ExternalTrigger" } };
        }
        if (state.cancelled) {
            return finishedResult("cancelled");
        }
        if (!state.graph) {
            return { _tag: "Wait", reason: { _tag: "ExternalTrigger" } };
        }
        for (const [key, taskState] of state.states) {
            const parsed = parseStateKey(key);
            const descriptor = findDescriptor(state, parsed.nodeId, parsed.iteration);
            if (taskState === "failed" && !descriptor?.continueOnFail) {
                return {
                    _tag: "Failed",
                    error: new SmithersError("SESSION_ERROR", `Task failed: ${descriptor?.nodeId ?? key}`, { key }, state.failures.get(key)),
                };
            }
        }
        const schedule = computeSchedule();
        if (schedule.fatalError) {
            return {
                _tag: "Failed",
                error: new SmithersError("SCHEDULER_ERROR", schedule.fatalError),
            };
        }
        if (schedule.continuation) {
            return {
                _tag: "ContinueAsNew",
                transition: {
                    reason: "explicit",
                    stateJson: schedule.continuation.stateJson,
                },
            };
        }
        const executable = [];
        let waitReason;
        let changed = false;
        for (const task of schedule.runnable) {
            const key = stateKeyFor(task);
            if (task.skipIf) {
                state.states.set(key, "skipped");
                changed = true;
                continue;
            }
            if (task.needsApproval && !state.approvals.has(key)) {
                state.states.set(key, "waiting-approval");
                changed = true;
                if (task.waitAsync) {
                    continue;
                }
                waitReason ??= { _tag: "Approval", nodeId: task.nodeId };
                continue;
            }
            if (task.meta?.__waitForEvent) {
                state.states.set(key, "waiting-event");
                changed = true;
                if (task.waitAsync) {
                    continue;
                }
                waitReason ??= {
                    _tag: "Event",
                    eventName: typeof task.meta.__eventName === "string" ? task.meta.__eventName : "",
                };
                continue;
            }
            if (task.meta?.__timer) {
                const resumeAtMs = timerResumeAtMs(task, nowMs());
                state.states.set(key, "waiting-timer");
                waitReason ??= { _tag: "Timer", resumeAtMs };
                changed = true;
                continue;
            }
            state.states.set(key, "in-progress");
            executable.push(task);
            changed = true;
        }
        if (executable.length > 0) {
            return { _tag: "Execute", tasks: executable };
        }
        if (waitReason) {
            return { _tag: "Wait", reason: waitReason };
        }
        if (changed) {
            return decide(depth + 1);
        }
        const existingWait = findWaitingReason(state, nowMs());
        if (existingWait) {
            return { _tag: "Wait", reason: existingWait };
        }
        if (schedule.pendingExists) {
            if (schedule.nextRetryAtMs != null) {
                return {
                    _tag: "Wait",
                    reason: {
                        _tag: "RetryBackoff",
                        waitMs: Math.max(0, schedule.nextRetryAtMs - nowMs()),
                    },
                };
            }
            return { _tag: "Wait", reason: { _tag: "ExternalTrigger" } };
        }
        if ([...state.states.values()].some((taskState) => taskState === "in-progress")) {
            return { _tag: "Wait", reason: { _tag: "ExternalTrigger" } };
        }
        if (schedule.readyRalphs.length > 0) {
            for (const ralph of schedule.readyRalphs) {
                const current = state.ralphState.get(ralph.id) ?? {
                    iteration: 0,
                    done: false,
                };
                if (ralph.until) {
                    state.ralphState.set(ralph.id, { ...current, done: true });
                    continue;
                }
                const nextIteration = current.iteration + 1;
                if (nextIteration >= ralph.maxIterations) {
                    if (ralph.onMaxReached === "fail") {
                        return {
                            _tag: "Failed",
                            error: new SmithersError("RALPH_MAX_REACHED", `Ralph ${ralph.id} reached maxIterations ${ralph.maxIterations}.`, { ralphId: ralph.id, maxIterations: ralph.maxIterations }),
                        };
                    }
                    state.ralphState.set(ralph.id, { iteration: current.iteration, done: true });
                    continue;
                }
                state.ralphState.set(ralph.id, { iteration: nextIteration, done: false });
                if (ralph.continueAsNewEvery != null &&
                    ralph.continueAsNewEvery > 0 &&
                    nextIteration > 0 &&
                    nextIteration % ralph.continueAsNewEvery === 0) {
                    return {
                        _tag: "ContinueAsNew",
                        transition: {
                            reason: "loop-threshold",
                            iteration: nextIteration,
                            statePayload: ralphStatePayload(),
                        },
                    };
                }
            }
            return { _tag: "ReRender", context: renderContext(state) };
        }
        if (options.requireStableFinish && state.graph) {
            const signature = mountedSignature(state.graph);
            if (state.lastMountedSignature !== signature) {
                state.lastMountedSignature = signature;
                return { _tag: "ReRender", context: renderContext(state) };
            }
        }
        return finishedResult();
    }
    return {
        submitGraph: (graph) => Effect.sync(() => {
            try {
                markGraph(graph);
                return decide();
            }
            catch (error) {
                return failedDecision(error, "submitGraph");
            }
        }),
        taskCompleted: (output) => Effect.sync(() => {
            const descriptor = findDescriptor(state, output.nodeId, output.iteration);
            if (!descriptor) {
                return failedDecision(new SmithersError("NODE_NOT_FOUND", `Unknown task ${output.nodeId}`), "taskCompleted");
            }
            markTaskFinished(output);
            return decideAfterOutputChange(output.iteration);
        }),
        taskFailed: (failure) => Effect.sync(() => {
            const descriptor = findDescriptor(state, failure.nodeId, failure.iteration);
            if (!descriptor) {
                return failedDecision(new SmithersError("NODE_NOT_FOUND", `Unknown task ${failure.nodeId}`), "taskFailed");
            }
            return applyFailure(descriptor, failure.error);
        }),
        approvalResolved: (nodeId, resolution) => Effect.sync(() => {
            const descriptor = findDescriptor(state, nodeId);
            if (!descriptor) {
                return failedDecision(new SmithersError("NODE_NOT_FOUND", `Unknown approval task ${nodeId}`), "approvalResolved");
            }
            applyApprovalResolution(descriptor, resolution);
            return decide();
        }),
        approvalTimedOut: (nodeId) => Effect.sync(() => {
            const descriptor = findDescriptor(state, nodeId);
            if (!descriptor) {
                return failedDecision(new SmithersError("NODE_NOT_FOUND", `Unknown approval task ${nodeId}`), "approvalTimedOut");
            }
            const key = stateKeyFor(descriptor);
            if (state.states.get(key) !== "waiting-approval") {
                return decide();
            }
            applyApprovalResolution(descriptor, {
                approved: false,
                note: "approval timed out",
            });
            if (state.states.get(key) === "failed") {
                state.failures.set(key, new SmithersError("TASK_TIMEOUT", `Approval timed out for ${descriptor.nodeId}`, { nodeId: descriptor.nodeId, iteration: descriptor.iteration }));
            }
            return decide();
        }),
        eventReceived: (eventName, payload, correlationId = null) => Effect.sync(() => {
            for (const descriptor of state.descriptors.values()) {
                const key = stateKeyFor(descriptor);
                const taskState = state.states.get(key);
                const expected = typeof descriptor.meta?.__eventName === "string"
                    ? descriptor.meta.__eventName
                    : undefined;
                const expectedCorrelation = typeof descriptor.meta?.__correlationId === "string"
                    ? descriptor.meta.__correlationId
                    : undefined;
                if (taskState === "waiting-event" &&
                    (!expected || expected === eventName) &&
                    (expectedCorrelation === undefined || expectedCorrelation === correlationId)) {
                    state.states.set(key, "finished");
                    state.outputs.set(key, {
                        nodeId: descriptor.nodeId,
                        iteration: descriptor.iteration,
                        output: payload,
                    });
                }
            }
            return decide();
        }),
        signalReceived: (signalName, payload, correlationId = null) => Effect.sync(() => {
            for (const descriptor of state.descriptors.values()) {
                const key = stateKeyFor(descriptor);
                const taskState = state.states.get(key);
                const expected = typeof descriptor.meta?.__signalName === "string"
                    ? descriptor.meta.__signalName
                    : typeof descriptor.meta?.__eventName === "string"
                        ? descriptor.meta.__eventName
                        : undefined;
                const expectedCorrelation = typeof descriptor.meta?.__correlationId === "string"
                    ? descriptor.meta.__correlationId
                    : undefined;
                if (taskState === "waiting-event" &&
                    (!expected || expected === signalName) &&
                    (expectedCorrelation === undefined || expectedCorrelation === correlationId)) {
                    state.states.set(key, "finished");
                    state.outputs.set(key, {
                        nodeId: descriptor.nodeId,
                        iteration: descriptor.iteration,
                        output: payload,
                    });
                }
            }
            return decide();
        }),
        timerFired: (nodeId, firedAtMs = nowMs()) => Effect.sync(() => {
            const descriptor = findDescriptor(state, nodeId);
            if (!descriptor) {
                return failedDecision(new SmithersError("NODE_NOT_FOUND", `Unknown timer task ${nodeId}`), "timerFired");
            }
            const key = stateKeyFor(descriptor);
            if (state.states.get(key) !== "waiting-timer" && !descriptor.meta?.__timer) {
                return decide();
            }
            markTaskFinished({
                nodeId: descriptor.nodeId,
                iteration: descriptor.iteration,
                output: { firedAtMs },
            });
            return decideAfterOutputChange(descriptor.iteration);
        }),
        hotReloaded: (graph) => Effect.sync(() => {
            try {
                markGraph(graph, { pruneUnmounted: true });
                state.lastMountedSignature = null;
                return decide();
            }
            catch (error) {
                return failedDecision(error, "hotReloaded");
            }
        }),
        heartbeatTimedOut: (nodeId, iteration, details = {}) => Effect.sync(() => {
            const descriptor = findDescriptor(state, nodeId, iteration);
            if (!descriptor) {
                return failedDecision(new SmithersError("NODE_NOT_FOUND", `Unknown task ${nodeId}`), "heartbeatTimedOut");
            }
            return applyFailure(descriptor, new SmithersError("TASK_HEARTBEAT_TIMEOUT", `Task ${descriptor.nodeId} heartbeat timed out.`, {
                nodeId: descriptor.nodeId,
                iteration: descriptor.iteration,
                timeoutMs: descriptor.heartbeatTimeoutMs,
                ...details,
            }));
        }),
        cacheResolved: (output, _cached) => Effect.sync(() => {
            const descriptor = findDescriptor(state, output.nodeId, output.iteration);
            if (!descriptor) {
                return failedDecision(new SmithersError("NODE_NOT_FOUND", `Unknown cached task ${output.nodeId}`), "cacheResolved");
            }
            markTaskFinished({
                ...output,
                usage: output.usage ?? null,
                output: output.output,
            });
            return decideAfterOutputChange(output.iteration);
        }),
        cacheMissed: (nodeId, iteration) => Effect.sync(() => {
            const descriptor = findDescriptor(state, nodeId, iteration);
            if (!descriptor) {
                return failedDecision(new SmithersError("NODE_NOT_FOUND", `Unknown cached task ${nodeId}`), "cacheMissed");
            }
            state.retryWait.delete(stateKeyFor(descriptor));
            return decide();
        }),
        recoverOrphanedTasks: () => Effect.sync(() => {
            let count = 0;
            for (const [key, taskState] of state.states) {
                if (taskState === "in-progress") {
                    state.states.set(key, "pending");
                    count += 1;
                }
            }
            const decision = decide();
            if (count > 0 || decision._tag !== "Wait") {
                return decision;
            }
            return { _tag: "Wait", reason: { _tag: "OrphanRecovery", count } };
        }),
        cancelRequested: () => Effect.sync(() => {
            state.cancelled = true;
            for (const [key, taskState] of state.states) {
                if (taskState !== "finished" && taskState !== "failed" && taskState !== "skipped") {
                    state.states.set(key, "cancelled");
                }
            }
            return finishedResult("cancelled");
        }),
        getTaskStates: () => Effect.sync(() => cloneTaskStateMap(state.states)),
        getSchedule: () => Effect.sync(() => state.schedule),
        getCurrentGraph: () => Effect.sync(() => state.graph),
    };
}
