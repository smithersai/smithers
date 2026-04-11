export type ToolCallRow = {
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
  readonly [key: string]: unknown;
};
