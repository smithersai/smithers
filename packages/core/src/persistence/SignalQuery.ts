export type SignalQuery = {
  readonly signalName?: string;
  readonly correlationId?: string | null;
  readonly receivedAfterMs?: number;
  readonly limit?: number;
};
