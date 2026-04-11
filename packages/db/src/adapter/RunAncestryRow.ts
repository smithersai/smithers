export type RunAncestryRow = {
  runId: string;
  parentRunId: string | null;
  depth: number;
};
