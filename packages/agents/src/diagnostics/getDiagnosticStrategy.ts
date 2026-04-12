import type { DiagnosticCheckId } from "./DiagnosticCheckId";
import type { DiagnosticCheck } from "./DiagnosticCheck";
import type { DiagnosticContext } from "./DiagnosticContext";
type DiagnosticCheckDef = {
    id: DiagnosticCheckId;
    run: (ctx: DiagnosticContext) => Promise<DiagnosticCheck>;
};
type AgentDiagnosticStrategy = {
    agentId: string;
    command: string;
    checks: DiagnosticCheckDef[];
};
export declare function getDiagnosticStrategy(command: string): AgentDiagnosticStrategy | null;
export {};
