import type { DiagnosticReport } from "./DiagnosticReport";

export function formatDiagnosticSummary(report: DiagnosticReport): string {
  const failed = report.checks.filter((c) => c.status === "fail");
  const errors = report.checks.filter((c) => c.status === "error");
  if (failed.length === 0 && errors.length === 0) {
    return `[diagnostics] ${report.agentId}: all checks passed (${Math.round(report.durationMs)}ms)`;
  }
  const issues = [...failed, ...errors]
    .map((c) => `${c.id}=${c.status}: ${c.message}`)
    .join("; ");
  return `[diagnostics] ${report.agentId}: ${issues} (${Math.round(report.durationMs)}ms)`;
}
