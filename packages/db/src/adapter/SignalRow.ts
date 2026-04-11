export type SignalRow = {
  runId: string;
  seq: number;
  signalName: string;
  correlationId: string | null;
  payloadJson: string;
  receivedAtMs: number;
  receivedBy: string | null;
};
