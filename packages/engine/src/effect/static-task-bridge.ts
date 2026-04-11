import { Effect, Metric } from "effect";
import { z } from "zod";
import type { TaskDescriptor } from "@smithers/graph/TaskDescriptor";
import type { SmithersDb } from "@smithers/db/adapter";
import { buildOutputRow, stripAutoColumns, validateOutput } from "@smithers/db/output";
import { EventBus } from "../events";
import { makeAbortError, wireAbortSignal } from "./bridge-utils";
import { logDebug, logError, logInfo } from "@smithers/observability/logging";
import { attemptDuration, nodeDuration } from "@smithers/observability/metrics";
import { errorToJson } from "@smithers/errors/errorToJson";
import { SmithersError } from "@smithers/errors/SmithersError";
import { nowMs } from "@smithers/scheduler/nowMs";
import { getJjPointer } from "@smithers/vcs/jj";

type StaticTaskBridgeToolConfig = {
  rootDir: string;
};

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  if ((err as any).name === "AbortError") return true;
  if (
    typeof DOMException !== "undefined" &&
    err instanceof DOMException &&
    err.name === "AbortError"
  ) {
    return true;
  }
  if (err instanceof Error) {
    return /aborted|abort/i.test(err.message);
  }
  return false;
}

export const canExecuteBridgeManagedStaticTask = (
  desc: TaskDescriptor,
  cacheEnabled: boolean,
): boolean => {
  if (cacheEnabled || desc.cachePolicy) {
    return false;
  }
  if (desc.agent || desc.computeFn || desc.staticPayload === undefined) {
    return false;
  }
  if (desc.worktreePath) {
    return false;
  }
  return !desc.scorers || Object.keys(desc.scorers).length === 0;
};

