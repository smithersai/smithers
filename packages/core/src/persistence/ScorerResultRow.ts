export type ScorerResultRow = {
  readonly runId: string;
  readonly nodeId?: string;
  readonly scorerId?: string;
  readonly scoredAtMs?: number;
  readonly [key: string]: unknown;
};
