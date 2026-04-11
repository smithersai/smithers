export type SignalQuery = {
  signalName?: string;
  correlationId?: string | null;
  receivedAfterMs?: number;
  limit?: number;
};