export const executeStaticTaskBridge = async (
  adapter: SmithersDb,
  runId: string,
  desc: TaskDescriptor,
  eventBus: EventBus,
  toolConfig: StaticTaskBridgeToolConfig,
  workflowName: string,
  signal?: AbortSignal,
): Promise<void> => {
  const taskStartMs = performance.now();
  const attempts = await Effect.runPromise(adapter.listAttempts(runId, desc.nodeId, desc.iteration));
  const attemptNo = (attempts[0]?.attempt ?? 0) + 1;
  const taskAbortController = new AbortController();
  const removeAbortForwarder = wireAbortSignal(taskAbortController, signal);
  const taskSignal = taskAbortController.signal;
  const startedAtMs = nowMs();
  const attemptMeta: Record<string, unknown> = {
    kind: "static",
    prompt: desc.prompt ?? null,
    staticPayload: desc.staticPayload ?? null,
    label: desc.label ?? null,
    outputTable: desc.outputTableName,
    needsApproval: desc.needsApproval,
    retries: desc.retries,
    timeoutMs: desc.timeoutMs,
    heartbeatTimeoutMs: desc.heartbeatTimeoutMs,
    lastHeartbeat: null,
    agentId: null,
    agentModel: null,
    agentEngine: null,
    agentResume: null,
    agentConversation: null,
    resumedFromSession: null,
    resumedFromConversation: false,
    hijackHandoff: null,
  };

  await adapter.withTransaction(
    "task-start",
    Effect.gen(function* () {
      yield* adapter.insertAttempt({
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        state: "in-progress",
        startedAtMs,
        finishedAtMs: null,
        heartbeatAtMs: null,
        heartbeatDataJson: null,
        errorJson: null,
        jjPointer: null,
        jjCwd: toolConfig.rootDir,
        cached: false,
        metaJson: JSON.stringify(attemptMeta),
      });
      yield* adapter.insertNode({
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        state: "in-progress",
        lastAttempt: attemptNo,
        updatedAtMs: nowMs(),
        outputTable: desc.outputTableName,
        label: desc.label ?? null,
      });
    }),
  );

  await eventBus.emitEventWithPersist({
    type: "NodeStarted",
    runId,
    nodeId: desc.nodeId,
    iteration: desc.iteration,
    attempt: attemptNo,
    timestampMs: nowMs(),
  });

  try {
    if (taskSignal.aborted) {
      throw taskSignal.reason ?? makeAbortError();
    }

    logDebug(
      "bridge-managed static task execution starting",
      {
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        workflowName,
      },
      "engine:task",
    );

    let payload = stripAutoColumns(desc.staticPayload);
    const payloadWithKeys = buildOutputRow(
      desc.outputTable as any,
      runId,
      desc.nodeId,
      desc.iteration,
      payload,
    );
    let validation = validateOutput(desc.outputTable as any, payloadWithKeys);

    if (validation.ok && desc.outputSchema) {
      const zodResult = (desc.outputSchema as z.ZodType).safeParse(payload);
      if (!zodResult.success) {
        validation = { ok: false, error: zodResult.error };
      }
    }

    if (!validation.ok) {
      attemptMeta.failureRetryable = false;
      throw new SmithersError(
        "INVALID_OUTPUT",
        `Task output failed validation for ${desc.outputTableName}`,
        {
          attempt: attemptNo,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          outputTable: desc.outputTableName,
          issues: validation.error?.issues,
        },
        { cause: validation.error },
      );
    }

    payload = validation.data;
    const completedAtMs = nowMs();
    const jjPointer = await getJjPointer(toolConfig.rootDir);

    await adapter.withTransaction(
      "task-completion",
      Effect.gen(function* () {
        yield* adapter.upsertOutputRow(
          desc.outputTable as any,
          { runId, nodeId: desc.nodeId, iteration: desc.iteration },
          payload as Record<string, unknown>,
        );
        yield* adapter.updateAttempt(
          runId,
          desc.nodeId,
          desc.iteration,
          attemptNo,
          {
            state: "finished",
            finishedAtMs: completedAtMs,
            jjPointer,
            cached: false,
            metaJson: JSON.stringify(attemptMeta),
            responseText: null,
          },
        );
        yield* adapter.insertNode({
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          state: "finished",
          lastAttempt: attemptNo,
          updatedAtMs: completedAtMs,
          outputTable: desc.outputTableName,
          label: desc.label ?? null,
        });
      }),
    );

    await eventBus.emitEventWithPersist({
      type: "NodeFinished",
      runId,
      nodeId: desc.nodeId,
      iteration: desc.iteration,
      attempt: attemptNo,
      timestampMs: nowMs(),
    });

    const taskElapsedMs = performance.now() - taskStartMs;
    void Effect.runPromise(
      Effect.all(
        [
          Metric.update(nodeDuration, taskElapsedMs),
          Metric.update(attemptDuration, taskElapsedMs),
        ],
        { discard: true },
      ),
    );

    logInfo(
      "bridge-managed static task execution finished",
      {
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        durationMs: Math.round(taskElapsedMs),
        jjPointer,
      },
      "engine:task",
    );
  } catch (err) {
    const aborted = taskSignal.aborted || isAbortError(err);
    const effectiveError =
      aborted && taskSignal.reason !== undefined
        ? taskSignal.reason
        : aborted
          ? makeAbortError()
          : err;

    if (aborted) {
      const cancelledAtMs = nowMs();
      await adapter.withTransaction(
        "task-cancel",
        Effect.gen(function* () {
          yield* adapter.updateAttempt(
            runId,
            desc.nodeId,
            desc.iteration,
            attemptNo,
            {
              state: "cancelled",
              finishedAtMs: cancelledAtMs,
              errorJson: JSON.stringify(errorToJson(effectiveError)),
              metaJson: JSON.stringify(attemptMeta),
              responseText: null,
            },
          );
          yield* adapter.insertNode({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: "cancelled",
            lastAttempt: attemptNo,
            updatedAtMs: cancelledAtMs,
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
          });
        }),
      );

      await eventBus.emitEventWithPersist({
        type: "NodeCancelled",
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        reason: "aborted",
        timestampMs: nowMs(),
      });

      logInfo(
        "bridge-managed static task execution cancelled",
        {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          error:
            effectiveError instanceof Error
              ? effectiveError.message
              : String(effectiveError),
        },
        "engine:task",
      );
      return;
    }

    logError(
      "bridge-managed static task execution failed",
      {
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        maxAttempts: Number.isFinite(desc.retries) ? desc.retries + 1 : "infinite",
        error:
          effectiveError instanceof Error
            ? effectiveError.message
            : String(effectiveError),
      },
      "engine:task",
    );

    const failedAtMs = nowMs();
    await adapter.withTransaction(
      "task-fail",
      Effect.gen(function* () {
        yield* adapter.updateAttempt(
          runId,
          desc.nodeId,
          desc.iteration,
          attemptNo,
          {
            state: "failed",
            finishedAtMs: failedAtMs,
            errorJson: JSON.stringify(errorToJson(effectiveError)),
            metaJson: JSON.stringify(attemptMeta),
            responseText: null,
          },
        );
        yield* adapter.insertNode({
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          state: "failed",
          lastAttempt: attemptNo,
          updatedAtMs: failedAtMs,
          outputTable: desc.outputTableName,
          label: desc.label ?? null,
        });
      }),
    );

    await eventBus.emitEventWithPersist({
      type: "NodeFailed",
      runId,
      nodeId: desc.nodeId,
      iteration: desc.iteration,
      attempt: attemptNo,
      error: errorToJson(effectiveError),
      timestampMs: nowMs(),
    });

    const updatedAttempts = await Effect.runPromise(adapter.listAttempts(
      runId,
      desc.nodeId,
      desc.iteration,
    ));
    const failedAttempts = updatedAttempts.filter(
      (attempt: any) => attempt.state === "failed",
    );
    if (attemptMeta.failureRetryable !== false && failedAttempts.length <= desc.retries) {
      await eventBus.emitEventWithPersist({
        type: "NodeRetrying",
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo + 1,
        timestampMs: nowMs(),
      });
    }
  } finally {
    removeAbortForwarder();
  }
};
