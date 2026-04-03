import { and, desc, eq, sql } from "drizzle-orm";
import { Effect, Metric } from "effect";
import type { SmithersDb } from "../db/adapter";
import { fromPromise } from "../effect/interop";
import { runPromise } from "../effect/runtime";
import { sha256Hex } from "../utils/hash";
import { nowMs } from "../utils/time";
import type { SmithersError } from "../utils/errors";
import { smithersSnapshots } from "./schema";
import { snapshotsCaptured, snapshotDuration } from "./metrics";
import type { Snapshot, ParsedSnapshot, NodeSnapshot, RalphSnapshot } from "./types";

// ---------------------------------------------------------------------------
// Snapshot data to capture
// ---------------------------------------------------------------------------

export type SnapshotData = {
  nodes: Array<{
    nodeId: string;
    iteration: number;
    state: string;
    lastAttempt: number | null;
    outputTable: string;
    label: string | null;
  }>;
  outputs: Record<string, unknown>;
  ralph: Array<{
    ralphId: string;
    iteration: number;
    done: boolean;
  }>;
  input: Record<string, unknown>;
  vcsPointer?: string | null;
  workflowHash?: string | null;
};

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

export function loadSnapshotEffect(
  adapter: SmithersDb,
  runId: string,
  frameNo: number,
): Effect.Effect<Snapshot | undefined, SmithersError> {
  return fromPromise("load snapshot", (): Promise<Snapshot[]> =>
    (adapter as any).db
      .select()
      .from(smithersSnapshots)
      .where(
        and(
          eq(smithersSnapshots.runId, runId),
          eq(smithersSnapshots.frameNo, frameNo),
        ),
      )
      .limit(1),
  {
    code: "DB_QUERY_FAILED",
    details: { frameNo, runId },
  },
  ).pipe(
    Effect.map((rows: any[]) => rows[0] as Snapshot | undefined),
    Effect.annotateLogs({ runId, frameNo: String(frameNo) }),
    Effect.withLogSpan("time-travel:load-snapshot"),
  );
}

export function loadSnapshot(
  adapter: SmithersDb,
  runId: string,
  frameNo: number,
): Promise<Snapshot | undefined> {
  return runPromise(loadSnapshotEffect(adapter, runId, frameNo));
}

export function loadLatestSnapshotEffect(
  adapter: SmithersDb,
  runId: string,
): Effect.Effect<Snapshot | undefined, SmithersError> {
  return fromPromise("load latest snapshot", (): Promise<Snapshot[]> =>
    (adapter as any).db
      .select()
      .from(smithersSnapshots)
      .where(eq(smithersSnapshots.runId, runId))
      .orderBy(desc(smithersSnapshots.frameNo))
      .limit(1),
  {
    code: "DB_QUERY_FAILED",
    details: { runId },
  },
  ).pipe(
    Effect.map((rows: any[]) => rows[0] as Snapshot | undefined),
    Effect.annotateLogs({ runId }),
    Effect.withLogSpan("time-travel:load-latest-snapshot"),
  );
}

export function loadLatestSnapshot(
  adapter: SmithersDb,
  runId: string,
): Promise<Snapshot | undefined> {
  return runPromise(loadLatestSnapshotEffect(adapter, runId));
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function listSnapshotsEffect(
  adapter: SmithersDb,
  runId: string,
): Effect.Effect<Array<Pick<Snapshot, "runId" | "frameNo" | "contentHash" | "createdAtMs" | "vcsPointer">>, SmithersError> {
  return fromPromise(
    "list snapshots",
    (): Promise<Array<Pick<Snapshot, "runId" | "frameNo" | "contentHash" | "createdAtMs" | "vcsPointer">>> =>
    (adapter as any).db
      .select({
        runId: smithersSnapshots.runId,
        frameNo: smithersSnapshots.frameNo,
        contentHash: smithersSnapshots.contentHash,
        createdAtMs: smithersSnapshots.createdAtMs,
        vcsPointer: smithersSnapshots.vcsPointer,
      })
      .from(smithersSnapshots)
      .where(eq(smithersSnapshots.runId, runId))
      .orderBy(smithersSnapshots.frameNo),
    {
      code: "DB_QUERY_FAILED",
      details: { runId },
    },
  ).pipe(
    Effect.annotateLogs({ runId }),
    Effect.withLogSpan("time-travel:list-snapshots"),
  );
}

export function listSnapshots(
  adapter: SmithersDb,
  runId: string,
): Promise<Array<Pick<Snapshot, "runId" | "frameNo" | "contentHash" | "createdAtMs" | "vcsPointer">>> {
  return runPromise(listSnapshotsEffect(adapter, runId));
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export function parseSnapshot(snapshot: Snapshot): ParsedSnapshot {
  const nodesArr: NodeSnapshot[] = JSON.parse(snapshot.nodesJson);
  const nodes: Record<string, NodeSnapshot> = {};
  for (const n of nodesArr) {
    nodes[`${n.nodeId}::${n.iteration}`] = n;
  }

  const ralphArr: RalphSnapshot[] = JSON.parse(snapshot.ralphJson);
  const ralph: Record<string, RalphSnapshot> = {};
  for (const r of ralphArr) {
    ralph[r.ralphId] = r;
  }

  return {
    runId: snapshot.runId,
    frameNo: snapshot.frameNo,
    nodes,
    outputs: JSON.parse(snapshot.outputsJson),
    ralph,
    input: JSON.parse(snapshot.inputJson),
    vcsPointer: snapshot.vcsPointer,
    workflowHash: snapshot.workflowHash,
    contentHash: snapshot.contentHash,
    createdAtMs: snapshot.createdAtMs,
  };
}
