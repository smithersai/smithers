export type RalphRow = {
  readonly runId: string;
  readonly ralphId: string;
  readonly iteration: number;
  readonly done?: boolean;
  readonly stateJson?: string | null;
  readonly updatedAtMs?: number;
};
