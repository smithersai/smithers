import { SmithersError } from "@smithers/core/errors";
import type { DiagnosticCheckId } from "./DiagnosticCheckId";
import type { DiagnosticCheck } from "./DiagnosticCheck";
import type { DiagnosticReport } from "./DiagnosticReport";
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

const PER_CHECK_TIMEOUT_MS = 5_000;

async function runCheck(
  check: DiagnosticCheckDef,
  ctx: DiagnosticContext,
): Promise<DiagnosticCheck> {
  const start = performance.now();
  try {
    return await Promise.race([
      check.run(ctx),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new SmithersError(
                "AGENT_DIAGNOSTIC_TIMEOUT",
                "diagnostic check timed out",
                { timeoutMs: PER_CHECK_TIMEOUT_MS },
              ),
            ),
          PER_CHECK_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    return {
      id: check.id,
      status: "error",
      message: err instanceof Error ? err.message : String(err),
      durationMs: performance.now() - start,
    };
  }
}

export async function runDiagnostics(
  strategy: AgentDiagnosticStrategy,
  ctx: DiagnosticContext,
): Promise<DiagnosticReport> {
  const start = performance.now();
  const results = await Promise.all(
    strategy.checks.map((check) => runCheck(check, ctx)),
  );
  return {
    agentId: strategy.agentId,
    command: strategy.command,
    timestamp: new Date().toISOString(),
    checks: results,
    durationMs: performance.now() - start,
  };
}
