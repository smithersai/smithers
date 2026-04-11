import type { HumanRequestRow } from "./HumanRequestRow.ts";

export type PendingHumanRequestRow = HumanRequestRow & {
  readonly workflowName?: string | null;
  readonly runStatus?: string | null;
  readonly nodeLabel?: string | null;
};
