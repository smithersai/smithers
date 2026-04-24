import { Effect } from "effect";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { EventBus } from "../events.js";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { makeWorkerTask, } from "./entity-worker.js";
import { executeTaskActivity, makeTaskBridgeKey, RetriableTaskFailure, } from "./activity-bridge.js";
import { parseAttemptMetaJson } from "./bridge-utils.js";
import { canExecuteBridgeManagedComputeTask, executeComputeTaskBridge, } from "./compute-task-bridge.js";
import { canExecuteBridgeManagedStaticTask, executeStaticTaskBridge, } from "./static-task-bridge.js";
import { dispatchWorkerTask, notifyTaskWorkerDispatch } from "./single-runner.js";
/** @typedef {import("../HijackState.ts").HijackState} HijackState */
/** @typedef {import("./LegacyExecuteTaskFn.ts").LegacyExecuteTaskFn} LegacyExecuteTaskFn */
/** @typedef {import("./TaskBridgeToolConfig.ts").TaskBridgeToolConfig} TaskBridgeToolConfig */
/** @typedef {import("@smithers-orchestrator/graph/TaskDescriptor").TaskDescriptor} _TaskDescriptor */
/** @typedef {import("./TaskActivityContext.ts").TaskActivityContext} _TaskActivityContext */
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase<Record<string, unknown>>} _BunSQLiteDatabase */
/** @typedef {import("drizzle-orm/sqlite-core").SQLiteTable} SQLiteTable */
/**
 * @typedef {"compute" | "static" | "legacy"} BridgeManagedTaskKind
 */

export { bridgeApprovalResolve, bridgeSignalResolve, bridgeWaitForEventResolve, awaitApprovalDurableDeferred, awaitWaitForEventDurableDeferred, makeApprovalDurableDeferred, makeDurableDeferredBridgeExecutionId, makeWaitForEventDurableDeferred, } from "./durable-deferred-bridge.js";
export { cancelPendingTimersBridge, isBridgeManagedTimerTask, isBridgeManagedWaitForEventTask, resolveDeferredTaskStateBridge, } from "./deferred-state-bridge.js";
export { createSchedulerWakeQueue, getWorkflowMakeBridgeRuntime, runWorkflowWithMakeBridge, withWorkflowMakeBridgeRuntime, } from "./workflow-make-bridge.js";
export { SqlMessageStorage, ensureSqlMessageStorage, ensureSqlMessageStorageEffect, getSqlMessageStorage, } from "./sql-message-storage.js";
export { SandboxEntity, SandboxEntityExecutor, makeSandboxEntityId, makeSandboxTransportServiceEffect, } from "@smithers-orchestrator/sandbox/effect/sandbox-entity";
export { CodeplaneSandboxExecutorLive, DockerSandboxExecutorLive, SandboxHttpRunner, } from "./http-runner.js";
export { BubblewrapSandboxExecutorLive, SandboxSocketRunner, } from "@smithers-orchestrator/sandbox/effect/socket-runner";
export { isTaskResultFailure, makeWorkerTask, TaskResult, WorkerDispatchKind, WorkerTask, WorkerTaskKind, TaskWorkerEntity, } from "./entity-worker.js";
export { dispatchWorkerTask, notifyTaskWorkerDispatch, subscribeTaskWorkerDispatches, } from "./single-runner.js";
/**
 * Phase 0 Seam Adapter
 *
 * This file establishes the interface boundaries for bridging the legacy Smithers engine
 * with the Effect ecosystem.
 *
 * Currently, it delegates to the legacy implementations exactly as they are.
 * In Phase 1, `executeTaskBridge` will be replaced by `Activity.make()`.
 * In subsequent phases, other engine boundaries will be modeled as Workflows.
 */
const inflightTaskExecutions = new Map();
const completedTaskExecutions = new Map();
/**
 * @template A
 * @param {Effect.Effect<A, unknown, never> | PromiseLike<A> | A} value
 * @returns {Promise<A>}
 */
const runEffectOrPromise = async (value) => {
    if (Effect.isEffect?.(value)) {
        return Effect.runPromise(value);
    }
    return await value;
};

/**
 * The single-runner worker bridge is currently brittle under Bun source-tree
 * execution. When its bootstrap fails, fall back to in-process execution so
 * local CLI runs still make forward progress.
 * @param {unknown} error
 * @returns {boolean}
 */
function isSingleRunnerBootstrapError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return (message.includes("@effect/cluster/SingleRunner") ||
        message.includes("@effect/sql-sqlite-bun/SqliteClient") ||
        message.includes("Service not found: effect/Scope"));
}
/**
 * @param {string | null} [errorJson]
 * @returns {string | null}
 */
function parseAttemptErrorCode(errorJson) {
    if (!errorJson)
        return null;
    try {
        const parsed = JSON.parse(errorJson);
        return typeof parsed?.code === "string" ? parsed.code : null;
    }
    catch {
        return null;
    }
}
/**
 * @param {{ errorJson?: string | null; metaJson?: string | null } | null} [attempt]
 */
