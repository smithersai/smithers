export type EventHistoryQuery = {
  readonly afterSeq?: number;
  readonly limit?: number;
  readonly nodeId?: string;
  readonly types?: readonly string[];
  readonly sinceTimestampMs?: number;
};
