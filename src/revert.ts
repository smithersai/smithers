import type { SmithersDb } from "./db/adapter";
import type { SmithersEvent } from "./types";
import { revertToJjPointer } from "./vcs/jj";

export type RevertOptions = {
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  onProgress?: (event: SmithersEvent) => void;
};

export type RevertResult = {
  success: boolean;
  error?: string;
  jjPointer?: string;
};

export async function revertToAttempt(
  adapter: SmithersDb,
  opts: RevertOptions,
): Promise<RevertResult> {
  const { runId, nodeId, iteration, attempt, onProgress } = opts;

  const attemptRow = await adapter.getAttempt(
    runId,
    nodeId,
    iteration,
    attempt,
  );
  if (!attemptRow) {
    return {
      success: false,
      error: `Attempt not found: ${runId}/${nodeId}/${iteration}/${attempt}`,
    };
  }

  const jjPointer = attemptRow.jjPointer;
  if (!jjPointer) {
    return { success: false, error: `Attempt has no jjPointer recorded` };
  }

  onProgress?.({
    type: "RevertStarted",
    runId,
    nodeId,
    iteration,
    attempt,
    jjPointer,
    timestampMs: Date.now(),
  });

  // Revert must target the same repository/worktree where the attempt ran.
  const cwd: string | undefined = attemptRow.jjCwd ?? undefined;
  const result = await revertToJjPointer(jjPointer, cwd);

  onProgress?.({
    type: "RevertFinished",
    runId,
    nodeId,
    iteration,
    attempt,
    jjPointer,
    success: result.success,
    error: result.error,
    timestampMs: Date.now(),
  });

  if (!result.success) {
    return { success: false, error: result.error, jjPointer };
  }

  return { success: true, jjPointer };
}
