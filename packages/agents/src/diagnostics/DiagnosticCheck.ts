import type { DiagnosticCheckId } from "./DiagnosticCheckId";

export type DiagnosticCheckStatus = "pass" | "fail" | "skip" | "error";

export type DiagnosticCheck = {
  id: DiagnosticCheckId;
  status: DiagnosticCheckStatus;
  message: string;
  detail?: Record<string, unknown>;
  durationMs: number;
};
