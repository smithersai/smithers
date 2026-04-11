import type { RunStatus } from "./RunStatus.ts";

export type RunResult = {
  readonly runId: string;
  readonly status: RunStatus;
  readonly output?: unknown;
  readonly error?: unknown;
  readonly nextRunId?: string;
};
