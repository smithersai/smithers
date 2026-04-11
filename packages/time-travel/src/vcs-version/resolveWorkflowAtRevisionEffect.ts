import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import { SmithersError } from "@smithers/errors/SmithersError";
import { workspaceAddEffect } from "@smithers/vcs/jj";
import { loadVcsTagEffect } from "./loadVcsTagEffect";

/**
 * Create a jj workspace at the revision recorded for a specific snapshot.
 * Returns the workspace path or null if no VCS tag exists.
 */
export function resolveWorkflowAtRevisionEffect(
  adapter: SmithersDb,
  runId: string,
  frameNo: number,
  workspacePath: string,
): Effect.Effect<
  { workspacePath: string; vcsPointer: string } | null,
  SmithersError,
  CommandExecutor
> {
  return Effect.gen(function* () {
    const tag = yield* loadVcsTagEffect(adapter, runId, frameNo);
    if (!tag) return null;

    const workspaceName = `smithers-replay-${runId.slice(0, 8)}-f${frameNo}`;
    const result = yield* workspaceAddEffect(workspaceName, workspacePath, {
      cwd: tag.vcsRoot ?? undefined,
      atRev: tag.vcsPointer,
    });

    if (!result.success) {
      return yield* Effect.fail(
        new SmithersError(
          "VCS_WORKSPACE_CREATE_FAILED",
          `Failed to create workspace at ${tag.vcsPointer}: ${result.error}`,
          { frameNo, runId, vcsPointer: tag.vcsPointer, workspacePath },
        ),
      );
    }

    return { workspacePath, vcsPointer: tag.vcsPointer };
  }).pipe(
    Effect.annotateLogs({ runId, frameNo: String(frameNo) }),
    Effect.withLogSpan("time-travel:resolve-workflow-at-revision"),
  );
}
