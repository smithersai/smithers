import { and, desc, eq } from "drizzle-orm";
import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import { fromPromise } from "@smithers/runtime/interop";
import { runPromise } from "@smithers/runtime/runtime";
import type { SmithersError } from "@smithers/errors/SmithersError";
import { smithersSnapshots } from "../schema";
import type { Snapshot } from "./Snapshot";

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
