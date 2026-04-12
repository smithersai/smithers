import { eq, and } from "drizzle-orm";
import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import type { SmithersError } from "@smithers/errors/SmithersError";
import { smithersVcsTags } from "../schema";
import type { VcsTag } from "./VcsTag";

export function loadVcsTag(
  adapter: SmithersDb,
  runId: string,
  frameNo: number,
): Effect.Effect<VcsTag | undefined, SmithersError> {
  return Effect.tryPromise({
    try: (): Promise<VcsTag[]> =>
      (adapter as any).db
        .select()
        .from(smithersVcsTags)
        .where(
          and(
            eq(smithersVcsTags.runId, runId),
            eq(smithersVcsTags.frameNo, frameNo),
          ),
        )
        .limit(1),
    catch: (cause) => toSmithersError(cause, "load vcs tag", {
      code: "DB_QUERY_FAILED",
      details: { frameNo, runId },
    }),
  }).pipe(
    Effect.map((rows: any[]) => rows[0] as VcsTag | undefined),
    Effect.annotateLogs({ runId, frameNo: String(frameNo) }),
    Effect.withLogSpan("time-travel:load-vcs-tag"),
  );
}
