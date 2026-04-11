export type NodeRow = {
  runId: string;
  nodeId: string;
  iteration: number;
  state: string;
  lastAttempt: number | null;
  updatedAtMs: number;
  outputTable: string;
  label: string | null;
};
