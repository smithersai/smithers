import { eq } from "drizzle-orm";
import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import type { SmithersError } from "@smithers/errors/SmithersError";
import { smithersBranches } from "../schema";
import type { BranchInfo } from "../BranchInfo";

export function getBranchInfo(
  adapter: SmithersDb,
  runId: string,
): Effect.Effect<BranchInfo | undefined, SmithersError> {
  return Effect.tryPromise({
    try: (): Promise<BranchInfo[]> =>
      (adapter as any).db
        .select()
        .from(smithersBranches)
        .where(eq(smithersBranches.runId, runId))
        .limit(1),
    catch: (cause) => toSmithersError(cause, "get branch info", {
      code: "DB_QUERY_FAILED",
      details: { runId },
    }),
  }).pipe(
    Effect.map((rows: any[]) => rows[0] as BranchInfo | undefined),
    Effect.annotateLogs({ runId }),
    Effect.withLogSpan("time-travel:get-branch-info"),
  );
}
