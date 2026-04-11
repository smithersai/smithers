export type TaskFailure = {
  readonly nodeId: string;
  readonly iteration: number;
  readonly error: unknown;
};
