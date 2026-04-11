export type RalphMeta = {
  readonly id: string;
  readonly until: boolean;
  readonly maxIterations: number;
  readonly onMaxReached: "fail" | "return-last";
  readonly continueAsNewEvery?: number;
};
