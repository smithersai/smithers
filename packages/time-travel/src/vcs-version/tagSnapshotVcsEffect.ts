import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import { fromPromise } from "@smithers/runtime/interop";
import { nowMs } from "@smithers/scheduler/nowMs";
import type { SmithersError } from "@smithers/errors/SmithersError";
import { smithersVcsTags } from "../schema";
import {
  getJjPointerEffect,
  runJjEffect,
} from "@smithers/vcs/jj";
import type { VcsTag } from "./VcsTag";

export function tagSnapshotVcsEffect(
  adapter: SmithersDb,
  runId: string,
  frameNo: number,
  opts: { cwd?: string } = {},
): Effect.Effect<VcsTag | null, SmithersError, CommandExecutor> {
  return Effect.gen(function* () {
    const pointer = yield* getJjPointerEffect(opts.cwd);
    if (!pointer) return null;

    // Get current jj operation ID for precise restore
    const opRes = yield* runJjEffect(
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

    yield* fromPromise("insert vcs tag", () =>
      (adapter as any).db
        .insert(smithersVcsTags)
        .values(tag)
        .onConflictDoUpdate({
          target: [smithersVcsTags.runId, smithersVcsTags.frameNo],
          set: tag,
        }),
    {
      code: "DB_WRITE_FAILED",
      details: { frameNo, runId },
    },
    );

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
