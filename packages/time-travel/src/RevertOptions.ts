import type { SmithersEvent } from "@smithers/observability/SmithersEvent";

export type RevertOptions = {
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  onProgress?: (event: SmithersEvent) => void;
};