function isRetryableBridgeTaskFailure(attempt) {
    const meta = parseAttemptMetaJson(attempt?.metaJson);
    if (meta?.failureRetryable === false) {
        return false;
    }
    const kind = typeof meta?.kind === "string" ? meta.kind : null;
    return !(kind !== "agent" && parseAttemptErrorCode(attempt?.errorJson) === "INVALID_OUTPUT");
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {_TaskDescriptor} desc
 * @param {_TaskActivityContext} context
 */
const classifyTaskAttempt = async (adapter, runId, desc, context) => {
    const attempts = await runEffectOrPromise(adapter.listAttempts(runId, desc.nodeId, desc.iteration));
    const latest = attempts[0];
    const latestAttempt = latest?.attempt ?? context.attempt;
    const latestState = latest?.state ?? null;
    if (latestState === "failed") {
        const failedAttempts = attempts.filter((attempt) => attempt.state === "failed");
        const hasNonRetryableFailure = failedAttempts.some((attempt) => !isRetryableBridgeTaskFailure(attempt));
        if (!hasNonRetryableFailure && failedAttempts.length <= desc.retries) {
            throw new RetriableTaskFailure(desc.nodeId, latestAttempt);
        }
    }
    return {
        state: latestState,
        attempt: latestAttempt,
        idempotencyKey: context.idempotencyKey,
    };
};
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {_TaskDescriptor} desc
 */
const getNextTaskActivityAttempt = async (adapter, runId, desc) => {
    const attempts = await runEffectOrPromise(adapter.listAttempts(runId, desc.nodeId, desc.iteration));
    const latestAttempt = attempts[0]?.attempt ?? 0;
    return latestAttempt + 1;
};
/**
 * @param {SmithersDb} adapter
 * @param {_BunSQLiteDatabase} db
 * @param {string} runId
 * @param {_TaskDescriptor} desc
 * @param {Map<string, _TaskDescriptor>} descriptorMap
 * @param {SQLiteTable} inputTable
 * @param {EventBus} eventBus
 * @param {TaskBridgeToolConfig} toolConfig
 * @param {string} workflowName
 * @param {boolean} cacheEnabled
 * @param {BridgeManagedTaskKind} bridgeManagedExecution
 * @param {_TaskActivityContext} context
 * @param {AbortSignal} [signal]
 * @param {Set<string>} [disabledAgents]
 * @param {AbortController} [runAbortController]
 * @param {HijackState} [hijackState]
 * @param {LegacyExecuteTaskFn} [legacyExecuteTaskFn]
 */
const executeBridgeAttempt = async (adapter, db, runId, desc, descriptorMap, inputTable, eventBus, toolConfig, workflowName, cacheEnabled, bridgeManagedExecution, context, signal, disabledAgents, runAbortController, hijackState, legacyExecuteTaskFn) => {
    if (bridgeManagedExecution === "static") {
        await executeStaticTaskBridge(adapter, runId, desc, eventBus, toolConfig, workflowName, signal);
    }
    else if (bridgeManagedExecution === "compute") {
        await executeComputeTaskBridge(adapter, db, runId, desc, eventBus, toolConfig, workflowName, signal);
    }
    else {
        await legacyExecuteTaskFn(adapter, db, runId, desc, descriptorMap, inputTable, eventBus, toolConfig, workflowName, cacheEnabled, signal, disabledAgents, runAbortController, hijackState);
    }
    return classifyTaskAttempt(adapter, runId, desc, context);
};
/**
 * @param {SmithersDb} adapter
 * @param {_BunSQLiteDatabase} db
 * @param {string} runId
 * @param {_TaskDescriptor} desc
 * @param {Map<string, _TaskDescriptor>} descriptorMap
 * @param {SQLiteTable} inputTable
 * @param {EventBus} eventBus
 * @param {TaskBridgeToolConfig} toolConfig
 * @param {string} workflowName
 * @param {boolean} cacheEnabled
 * @param {BridgeManagedTaskKind} bridgeManagedExecution
 * @param {string} bridgeKey
 * @param {AbortSignal} [signal]
 * @param {Set<string>} [disabledAgents]
 * @param {AbortController} [runAbortController]
 * @param {HijackState} [hijackState]
 * @param {LegacyExecuteTaskFn} [legacyExecuteTaskFn]
 */
const runTaskBridgeExecution = async (adapter, db, runId, desc, descriptorMap, inputTable, eventBus, toolConfig, workflowName, cacheEnabled, bridgeManagedExecution, bridgeKey, signal, disabledAgents, runAbortController, hijackState, legacyExecuteTaskFn) => {
    const initialAttempt = await getNextTaskActivityAttempt(adapter, runId, desc);
    const workerTask = makeWorkerTask(bridgeKey, workflowName, runId, desc, bridgeManagedExecution);
    const executeInProcess = async () => {
        try {
            await executeTaskActivity(adapter, workflowName, runId, desc, (context) => executeBridgeAttempt(adapter, db, runId, desc, descriptorMap, inputTable, eventBus, toolConfig, workflowName, cacheEnabled, bridgeManagedExecution, context, signal, disabledAgents, runAbortController, hijackState, legacyExecuteTaskFn), {
                initialAttempt,
                retry: false,
            });
            return { terminal: true };
        }
        catch (error) {
            if (error instanceof RetriableTaskFailure) {
                return { terminal: false };
            }
            throw error;
        }
    };
    try {
        return await dispatchWorkerTask(workerTask, executeInProcess);
    }
    catch (error) {
        if (!isSingleRunnerBootstrapError(error)) {
            throw error;
        }
        notifyTaskWorkerDispatch(workerTask);
        return executeInProcess();
    }
};
/**
 * @param {SmithersDb} adapter
 * @param {_BunSQLiteDatabase} db
 * @param {string} runId
 * @param {_TaskDescriptor} desc
 * @param {Map<string, _TaskDescriptor>} descriptorMap
 * @param {SQLiteTable} inputTable
 * @param {EventBus} eventBus
 * @param {TaskBridgeToolConfig} toolConfig
 * @param {string} workflowName
 * @param {boolean} cacheEnabled
 * @param {AbortSignal} [signal]
 * @param {Set<string>} [disabledAgents]
 * @param {AbortController} [runAbortController]
 * @param {HijackState} [hijackState]
 * @param {LegacyExecuteTaskFn} [legacyExecuteTaskFn]
 * @returns {Promise<void>}
 */
export const executeTaskBridge = (adapter, db, runId, desc, descriptorMap, inputTable, eventBus, toolConfig, workflowName, cacheEnabled, signal, disabledAgents, runAbortController, hijackState, legacyExecuteTaskFn) => {
    const bridgeManagedExecution = canExecuteBridgeManagedComputeTask(desc, cacheEnabled)
        ? "compute"
        : canExecuteBridgeManagedStaticTask(desc, cacheEnabled)
            ? "static"
            : "legacy";
    if (bridgeManagedExecution === "legacy" && typeof legacyExecuteTaskFn !== "function") {
        return Promise.reject(new TypeError("legacyExecuteTaskFn must be provided"));
    }
    const bridgeKey = makeTaskBridgeKey(adapter, workflowName, runId, desc);
    const completed = completedTaskExecutions.get(bridgeKey);
    if (completed) {
        return completed;
    }
    const existing = inflightTaskExecutions.get(bridgeKey);
    if (existing) {
        return existing;
    }
    const execution = runTaskBridgeExecution(adapter, db, runId, desc, descriptorMap, inputTable, eventBus, toolConfig, workflowName, cacheEnabled, bridgeManagedExecution, bridgeKey, signal, disabledAgents, runAbortController, hijackState, legacyExecuteTaskFn)
        .then((result) => {
        if (!result.terminal) {
            return undefined;
        }
        completedTaskExecutions.set(bridgeKey, execution);
        setTimeout(() => {
            if (completedTaskExecutions.get(bridgeKey) === execution) {
                completedTaskExecutions.delete(bridgeKey);
            }
        }, 0);
        return undefined;
    })
        .finally(() => {
        if (inflightTaskExecutions.get(bridgeKey) === execution) {
            inflightTaskExecutions.delete(bridgeKey);
        }
    });
    inflightTaskExecutions.set(bridgeKey, execution);
    return execution;
};
/**
 * @param {SmithersDb} adapter
 * @param {_BunSQLiteDatabase} db
 * @param {string} runId
 * @param {_TaskDescriptor} desc
 * @param {Map<string, _TaskDescriptor>} descriptorMap
 * @param {SQLiteTable} inputTable
 * @param {EventBus} eventBus
 * @param {TaskBridgeToolConfig} toolConfig
 * @param {string} workflowName
 * @param {boolean} cacheEnabled
 * @param {AbortSignal} [signal]
 * @param {Set<string>} [disabledAgents]
 * @param {AbortController} [runAbortController]
 * @param {HijackState} [hijackState]
 * @param {LegacyExecuteTaskFn} [legacyExecuteTaskFn]
 * @returns {Effect.Effect<void, import("@smithers-orchestrator/errors/SmithersError").SmithersError, never>}
 */
export const executeTaskBridgeEffect = (adapter, db, runId, desc, descriptorMap, inputTable, eventBus, toolConfig, workflowName, cacheEnabled, signal, disabledAgents, runAbortController, hijackState, legacyExecuteTaskFn) => Effect.tryPromise({
    try: () => executeTaskBridge(adapter, db, runId, desc, descriptorMap, inputTable, eventBus, toolConfig, workflowName, cacheEnabled, signal, disabledAgents, runAbortController, hijackState, legacyExecuteTaskFn),
    catch: (cause) => toSmithersError(cause, "execute task bridge"),
});
