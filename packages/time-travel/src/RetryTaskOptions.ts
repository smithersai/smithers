import type { SmithersEvent } from "@smithers-orchestrator/observability/SmithersEvent";

export type RetryTaskOptions = {
  runId: string;
  nodeId: string;
  iteration?: number;
  resetDependents?: boolean;
  force?: boolean;
  onProgress?: (event: SmithersEvent) => void;
};
