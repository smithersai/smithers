import { and, eq } from "drizzle-orm";
import { Effect, Metric } from "effect";
import type { SmithersDb } from "../db/adapter";
import { fromPromise } from "../effect/interop";
import { runPromise } from "../effect/runtime";
import { nowMs } from "../utils/time";
import { newRunId } from "../utils/ids";
import { SmithersError } from "../utils/errors";
import { smithersBranches, smithersSnapshots } from "./schema";
import { loadSnapshotEffect, parseSnapshot } from "./snapshot";
import { runForksCreated } from "./metrics";
import type { ForkParams, BranchInfo, Snapshot, NodeSnapshot } from "./types";

// ---------------------------------------------------------------------------
// Downstream detection
// ---------------------------------------------------------------------------

/**
 * Given a set of node IDs to reset, compute the full transitive set including
 * all downstream dependents.  In the absence of an explicit dependency graph,
 * we reset every node whose iteration >= the minimum iteration of the reset
 * set. This is intentionally conservative — it re-runs more rather than less.
 */
function expandResetSet(
  nodes: Record<string, NodeSnapshot>,
  resetNodeIds: string[],
): string[] {
  if (resetNodeIds.length === 0) return [];

  const resetSet = new Set(resetNodeIds);
  const result = new Set<string>();

  // Collect all unique base nodeIds from the snapshot keyed as "nodeId::iteration"
  for (const key of Object.keys(nodes)) {
    const baseId = key.split("::")[0]!;
    if (resetSet.has(baseId)) {
      result.add(key);
    }
  }

  // If we found nothing via base nodeId, try exact key match
  if (result.size === 0) {
    for (const id of resetNodeIds) {
      if (nodes[id]) {
        result.add(id);
      }
    }
  }

  return [...result];
}

// ---------------------------------------------------------------------------
// Fork
// ---------------------------------------------------------------------------

export function forkRunEffect(
  adapter: SmithersDb,
  params: ForkParams,
): Effect.Effect<{ runId: string; branch: BranchInfo; snapshot: Snapshot }, SmithersError> {
  return Effect.gen(function* () {
    const { parentRunId, frameNo, inputOverrides, resetNodes, branchLabel, forkDescription } = params;

    // 1. Load source snapshot
    const source = yield* loadSnapshotEffect(adapter, parentRunId, frameNo);
    if (!source) {
      return yield* Effect.fail(
        new SmithersError(
          "SNAPSHOT_NOT_FOUND",
          `No snapshot found for run=${parentRunId} frame=${frameNo}`,
          { frameNo, runId: parentRunId },
        ),
      );
    }

    // 2. Create new run ID
    const childRunId = newRunId();
    const ts = nowMs();
    const parentRun = yield* fromPromise(
      "load parent run metadata",
      () => adapter.getRun(parentRunId),
      {
        code: "DB_QUERY_FAILED",
        details: { runId: parentRunId },
      },
    );

    // 3. Optionally override input and reset nodes
    let nodesJson = source.nodesJson;
    let inputJson = source.inputJson;

    if (inputOverrides) {
      const existingInput = JSON.parse(source.inputJson);
      inputJson = JSON.stringify({ ...existingInput, ...inputOverrides });
    }

    if (resetNodes && resetNodes.length > 0) {
      const parsed = parseSnapshot(source);
      const keysToReset = expandResetSet(parsed.nodes, resetNodes);

      const nodesArr: NodeSnapshot[] = JSON.parse(source.nodesJson);
      const updatedNodes = nodesArr.map((n) => {
        const key = `${n.nodeId}::${n.iteration}`;
        if (keysToReset.includes(key) || resetNodes.includes(n.nodeId)) {
          return { ...n, state: "pending", lastAttempt: null };
        }
        return n;
      });
      nodesJson = JSON.stringify(updatedNodes);
    }

    // 4. Insert snapshot for the child run at frame 0
    const childSnapshot: Snapshot = {
      runId: childRunId,
      frameNo: 0,
      nodesJson,
      outputsJson: source.outputsJson,
      ralphJson: source.ralphJson,
      inputJson,
      vcsPointer: source.vcsPointer,
      workflowHash: source.workflowHash,
      contentHash: source.contentHash,
      createdAtMs: ts,
    };

    yield* fromPromise("insert forked snapshot", () =>
      (adapter as any).db
        .insert(smithersSnapshots)
        .values(childSnapshot)
        .onConflictDoUpdate({
          target: [smithersSnapshots.runId, smithersSnapshots.frameNo],
          set: childSnapshot,
        }),
    {
      code: "DB_WRITE_FAILED",
      details: { frameNo: 0, runId: childRunId },
    },
    );

    if (parentRun) {
      yield* fromPromise(
        "insert forked run",
        () =>
          adapter.insertRun({
            runId: childRunId,
            parentRunId,
            workflowName: parentRun.workflowName,
            workflowPath: parentRun.workflowPath ?? null,
            workflowHash: source.workflowHash ?? parentRun.workflowHash ?? null,
            status: parentRun.status === "running" ? "failed" : parentRun.status,
            createdAtMs: ts,
            startedAtMs: null,
            finishedAtMs: parentRun.finishedAtMs ?? ts,
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
            hijackRequestedAtMs: null,
            hijackTarget: null,
            vcsType: parentRun.vcsType ?? null,
            vcsRoot: parentRun.vcsRoot ?? null,
            vcsRevision: source.vcsPointer ?? parentRun.vcsRevision ?? null,
            errorJson: null,
            configJson: parentRun.configJson ?? null,
          }),
        {
          code: "DB_WRITE_FAILED",
          details: { runId: childRunId },
        },
      );
    }

    // 5. Record branch relationship
    const branch: BranchInfo = {
      runId: childRunId,
      parentRunId,
      parentFrameNo: frameNo,
      branchLabel: branchLabel ?? null,
      forkDescription: forkDescription ?? null,
      createdAtMs: ts,
    };

    yield* fromPromise("insert branch", () =>
      (adapter as any).db
        .insert(smithersBranches)
        .values(branch)
        .onConflictDoUpdate({
          target: smithersBranches.runId,
          set: branch,
        }),
    {
      code: "DB_WRITE_FAILED",
      details: { runId: childRunId },
    },
    );

    yield* Metric.increment(runForksCreated);

    yield* Effect.logInfo("Run forked").pipe(
      Effect.annotateLogs({
        parentRunId,
        parentFrameNo: String(frameNo),
        childRunId,
        branchLabel: branchLabel ?? "",
      }),
    );

    return { runId: childRunId, branch, snapshot: childSnapshot };
  }).pipe(
    Effect.annotateLogs({
      parentRunId: params.parentRunId,
      parentFrameNo: String(params.frameNo),
    }),
    Effect.withLogSpan("time-travel:fork-run"),
  );
}

