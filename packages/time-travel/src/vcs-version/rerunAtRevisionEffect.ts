import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import type { SmithersError } from "@smithers/core/errors";
import { revertToJjPointerEffect } from "@smithers/vcs/jj";
import { loadVcsTagEffect } from "./loadVcsTagEffect";

export function rerunAtRevisionEffect(
  adapter: SmithersDb,
  runId: string,
  frameNo: number,
  opts: { cwd?: string } = {},
): Effect.Effect<
  { restored: boolean; vcsPointer: string | null; error?: string },
  SmithersError,
  CommandExecutor
> {
  return Effect.gen(function* () {
    const tag = yield* loadVcsTagEffect(adapter, runId, frameNo);
    if (!tag) {
      return { restored: false, vcsPointer: null };
    }

    const result = yield* revertToJjPointerEffect(
      tag.vcsPointer,
      opts.cwd ?? tag.vcsRoot ?? undefined,
    );

    if (!result.success) {
      return { restored: false, vcsPointer: tag.vcsPointer, error: result.error };
    }

    return { restored: true, vcsPointer: tag.vcsPointer };
  }).pipe(
    Effect.annotateLogs({ runId, frameNo: String(frameNo) }),
    Effect.withLogSpan("time-travel:rerun-at-revision"),
  );
}
