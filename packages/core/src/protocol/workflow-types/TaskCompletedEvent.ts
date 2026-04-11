export type TaskCompletedEvent = {
  nodeId: string;
  iteration: number;
  output: unknown;
};
