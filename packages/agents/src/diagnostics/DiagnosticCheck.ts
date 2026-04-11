import type { DiagnosticCheckId } from "./DiagnosticCheckId";
import type { DiagnosticCheckStatus } from "./DiagnosticCheckStatus";

export type DiagnosticCheck = {
  id: DiagnosticCheckId;
  status: DiagnosticCheckStatus;
  message: string;
  detail?: Record<string, unknown>;
  durationMs: number;
};
