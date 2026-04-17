import type { SmithersEvent } from "@smithers/observability/SmithersEvent";

export type TimeTravelOptions = {
  runId: string;
  nodeId: string;
  iteration?: number;
  attempt?: number;
  resetDependents?: boolean;
  restoreVcs?: boolean;
  onProgress?: (event: SmithersEvent) => void;
};
