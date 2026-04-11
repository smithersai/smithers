import type { HumanRequestRow } from "./HumanRequestRow";

export type PendingHumanRequestRow = HumanRequestRow & {
  workflowName: string | null;
  runStatus: string | null;
  nodeLabel: string | null;
};
