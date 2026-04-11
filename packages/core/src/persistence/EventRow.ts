export type EventRow = {
  readonly runId: string;
  readonly seq: number;
  readonly timestampMs: number;
  readonly type: string;
  readonly payloadJson: string;
};
