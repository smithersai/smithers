export type NodeRow = {
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
  readonly state: string;
  readonly lastAttempt?: number | null;
  readonly updatedAtMs: number;
  readonly outputTable?: string;
  readonly label?: string | null;
};
