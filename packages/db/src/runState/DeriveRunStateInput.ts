import type { RunRow } from "../adapter/RunRow.ts";

export type DeriveRunStateInput = {
  run: RunRow;
  pendingApproval?: { nodeId: string; requestedAtMs: number } | null;
  pendingTimer?: { nodeId: string; firesAtMs: number } | null;
  pendingEvent?: { nodeId: string; correlationKey: string } | null;
  now?: number;
  staleThresholdMs?: number;
};
