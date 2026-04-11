import type { SmithersAlertPolicy } from "./SmithersAlertPolicy";

export type SmithersWorkflowOptions = {
  alertPolicy?: SmithersAlertPolicy;
  cache?: boolean;
  workflowHash?: string;
};
