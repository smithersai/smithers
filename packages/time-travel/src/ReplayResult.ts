import type { BranchInfo } from "./BranchInfo";
import type { Snapshot } from "./snapshot/Snapshot";

export type ReplayResult = {
  runId: string;
  branch: BranchInfo;
  snapshot: Snapshot;
  vcsRestored: boolean;
  vcsPointer: string | null;
  vcsError?: string;
};