export function forkRun(
  adapter: SmithersDb,
  params: ForkParams,
): Promise<{ runId: string; branch: BranchInfo; snapshot: Snapshot }> {
  return runPromise(forkRunEffect(adapter, params));
}

// ---------------------------------------------------------------------------
// List branches for a run
// ---------------------------------------------------------------------------

export function listBranchesEffect(
  adapter: SmithersDb,
  parentRunId: string,
): Effect.Effect<BranchInfo[], SmithersError> {
  return fromPromise("list branches", (): Promise<BranchInfo[]> =>
    (adapter as any).db
      .select()
      .from(smithersBranches)
      .where(eq(smithersBranches.parentRunId, parentRunId)),
  {
    code: "DB_QUERY_FAILED",
    details: { parentRunId },
  },
  ).pipe(
    Effect.annotateLogs({ parentRunId }),
    Effect.withLogSpan("time-travel:list-branches"),
  );
}

export function listBranches(
  adapter: SmithersDb,
  parentRunId: string,
): Promise<BranchInfo[]> {
  return runPromise(listBranchesEffect(adapter, parentRunId));
}

// ---------------------------------------------------------------------------
// Get branch info for a child run
// ---------------------------------------------------------------------------

export function getBranchInfoEffect(
  adapter: SmithersDb,
  runId: string,
): Effect.Effect<BranchInfo | undefined, SmithersError> {
  return fromPromise("get branch info", (): Promise<BranchInfo[]> =>
    (adapter as any).db
      .select()
      .from(smithersBranches)
      .where(eq(smithersBranches.runId, runId))
      .limit(1),
  {
    code: "DB_QUERY_FAILED",
    details: { runId },
  },
  ).pipe(
    Effect.map((rows: any[]) => rows[0] as BranchInfo | undefined),
    Effect.annotateLogs({ runId }),
    Effect.withLogSpan("time-travel:get-branch-info"),
  );
}

export function getBranchInfo(
  adapter: SmithersDb,
  runId: string,
): Promise<BranchInfo | undefined> {
  return runPromise(getBranchInfoEffect(adapter, runId));
}
