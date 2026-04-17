export type JumpResult = {
  ok: true;
  newFrameNo: number;
  revertedSandboxes: number;
  deletedFrames: number;
  deletedAttempts: number;
  invalidatedDiffs: number;
  durationMs: number;
};
