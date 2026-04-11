export type CacheRow = {
  cacheKey: string;
  createdAtMs: number;
  workflowName: string;
  nodeId: string;
  outputTable: string;
  schemaSig: string;
  agentSig: string | null;
  toolsSig: string | null;
  jjPointer: string | null;
  payloadJson: string;
};
