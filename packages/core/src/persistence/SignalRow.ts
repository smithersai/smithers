export type SignalRow = {
  readonly runId: string;
  readonly seq: number;
  readonly signalName: string;
  readonly correlationId: string | null;
  readonly payloadJson: string;
  readonly receivedAtMs: number;
  readonly receivedBy?: string | null;
};
