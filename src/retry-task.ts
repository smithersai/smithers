import { Effect } from "effect";
import type { SmithersDb } from "./db/adapter";
import type { SmithersEvent } from "./SmithersEvent";
import { nowMs } from "./utils/time";

export type RetryTaskOptions = {
  runId: string;
  nodeId: string;
  iteration?: number;
  resetDependents?: boolean;
  force?: boolean;
  onProgress?: (event: SmithersEvent) => void;
};

export type RetryTaskResult = {
  success: boolean;
  resetNodes: string[];
  error?: string;
};

function buildNodeKey(nodeId: string, iteration: number) {
  return `${nodeId}::${iteration}`;
}

function uniqueNodeIds(
  nodes: Array<{ nodeId: string; iteration: number }>,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const node of nodes) {
    if (seen.has(node.nodeId)) continue;
    seen.add(node.nodeId);
    result.push(node.nodeId);
  }
  return result;
}

function isActiveRunStatus(status: string | null | undefined) {
  return (
    status === "running" ||
    status === "waiting-approval" ||
    status === "waiting-event" ||
    status === "waiting-timer"
  );
}

async function resolveResetNodes(
  adapter: SmithersDb,
  opts: Required<Pick<RetryTaskOptions, "runId" | "resetDependents">> & {
    targetNode: any;
  },
) {
  const { runId, targetNode, resetDependents } = opts;
  if (!resetDependents) {
    return [targetNode];
  }

  const nodes = await adapter.listNodes(runId);
  const attempts = await adapter.listAttemptsForRun(runId);
  const attemptOrder = new Map<string, number>();
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index] as any;
    attemptOrder.set(
      buildNodeKey(attempt.nodeId, attempt.iteration ?? 0),
      index,
    );
  }

  const targetKey = buildNodeKey(targetNode.nodeId, targetNode.iteration ?? 0);
  const targetOrder = attemptOrder.get(targetKey);
  const targetIteration = targetNode.iteration ?? 0;
  const targetUpdatedAtMs = targetNode.updatedAtMs ?? 0;

  return (nodes as any[]).filter((node) => {
    const nodeIteration = node.iteration ?? 0;
    const nodeKey = buildNodeKey(node.nodeId, nodeIteration);
    if (nodeKey === targetKey) return true;
    if (nodeIteration > targetIteration) return true;

    const nodeOrder = attemptOrder.get(nodeKey);
    if (targetOrder !== undefined && nodeOrder !== undefined) {
      return nodeOrder > targetOrder;
    }

    return (node.updatedAtMs ?? 0) > targetUpdatedAtMs;
  });
}

function emitRetryFinished(
  opts: RetryTaskOptions,
  payload: {
    runId: string;
    nodeId: string;
    iteration: number;
    resetNodes: string[];
    success: boolean;
    error?: string;
  },
) {
  opts.onProgress?.({
    type: "RetryTaskFinished",
    ...payload,
    timestampMs: nowMs(),
  });
}

export async function retryTask(
  adapter: SmithersDb,
  opts: RetryTaskOptions,
): Promise<RetryTaskResult> {
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

  if (!force && isActiveRunStatus((run as any).status)) {
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
  const resetNodeIds = uniqueNodeIds(
    resetNodes.map((candidate: any) => ({
      nodeId: candidate.nodeId,
      iteration: candidate.iteration ?? 0,
    })),
  );
  const attemptsByNode = new Map<string, any[]>();
  for (const resetNode of resetNodes as any[]) {
    const resetIteration = resetNode.iteration ?? 0;
    attemptsByNode.set(
      buildNodeKey(resetNode.nodeId, resetIteration),
      await adapter.listAttempts(runId, resetNode.nodeId, resetIteration),
    );
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
  await adapter.withTransaction(
    "retry-task-reset",
    Effect.gen(function* () {
      for (const resetNode of resetNodes as any[]) {
        const resetIteration = resetNode.iteration ?? 0;
        const attempts =
          attemptsByNode.get(buildNodeKey(resetNode.nodeId, resetIteration)) ??
          [];
        for (const attempt of attempts) {
          if (
            attempt.state !== "failed" &&
            attempt.state !== "in-progress" &&
            attempt.state !== "waiting-approval" &&
            attempt.state !== "waiting-event" &&
            attempt.state !== "waiting-timer"
          ) {
            continue;
          }
          const patch: Record<string, unknown> = { state: "cancelled" };
          if (attempt.finishedAtMs == null) {
            patch.finishedAtMs = resetTimestampMs;
          }
          yield* adapter.updateAttemptEffect(
            runId,
            resetNode.nodeId,
            resetIteration,
            attempt.attempt,
            patch,
          );
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
    }),
  );

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
