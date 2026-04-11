import type { TokenUsage } from "./TokenUsage.ts";

export type TaskOutput = {
  readonly nodeId: string;
  readonly iteration: number;
  readonly output: unknown;
  readonly text?: string | null;
  readonly usage?: TokenUsage | null;
};
