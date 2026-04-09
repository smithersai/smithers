import type { TaskDescriptor } from "../TaskDescriptor";
import type { HijackState } from "../engine/index";
import { SmithersDb } from "../db/adapter";
import { EventBus } from "../events";
import { fromPromise } from "./interop";
import {
  makeWorkerTask,
  type WorkerDispatchKind,
} from "./entity-worker";
import {
  executeTaskActivity,
  makeTaskBridgeKey,
  RetriableTaskFailure,
  type TaskActivityContext,
} from "./activity-bridge";
import {
  canExecuteBridgeManagedComputeTask,
  executeComputeTaskBridge,
} from "./compute-task-bridge";
import {
  canExecuteBridgeManagedStaticTask,
  executeStaticTaskBridge,
} from "./static-task-bridge";
import { dispatchWorkerTask } from "./single-runner";
export {
  bridgeApprovalResolve,
  bridgeSignalResolve,
  bridgeWaitForEventResolve,
  awaitApprovalDurableDeferred,
  awaitWaitForEventDurableDeferred,
  makeApprovalDurableDeferred,
  makeDurableDeferredBridgeExecutionId,
  makeWaitForEventDurableDeferred,
} from "./durable-deferred-bridge";
export {
  cancelPendingTimersBridge,
  isBridgeManagedTimerTask,
  isBridgeManagedWaitForEventTask,
  resolveDeferredTaskStateBridge,
} from "./deferred-state-bridge";
export {
  createSchedulerWakeQueue,
  getWorkflowMakeBridgeRuntime,
  runWorkflowWithMakeBridge,
  withWorkflowMakeBridgeRuntime,
} from "./workflow-make-bridge";
export {
  SqlMessageStorage,
  ensureSqlMessageStorage,
  ensureSqlMessageStorageEffect,
  getSqlMessageStorage,
} from "./sql-message-storage";
export {
  SandboxEntity,
  SandboxEntityExecutor,
  makeSandboxEntityId,
  makeSandboxTransportServiceEffect,
} from "./sandbox-entity";
export {
  CodeplaneSandboxExecutorLive,
  DockerSandboxExecutorLive,
  SandboxHttpRunner,
} from "./http-runner";
export {
  BubblewrapSandboxExecutorLive,
  SandboxSocketRunner,
} from "./socket-runner";
export {
  isTaskResultFailure,
  makeWorkerTask,
  TaskResult,
  WorkerDispatchKind,
  WorkerTask,
  WorkerTaskKind,
  TaskWorkerEntity,
} from "./entity-worker";
export {
  dispatchWorkerTask,
  subscribeTaskWorkerDispatches,
} from "./single-runner";

type BridgeManagedTaskKind = WorkerDispatchKind;

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

const inflightTaskExecutions = new Map<string, Promise<void>>();
const completedTaskExecutions = new Map<string, Promise<void>>();

export type TaskBridgeToolConfig = {
  rootDir: string;
  allowNetwork: boolean;
  maxOutputBytes: number;
  toolTimeoutMs: number;
};

export type LegacyExecuteTaskFn = (
  adapter: SmithersDb,
  db: any,
  runId: string,
  desc: TaskDescriptor,
  descriptorMap: Map<string, TaskDescriptor>,
  inputTable: any,
  eventBus: EventBus,
  toolConfig: TaskBridgeToolConfig,
  workflowName: string,
  cacheEnabled: boolean,
  signal?: AbortSignal,
  disabledAgents?: Set<any>,
  runAbortController?: AbortController,
  hijackState?: HijackState,
) => Promise<void>;

const classifyTaskAttempt = async (
  adapter: SmithersDb,
  runId: string,
  desc: TaskDescriptor,
  context: TaskActivityContext,
) => {
  const attempts = await adapter.listAttempts(runId, desc.nodeId, desc.iteration);
  const latest = attempts[0];
  const latestAttempt = latest?.attempt ?? context.attempt;
  const latestState = latest?.state ?? null;

  if (latestState === "failed") {
    const failedAttempts = attempts.filter((attempt: any) => attempt.state === "failed");
    if (failedAttempts.length <= desc.retries) {
      throw new RetriableTaskFailure(desc.nodeId, latestAttempt);
    }
  }

  return {
    state: latestState,
    attempt: latestAttempt,
    idempotencyKey: context.idempotencyKey,
  };
};

const getNextTaskActivityAttempt = async (
  adapter: SmithersDb,
  runId: string,
  desc: TaskDescriptor,
) => {
  const attempts = await adapter.listAttempts(runId, desc.nodeId, desc.iteration);
  const latestAttempt = attempts[0]?.attempt ?? 0;
  return latestAttempt + 1;
};

