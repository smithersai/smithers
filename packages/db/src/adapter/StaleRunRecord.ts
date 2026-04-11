export type StaleRunRecord = {
  runId: string;
  workflowPath: string | null;
  heartbeatAtMs: number | null;
  runtimeOwnerId: string | null;
  status: string;
};
