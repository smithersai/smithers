import { getDiagnosticStrategy } from "./getDiagnosticStrategy.js";
import { runDiagnostics } from "./runDiagnostics.js";
/** @typedef {import("./DiagnosticReport.ts").DiagnosticReport} DiagnosticReport */

/**
 * @param {string} command
 * @param {Record<string, string>} env
 * @param {string} cwd
 * @returns {Promise<DiagnosticReport> | null}
 */
export function launchDiagnostics(command, env, cwd) {
    const strategy = getDiagnosticStrategy(command);
    if (!strategy)
        return null;
    return runDiagnostics(strategy, { env, cwd }).catch(() => null);
}
