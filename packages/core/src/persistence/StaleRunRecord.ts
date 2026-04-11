import type { Run } from "./Run.ts";

export type StaleRunRecord = Pick<
  Run,
  "runId" | "workflowPath" | "heartbeatAtMs" | "runtimeOwnerId" | "status"
>;
