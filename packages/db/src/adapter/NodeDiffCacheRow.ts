export type NodeDiffCacheRow = {
  runId: string;
  nodeId: string;
  iteration: number;
  baseRef: string;
  diffJson: string;
  computedAtMs: number;
  sizeBytes: number;
};
