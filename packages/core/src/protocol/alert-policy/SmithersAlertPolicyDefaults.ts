import type { SmithersAlertSeverity } from "./SmithersAlertSeverity";
import type { SmithersAlertLabels } from "./SmithersAlertLabels";

export type SmithersAlertPolicyDefaults = {
  owner?: string;
  severity?: SmithersAlertSeverity;
  runbook?: string;
  labels?: SmithersAlertLabels;
};
