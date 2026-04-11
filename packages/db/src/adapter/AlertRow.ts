import type { AlertSeverity } from "./AlertSeverity";
import type { AlertStatus } from "./AlertStatus";

export type AlertRow = {
  alertId: string;
  runId: string | null;
  policyName: string;
  severity: AlertSeverity;
  status: AlertStatus;
  firedAtMs: number;
  resolvedAtMs: number | null;
  acknowledgedAtMs: number | null;
  message: string;
  detailsJson: string | null;
};