const executeBridgeAttempt = async (
  adapter: SmithersDb,
  db: any,
  runId: string,
  desc: TaskDescriptor,
  descriptorMap: Map<string, TaskDescriptor>,
  inputTable: any,
  eventBus: EventBus,
  toolConfig: TaskBridgeToolConfig,
  workflowName: string,
  cacheEnabled: boolean,
  bridgeManagedExecution: BridgeManagedTaskKind,
  context: TaskActivityContext,
  signal?: AbortSignal,
  disabledAgents?: Set<any>,
  runAbortController?: AbortController,
  hijackState?: HijackState,
  legacyExecuteTaskFn?: LegacyExecuteTaskFn,
) => {
  if (bridgeManagedExecution === "static") {
    await executeStaticTaskBridge(
      adapter,
      runId,
      desc,
      eventBus,
      toolConfig,
      workflowName,
      signal,
    );
  } else if (bridgeManagedExecution === "compute") {
    await executeComputeTaskBridge(
      adapter,
      db,
      runId,
      desc,
      eventBus,
      toolConfig,
      workflowName,
      signal,
    );
  } else {
    await legacyExecuteTaskFn!(
      adapter,
      db,
      runId,
      desc,
      descriptorMap,
      inputTable,
      eventBus,
      toolConfig,
      workflowName,
      cacheEnabled,
      signal,
      disabledAgents,
      runAbortController,
      hijackState,
    );
  }

  return classifyTaskAttempt(adapter, runId, desc, context);
};

const runTaskBridgeExecution = async (
  adapter: SmithersDb,
  db: any,
  runId: string,
  desc: TaskDescriptor,
  descriptorMap: Map<string, TaskDescriptor>,
  inputTable: any,
  eventBus: EventBus,
  toolConfig: TaskBridgeToolConfig,
  workflowName: string,
  cacheEnabled: boolean,
  bridgeManagedExecution: BridgeManagedTaskKind,
  bridgeKey: string,
  signal?: AbortSignal,
  disabledAgents?: Set<any>,
  runAbortController?: AbortController,
  hijackState?: HijackState,
  legacyExecuteTaskFn?: LegacyExecuteTaskFn,
) => {
  const initialAttempt = await getNextTaskActivityAttempt(adapter, runId, desc);

  return dispatchWorkerTask(
    makeWorkerTask(bridgeKey, workflowName, runId, desc, bridgeManagedExecution),
    async () => {
      try {
        await executeTaskActivity(
          adapter,
          workflowName,
          runId,
          desc,
          (context) =>
            executeBridgeAttempt(
              adapter,
              db,
              runId,
              desc,
              descriptorMap,
              inputTable,
              eventBus,
              toolConfig,
              workflowName,
              cacheEnabled,
              bridgeManagedExecution,
              context,
              signal,
              disabledAgents,
              runAbortController,
              hijackState,
              legacyExecuteTaskFn,
            ),
          {
            initialAttempt,
            retry: false,
          },
        );
        return { terminal: true as const };
      } catch (error) {
        if (error instanceof RetriableTaskFailure) {
          return { terminal: false as const };
        }
        throw error;
      }
    },
  );
};

export const executeTaskBridge = (
  adapter: SmithersDb,
  db: any,
  runId: string,
  desc: TaskDescriptor,
  descriptorMap: Map<string, TaskDescriptor>,
  inputTable: any,
  eventBus: EventBus,
  toolConfig: TaskBridgeToolConfig,
  workflowName: string,
  cacheEnabled: boolean,
  signal?: AbortSignal,
  disabledAgents?: Set<any>,
  runAbortController?: AbortController,
  hijackState?: HijackState,
  legacyExecuteTaskFn?: LegacyExecuteTaskFn,
): Promise<void> => {
  const bridgeManagedExecution: BridgeManagedTaskKind =
    canExecuteBridgeManagedComputeTask(desc, cacheEnabled)
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

  const execution = runTaskBridgeExecution(
    adapter,
    db,
    runId,
    desc,
    descriptorMap,
    inputTable,
    eventBus,
    toolConfig,
    workflowName,
    cacheEnabled,
    bridgeManagedExecution,
    bridgeKey,
    signal,
    disabledAgents,
    runAbortController,
    hijackState,
    legacyExecuteTaskFn,
  )
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

export const executeTaskBridgeEffect = (
  adapter: SmithersDb,
  db: any,
  runId: string,
  desc: TaskDescriptor,
  descriptorMap: Map<string, TaskDescriptor>,
  inputTable: any,
  eventBus: EventBus,
  toolConfig: TaskBridgeToolConfig,
  workflowName: string,
  cacheEnabled: boolean,
  signal?: AbortSignal,
  disabledAgents?: Set<any>,
  runAbortController?: AbortController,
  hijackState?: HijackState,
  legacyExecuteTaskFn?: LegacyExecuteTaskFn,
) =>
  fromPromise("execute task bridge", () =>
    executeTaskBridge(
      adapter,
      db,
      runId,
      desc,
      descriptorMap,
      inputTable,
      eventBus,
      toolConfig,
      workflowName,
      cacheEnabled,
      signal,
      disabledAgents,
      runAbortController,
      hijackState,
      legacyExecuteTaskFn,
    ),
  );
