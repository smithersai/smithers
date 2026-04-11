import type { RunPatch } from "./RunPatch.ts";

export type UpdateClaimedRunParams = {
  readonly runId: string;
  readonly expectedRuntimeOwnerId: string;
  readonly expectedHeartbeatAtMs: number | null;
  readonly patch: RunPatch;
};
