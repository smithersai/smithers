import { eq } from "drizzle-orm";
import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import type { SmithersError } from "@smithers/errors/SmithersError";
import { smithersBranches } from "../schema";
import type { BranchInfo } from "../BranchInfo";

export function listBranches(
  adapter: SmithersDb,
  parentRunId: string,
): Effect.Effect<BranchInfo[], SmithersError> {
  return Effect.tryPromise({
    try: (): Promise<BranchInfo[]> =>
      (adapter as any).db
        .select()
        .from(smithersBranches)
        .where(eq(smithersBranches.parentRunId, parentRunId)),
    catch: (cause) => toSmithersError(cause, "list branches", {
      code: "DB_QUERY_FAILED",
      details: { parentRunId },
    }),
  }).pipe(
    Effect.annotateLogs({ parentRunId }),
    Effect.withLogSpan("time-travel:list-branches"),
  );
}
