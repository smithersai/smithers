import { Effect, Metric } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import { fromPromise } from "@smithers/runtime/interop";
import { runPromise } from "@smithers/runtime/runtime";
import { sha256Hex } from "@smithers/driver/sha256Hex";
import { nowMs } from "@smithers/scheduler/nowMs";
import type { SmithersError } from "@smithers/errors/SmithersError";
import { smithersSnapshots } from "../schema";
import { snapshotsCaptured } from "../snapshotsCaptured";
import { snapshotDuration } from "../snapshotDuration";
import type { Snapshot } from "./Snapshot";
import type { SnapshotData } from "./SnapshotData";

function serializeSnapshotContent(data: SnapshotData): string {
  return JSON.stringify({
    nodes: data.nodes,
    outputs: data.outputs,
    ralph: data.ralph,
    input: data.input,
  });
}

export function captureSnapshotEffect(
  adapter: SmithersDb,
  runId: string,
  frameNo: number,
  data: SnapshotData,
): Effect.Effect<Snapshot, SmithersError> {
  return Effect.gen(function* () {
    const start = performance.now();

    const nodesJson = JSON.stringify(data.nodes);
    const outputsJson = JSON.stringify(data.outputs);
    const ralphJson = JSON.stringify(data.ralph);
    const inputJson = JSON.stringify(data.input);
    const contentHash = sha256Hex(serializeSnapshotContent(data));
    const ts = nowMs();

    const row = {
      runId,
      frameNo,
      nodesJson,
      outputsJson,
      ralphJson,
      inputJson,
      vcsPointer: data.vcsPointer ?? null,
      workflowHash: data.workflowHash ?? null,
      contentHash,
      createdAtMs: ts,
    };

    yield* fromPromise("insert snapshot", () =>
      (adapter as any).db
        .insert(smithersSnapshots)
        .values(row)
        .onConflictDoUpdate({
          target: [smithersSnapshots.runId, smithersSnapshots.frameNo],
          set: row,
        }),
    {
      code: "DB_WRITE_FAILED",
      details: { frameNo, runId },
    },
    );

    yield* Metric.increment(snapshotsCaptured);
    yield* Metric.update(snapshotDuration, performance.now() - start);

    return row as Snapshot;
  }).pipe(
    Effect.annotateLogs({ runId, frameNo: String(frameNo) }),
    Effect.withLogSpan("time-travel:capture-snapshot"),
  );
}

export function captureSnapshot(
  adapter: SmithersDb,
  runId: string,
  frameNo: number,
  data: SnapshotData,
): Promise<Snapshot> {
  return runPromise(captureSnapshotEffect(adapter, runId, frameNo, data));
}
