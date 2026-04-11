import type { DiagnosticReport } from "./DiagnosticReport";
import { getDiagnosticStrategy } from "./getDiagnosticStrategy";
import { runDiagnostics } from "./runDiagnostics";

export function launchDiagnostics(
  command: string,
  env: Record<string, string>,
  cwd: string,
): Promise<DiagnosticReport> | null {
  const strategy = getDiagnosticStrategy(command);
  if (!strategy) return null;
  return runDiagnostics(strategy, { env, cwd }).catch(() => null as any);
}
