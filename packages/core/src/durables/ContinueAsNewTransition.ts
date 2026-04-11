export type ContinueAsNewTransition = {
  readonly reason: "explicit" | "loop-threshold" | "driver";
  readonly iteration?: number;
  readonly statePayload?: unknown;
  readonly stateJson?: string;
  readonly newRunId?: string;
  readonly carriedStateBytes?: number;
  readonly ancestryDepth?: number;
};
