export type WorkflowSessionOptions = {
  readonly runId?: string;
  readonly nowMs?: () => number;
  readonly requireStableFinish?: boolean;
  readonly requireRerenderOnOutputChange?: boolean;
  readonly initialRalphState?: ReadonlyMap<string, {
    readonly iteration: number;
    readonly done: boolean;
  }>;
};
