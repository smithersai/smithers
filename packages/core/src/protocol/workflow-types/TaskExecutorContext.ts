import type { RunOptions } from "../RunOptions";

export type TaskExecutorContext = {
  runId: string;
  options: RunOptions;
  signal?: AbortSignal;
};
