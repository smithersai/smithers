export type RunAncestryRow = {
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly depth: number;
};
