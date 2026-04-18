import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
/** @typedef {import("./DiagnosticCheckId.ts").DiagnosticCheckId} DiagnosticCheckId */

/**
 * @typedef {{ agentId: string; command: string; checks: DiagnosticCheckDef[]; }} AgentDiagnosticStrategy
 */
/** @typedef {import("./DiagnosticCheck.ts").DiagnosticCheck} DiagnosticCheck */
/**
 * @typedef {{ id: DiagnosticCheckId; run: (ctx: DiagnosticContext) => Promise<DiagnosticCheck>; }} DiagnosticCheckDef
 */
/** @typedef {import("./DiagnosticContext.ts").DiagnosticContext} DiagnosticContext */
/** @typedef {import("./DiagnosticReport.ts").DiagnosticReport} DiagnosticReport */

const PER_CHECK_TIMEOUT_MS = 5_000;
/**
 * @param {DiagnosticCheckDef} check
 * @param {DiagnosticContext} ctx
 * @returns {Promise<DiagnosticCheck>}
 */
async function runCheck(check, ctx) {
    const start = performance.now();
    try {
        return await Promise.race([
            check.run(ctx),
            new Promise((_, reject) => setTimeout(() => reject(new SmithersError("AGENT_DIAGNOSTIC_TIMEOUT", "diagnostic check timed out", { timeoutMs: PER_CHECK_TIMEOUT_MS })), PER_CHECK_TIMEOUT_MS)),
        ]);
    }
    catch (err) {
        return {
            id: check.id,
            status: "error",
            message: err instanceof Error ? err.message : String(err),
            durationMs: performance.now() - start,
        };
    }
}
/**
 * @param {AgentDiagnosticStrategy} strategy
 * @param {DiagnosticContext} ctx
 * @returns {Promise<DiagnosticReport>}
 */
export async function runDiagnostics(strategy, ctx) {
    const start = performance.now();
    const results = await Promise.all(strategy.checks.map((check) => runCheck(check, ctx)));
    return {
        agentId: strategy.agentId,
        command: strategy.command,
        timestamp: new Date().toISOString(),
        checks: results,
        durationMs: performance.now() - start,
    };
}
