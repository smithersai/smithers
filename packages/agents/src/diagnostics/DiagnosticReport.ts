import type { DiagnosticCheck } from "./DiagnosticCheck";

export type DiagnosticReport = {
  agentId: string;
  command: string;
  timestamp: string;
  checks: DiagnosticCheck[];
  durationMs: number;
};
