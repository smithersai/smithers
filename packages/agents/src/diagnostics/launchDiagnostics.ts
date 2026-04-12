import type { DiagnosticReport } from "./DiagnosticReport";
export declare function launchDiagnostics(command: string, env: Record<string, string>, cwd: string): Promise<DiagnosticReport> | null;
