import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import type { SmithersEvent } from "@smithers/observability/SmithersEvent";
import { nowMs } from "@smithers/scheduler/nowMs";
import { revertToJjPointer } from "@smithers/vcs/jj";

export type TimeTravelOptions = {
  runId: string;
  nodeId: string;
  iteration?: number;
  attempt?: number;
  resetDependents?: boolean;
  restoreVcs?: boolean;
  onProgress?: (event: SmithersEvent) => void;
};

export type TimeTravelResult = {
  success: boolean;
  jjPointer?: string;
  vcsRestored: boolean;
  resetNodes: string[];
  error?: string;
};

type AttemptRow = Awaited<ReturnType<SmithersDb["getAttempt"]>>;
type NodeRow = Awaited<ReturnType<SmithersDb["getNode"]>>;

function nodeKey(nodeId: string, iteration: number) {
  return `${nodeId}::${iteration}`;
}

function uniqueNodeIds(
  nodes: Array<{ nodeId: string; iteration: number }>,
) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const node of nodes) {
    if (seen.has(node.nodeId)) continue;
    seen.add(node.nodeId);
    result.push(node.nodeId);
  }
  return result;
}

function selectAttempt(attempts: any[], requestedAttempt?: number): AttemptRow | undefined {
  if (requestedAttempt == null) return attempts[0];
  return attempts.find((attempt) => attempt.attempt === requestedAttempt);
}

function findTargetAttemptOrder(
  targetAttempt: NonNullable<AttemptRow>,
  attemptsForRun: any[],
) {
  return attemptsForRun.findIndex(
    (attempt) =>
      attempt.runId === targetAttempt.runId &&
      attempt.nodeId === targetAttempt.nodeId &&
      (attempt.iteration ?? 0) === (targetAttempt.iteration ?? 0) &&
      attempt.attempt === targetAttempt.attempt,
  );
}

async function resolveResetNodes(
  adapter: SmithersDb,
  opts: {
    runId: string;
    targetNode: NonNullable<NodeRow>;
    targetAttempt: NonNullable<AttemptRow>;
    attemptsForRun: any[];
    resetDependents: boolean;
  },
) {
  const { runId, targetNode, targetAttempt, attemptsForRun, resetDependents } = opts;
  if (!resetDependents) {
    return [targetNode];
  }

  const nodes = await adapter.listNodes(runId);
  const targetKey = nodeKey(targetNode.nodeId, targetNode.iteration ?? 0);
  const targetAttemptOrder = findTargetAttemptOrder(targetAttempt, attemptsForRun);
  const targetIteration = targetNode.iteration ?? 0;
  const cutoff = targetAttempt.startedAtMs;

  return (nodes as any[]).filter((node) => {
    const currentKey = nodeKey(node.nodeId, node.iteration ?? 0);
    if (currentKey === targetKey) return true;
    if ((node.iteration ?? 0) > targetIteration) return true;

    let startedAfterTarget = false;
    let orderedAfterTarget = false;
    for (let index = 0; index < attemptsForRun.length; index += 1) {
      const attempt = attemptsForRun[index] as any;
      if (
        attempt.nodeId !== node.nodeId ||
        (attempt.iteration ?? 0) !== (node.iteration ?? 0)
      ) {
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

function buildPendingNode(existingNode: NonNullable<NodeRow>) {
  return {
    ...existingNode,
    state: "pending",
    updatedAtMs: nowMs(),
  };
}

export async function timeTravel(
  adapter: SmithersDb,
  opts: TimeTravelOptions,
): Promise<TimeTravelResult> {
  const runId = opts.runId;
  const nodeId = opts.nodeId;
  const iteration = opts.iteration ?? 0;
  const resetDependents = opts.resetDependents ?? true;
  const restoreVcs = opts.restoreVcs ?? true;

  const attempts = await adapter.listAttempts(runId, nodeId, iteration);
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
  const targetNode = await adapter.getNode(runId, nodeId, iteration);
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
    const vcsResult = await revertToJjPointer(
      jjPointer,
      targetAttempt.jjCwd ?? undefined,
    );
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

  const attemptsForRun = await adapter.listAttemptsForRun(runId);
  const resetNodes = await resolveResetNodes(adapter, {
    runId,
    targetNode,
    targetAttempt,
    attemptsForRun,
    resetDependents,
  });
  const resetNodeIds = uniqueNodeIds(
    resetNodes.map((node) => ({
      nodeId: node.nodeId,
      iteration: node.iteration ?? 0,
    })),
  );
  const attemptsByNode = new Map<string, any[]>();
  for (const resetNode of resetNodes as any[]) {
    attemptsByNode.set(
      nodeKey(resetNode.nodeId, resetNode.iteration ?? 0),
      attemptsForRun.filter(
        (attempt: any) =>
          attempt.nodeId === resetNode.nodeId &&
          (attempt.iteration ?? 0) === (resetNode.iteration ?? 0),
      ),
    );
  }

  await adapter.withTransaction(
    "time-travel",
    Effect.gen(function* () {
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

      for (const resetNode of resetNodes as any[]) {
        const attemptsForNode =
          attemptsByNode.get(nodeKey(resetNode.nodeId, resetNode.iteration ?? 0)) ??
          [];
        for (const attempt of attemptsForNode) {
          if ((attempt.startedAtMs ?? 0) < cutoff || attempt.state === "cancelled") {
            continue;
          }
          const patch: Record<string, unknown> = { state: "cancelled" };
          if (attempt.finishedAtMs == null) {
            patch.finishedAtMs = nowMs();
          }
          yield* adapter.updateAttempt(
            runId,
            resetNode.nodeId,
            resetNode.iteration ?? 0,
            attempt.attempt,
            patch,
          );
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
    }),
  );

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
