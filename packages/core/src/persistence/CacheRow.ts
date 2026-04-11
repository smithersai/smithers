export type CacheRow = {
  readonly cacheKey: string;
  readonly createdAtMs: number;
  readonly workflowName: string;
  readonly nodeId: string;
  readonly outputTable: string;
  readonly schemaSig: string;
  readonly agentSig?: string | null;
  readonly toolsSig?: string | null;
  readonly jjPointer?: string | null;
  readonly payloadJson: string;
};
