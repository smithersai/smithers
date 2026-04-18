import { Effect } from "effect";
import { spawnCaptureEffect } from "@smithers-orchestrator/driver/child-process";
/**
 * @typedef {{ cwd: string; env: Record<string, string>; input?: string; timeoutMs?: number; idleTimeoutMs?: number; signal?: AbortSignal; maxOutputBytes?: number; onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void; }} RunCommandOptions
 */
/** @typedef {import("./RunCommandResult.ts").RunCommandResult} RunCommandResult */
/** @typedef {import("@smithers-orchestrator/errors/SmithersError").SmithersError} SmithersError */

/**
 * @param {string} command
 * @param {string[]} args
 * @param {RunCommandOptions} options
 * @returns {Effect.Effect<RunCommandResult, SmithersError>}
 */
export function runCommandEffect(command, args, options) {
    const { cwd, env, input, timeoutMs, idleTimeoutMs, signal, maxOutputBytes, onStdout, onStderr, } = options;
    return spawnCaptureEffect(command, args, {
        cwd,
        env,
        input,
        signal,
        timeoutMs,
        idleTimeoutMs,
        maxOutputBytes,
        onStdout,
        onStderr,
    }).pipe(Effect.annotateLogs({
        agentCommand: command,
        agentArgs: args.join(" "),
        cwd,
    }), Effect.withLogSpan(`agent:${command}`));
}
