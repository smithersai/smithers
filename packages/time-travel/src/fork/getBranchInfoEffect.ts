import { eq } from "drizzle-orm";
import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import { fromPromise } from "@smithers/runtime/interop";
import type { SmithersError } from "@smithers/core/errors";
import { smithersBranches } from "../schema";
import type { BranchInfo } from "../BranchInfo";

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
