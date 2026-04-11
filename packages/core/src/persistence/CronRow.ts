export type CronRow = {
  readonly cronId: string;
  readonly pattern?: string;
  readonly workflowPath?: string;
  readonly enabled?: boolean;
  readonly lastRunAtMs?: number | null;
  readonly nextRunAtMs?: number | null;
  readonly errorJson?: string | null;
  readonly [key: string]: unknown;
};
