import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import { nowMs } from "@smithers/scheduler/nowMs";
import type { SmithersError } from "@smithers/errors/SmithersError";
import { smithersVcsTags } from "../schema";
import {
  getJjPointer,
  runJj,
} from "@smithers/vcs/jj";
import type { VcsTag } from "./VcsTag";

export function tagSnapshotVcs(
  adapter: SmithersDb,
  runId: string,
  frameNo: number,
  opts: { cwd?: string } = {},
): Effect.Effect<VcsTag | null, SmithersError, CommandExecutor> {
  return Effect.gen(function* () {
    const pointer = yield* getJjPointer(opts.cwd);
    if (!pointer) return null;

    // Get current jj operation ID for precise restore
    const opRes = yield* runJj(
      ["operation", "log", "--no-graph", "--limit", "1", "-T", "self.id()"],
      { cwd: opts.cwd },
    );
    const jjOperationId = opRes.code === 0 ? opRes.stdout.trim() || null : null;

    const ts = nowMs();
    const tag: VcsTag = {
      runId,
      frameNo,
      vcsType: "jj",
      vcsPointer: pointer,
      vcsRoot: opts.cwd ?? null,
      jjOperationId,
      createdAtMs: ts,
    };

    yield* Effect.tryPromise({
      try: () =>
        (adapter as any).db
          .insert(smithersVcsTags)
          .values(tag)
          .onConflictDoUpdate({
            target: [smithersVcsTags.runId, smithersVcsTags.frameNo],
            set: tag,
          }),
      catch: (cause) => toSmithersError(cause, "insert vcs tag", {
        code: "DB_WRITE_FAILED",
        details: { frameNo, runId },
      }),
    });

    yield* Effect.logDebug("VCS tag recorded").pipe(
      Effect.annotateLogs({
        runId,
        frameNo: String(frameNo),
        vcsPointer: pointer,
      }),
    );

    return tag;
  }).pipe(
    Effect.annotateLogs({ runId, frameNo: String(frameNo) }),
    Effect.withLogSpan("time-travel:tag-snapshot-vcs"),
  );
}
