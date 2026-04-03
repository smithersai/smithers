import type { SmithersDb } from "./db/adapter";
import type { SmithersEvent } from "./SmithersEvent";
import { revertToJjPointer } from "./vcs/jj";
import { nowMs } from "./utils/time";

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
    timestampMs: nowMs(),
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
    timestampMs: nowMs(),
  });

  if (!result.success) {
    return { success: false, error: result.error, jjPointer };
  }

  // Clean up DB frames recorded after the reverted attempt started.
  // Find the latest frame created before the attempt's start time and
  // discard everything after it so the DB matches the reverted VCS state.
  const frames = await adapter.listFrames(runId, 1_000_000);
  const cutoff = attemptRow.startedAtMs;
  let lastValidFrameNo = -1;
  for (const f of frames) {
    if (f.createdAtMs <= cutoff && f.frameNo > lastValidFrameNo) {
      lastValidFrameNo = f.frameNo;
    }
  }
  if (lastValidFrameNo >= 0) {
    await adapter.deleteFramesAfter(runId, lastValidFrameNo);
  }

  return { success: true, jjPointer };
}
