import type { SmithersEvent } from "@smithers-orchestrator/observability/SmithersEvent";

export type TimeTravelOptions = {
  runId: string;
  nodeId: string;
  iteration?: number;
  attempt?: number;
  resetDependents?: boolean;
  restoreVcs?: boolean;
  onProgress?: (event: SmithersEvent) => void;
};
