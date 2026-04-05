import type { TaskDescriptor } from "../TaskDescriptor";
import type { HijackState } from "../engine/index";
import { SmithersDb } from "../db/adapter";
import { EventBus } from "../events";
import {
  executeTaskActivity,
  makeTaskBridgeKey,
  RetriableTaskFailure,
  type TaskActivityContext,
} from "./activity-bridge";
import { computeRetryDelayMs } from "../utils/retry";

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

const waitForRetryDelay = async (
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> => {
  if (delayMs <= 0) {
    return;
  }
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Task retry aborted");
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("Task retry aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

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

export const executeTaskBridge = (
  adapter: SmithersDb,
  db: any,
  runId: string,
  desc: TaskDescriptor,
  descriptorMap: Map<string, TaskDescriptor>,
  inputTable: any,
  eventBus: EventBus,
  toolConfig: {
    rootDir: string;
    allowNetwork: boolean;
    maxOutputBytes: number;
    toolTimeoutMs: number;
  },
  workflowName: string,
  cacheEnabled: boolean,
  signal?: AbortSignal,
  disabledAgents?: Set<any>,
  runAbortController?: AbortController,
  hijackState?: HijackState,
  legacyExecuteTaskFn?: any // injected to avoid circular dependency for now
): Promise<void> => {
  if (typeof legacyExecuteTaskFn !== "function") {
    return Promise.reject(new TypeError("legacyExecuteTaskFn must be provided"));
  }

  const bridgeKey = makeTaskBridgeKey(adapter, workflowName, runId, desc);
  const existing = inflightTaskExecutions.get(bridgeKey);
  if (existing) {
    return existing;
  }

  const execution = executeTaskActivity(
    adapter,
    workflowName,
    runId,
    desc,
    async (context) => {
      if (context.attempt > 1) {
        const delayMs = computeRetryDelayMs(desc.retryPolicy, context.attempt - 1);
        await waitForRetryDelay(delayMs, signal);
      }

      await legacyExecuteTaskFn(
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
        hijackState
      );

      return classifyTaskAttempt(adapter, runId, desc, context);
    },
  )
    .then(() => undefined)
    .finally(() => {
      if (inflightTaskExecutions.get(bridgeKey) === execution) {
        inflightTaskExecutions.delete(bridgeKey);
      }
    });

  inflightTaskExecutions.set(bridgeKey, execution);
  return execution;
};
