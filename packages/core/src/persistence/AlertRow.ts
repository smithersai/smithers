import type { AlertSeverity } from "./AlertSeverity.ts";
import type { AlertStatus } from "./AlertStatus.ts";

export type AlertRow = {
  readonly alertId: string;
  readonly runId?: string | null;
  readonly policyName: string;
  readonly severity: AlertSeverity;
  readonly status: AlertStatus;
  readonly firedAtMs: number;
  readonly resolvedAtMs?: number | null;
  readonly acknowledgedAtMs?: number | null;
  readonly message: string;
  readonly detailsJson?: string | null;
};
