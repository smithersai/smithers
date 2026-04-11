export type WorkflowRuntime = {
  runPromise<A>(effect: unknown): Promise<A>;
};
