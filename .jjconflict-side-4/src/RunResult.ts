export type RunResult = {
  runId: string;
  status: "finished" | "failed" | "cancelled" | "waiting-approval" | "waiting-event";
  output?: unknown;
  error?: unknown;
};
