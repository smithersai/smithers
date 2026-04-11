export type TaskFailedEvent = {
  nodeId: string;
  iteration: number;
  error: unknown;
};
