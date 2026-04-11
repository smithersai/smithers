import { eq } from "drizzle-orm";
import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import { fromPromise } from "@smithers/runtime/interop";
import type { SmithersError } from "@smithers/core/errors";
import { smithersBranches } from "../schema";
import type { BranchInfo } from "../BranchInfo";

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
