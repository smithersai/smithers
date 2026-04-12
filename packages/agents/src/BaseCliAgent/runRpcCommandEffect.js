import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { Effect } from "effect";
import { SmithersError } from "@smithers/errors/SmithersError";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import { logDebug, logWarning } from "@smithers/observability/logging";
import { toolOutputTruncatedTotal } from "@smithers/observability/metrics";
import { Metric } from "effect";
import { extractTextFromJsonValue } from "./extractTextFromJsonValue.js";
import { truncateToBytes } from "./truncateToBytes.js";
/** @typedef {import("./PiExtensionUiResponse.ts").PiExtensionUiResponse} PiExtensionUiResponse */

/** @typedef {import("./PiExtensionUiRequest.ts").PiExtensionUiRequest} PiExtensionUiRequest */
/**
 * @typedef {{ cwd: string; env: Record<string, string>; prompt: string; timeoutMs?: number; idleTimeoutMs?: number; signal?: AbortSignal; maxOutputBytes?: number; onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void; onJsonEvent?: (event: Record<string, unknown>) => Promise<void> | void; onExtensionUiRequest?: (request: PiExtensionUiRequest) => Promise<PiExtensionUiResponse | null> | PiExtensionUiResponse | null; }} RunRpcCommandOptions
 */

/**
 * @param {number | undefined} timeoutMs
 * @param {() => void} onTimeout
 */
function createOneShotTimer(timeoutMs, onTimeout) {
    if (!timeoutMs || !Number.isFinite(timeoutMs)) {
        return { clear: () => { } };
    }
    const timer = setTimeout(onTimeout, timeoutMs);
    return {
        clear: () => clearTimeout(timer),
    };
}
/**
 * @param {number | undefined} timeoutMs
 * @param {() => void} onTimeout
 */
function createInactivityTimer(timeoutMs, onTimeout) {
    let timer;
    if (!timeoutMs || !Number.isFinite(timeoutMs)) {
        return {
            reset: () => { },
            clear: () => { },
        };
    }
    const reset = () => {
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(onTimeout, timeoutMs);
    };
    const clear = () => {
        if (timer)
            clearTimeout(timer);
        timer = undefined;
    };
    reset();
    return { reset, clear };
}
/**
 * @param {string} command
 * @param {string[]} args
 * @param {RunRpcCommandOptions} options
 * @returns {Effect.Effect<{ text: string; output: unknown; stderr: string; exitCode: number | null; usage?: any; }, SmithersError>}
 */
export function runRpcCommandEffect(command, args, options) {
    const { cwd, env, prompt, timeoutMs, idleTimeoutMs, signal, maxOutputBytes, onStdout, onStderr, onJsonEvent, onExtensionUiRequest, } = options;
    const span = `agent:${command}:rpc`;
    const logAnnotations = {
        agentCommand: command,
        agentArgs: args.join(" "),
        cwd,
        rpc: true,
        timeoutMs: timeoutMs ?? null,
        idleTimeoutMs: idleTimeoutMs ?? null,
    };
    return Effect.async((resume) => {
        let stderr = "";
        let settled = false;
        let exitCode = null;
        let textDeltas = "";
        let streamedAnyText = false;
        let finalMessage = null;
        let promptResponseError = null;
        let extractedUsage = undefined;
        let stderrTruncated = false;
        logDebug("starting agent RPC command", logAnnotations, span);
        const child = spawn(command, args, {
            cwd,
            env,
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
        child.unref();
        const rl = createInterface({ input: child.stdout });
        /**
    * @param {string} message
    * @param {Record<string, unknown>} [details]
    * @param {unknown} [cause]
    */
        const makeAgentCliError = (message, details, cause) => new SmithersError("AGENT_CLI_ERROR", message, {
            agentArgs: args,
            agentCommand: command,
            cwd,
            ...details,
        }, { cause });
        /**
    * @param {SmithersError} err
    */
        const handleError = (err, message = "agent RPC command failed") => {
            if (settled)
                return;
            settled = true;
            if (signal) {
                signal.removeEventListener("abort", onAbort);
            }
            logWarning(message, {
                ...logAnnotations,
                error: err.message,
            }, span);
            try {
                rl.close();
            }
            catch {
                // ignore
            }
            resume(Effect.fail(err));
        };
        /**
    * @param {string} text
    * @param {unknown} output
    */
        const finalize = (text, output) => {
            if (settled)
                return;
            settled = true;
            if (signal) {
                signal.removeEventListener("abort", onAbort);
            }
            logDebug("agent RPC command completed", {
                ...logAnnotations,
                exitCode: child.exitCode ?? exitCode,
                stderrBytes: Buffer.byteLength(stderr, "utf8"),
                textBytes: Buffer.byteLength(text, "utf8"),
            }, span);
            try {
                rl.close();
            }
            catch {
                // ignore
            }
            resume(Effect.succeed({ text, output, stderr, exitCode: child.exitCode, usage: extractedUsage }));
        };
        /**
    * @param {NodeJS.Signals} signal
    */
        const killProcessGroup = (signal) => {
            if (!child.pid)
                return;
            try {
                process.kill(-child.pid, signal);
            }
            catch {
                // process group already exited
            }
        };
        const terminateChild = () => {
            if (!child.pid)
                return;
            killProcessGroup("SIGTERM");
            const killTimer = setTimeout(() => {
                killProcessGroup("SIGKILL");
            }, 250);
            child.once("close", () => clearTimeout(killTimer));
        };
        /**
    * @param {string} reason
    */
        const kill = (reason) => {
            terminateChild();
            handleError(makeAgentCliError(reason), "agent RPC command interrupted");
        };
        const totalTimeout = createOneShotTimer(timeoutMs, () => kill(`CLI timed out after ${timeoutMs}ms`));
        const inactivity = createInactivityTimer(idleTimeoutMs, () => kill(`CLI idle timed out after ${idleTimeoutMs}ms`));
        function onAbort() {
            kill("CLI aborted");
        }
        if (signal?.aborted) {
            onAbort();
        }
        else if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) {
                signal.removeEventListener("abort", onAbort);
                onAbort();
            }
        }
        /**
    * @param {PiExtensionUiRequest} request
    */
        const maybeWriteExtensionResponse = async (request) => {
            const needsResponse = ["select", "confirm", "input", "editor"].includes(request.method);
            if (!needsResponse && !onExtensionUiRequest)
                return;
            let response = onExtensionUiRequest ? await onExtensionUiRequest(request) : null;
            if (!response && needsResponse) {
                response = { type: "extension_ui_response", id: request.id, cancelled: true };
            }
            if (!response)
                return;
            const normalized = { ...response, id: request.id, type: "extension_ui_response" };
            if (!child.stdin) {
                handleError(makeAgentCliError("Failed to send extension UI response: child stdin is not available"));
                terminateChild();
                return;
            }
            child.stdin.write(`${JSON.stringify(normalized)}\n`);
        };
        /**
    * @param {string} line
    */
        const handleLine = async (line) => {
            inactivity.reset();
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                return;
            }
            if (!parsed || typeof parsed !== "object")
                return;
            const event = parsed;
            void Promise.resolve(onJsonEvent?.(event)).catch(() => undefined);
            const type = event.type;
            if (type === "response" && event.command === "prompt" && event.success === false) {
                const errorMessage = typeof event.error === "string" ? event.error : "PI RPC prompt failed";
                promptResponseError = errorMessage;
                kill(errorMessage);
                return;
            }
            if (type === "message_update") {
                const assistantEvent = event.assistantMessageEvent;
                if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
                    textDeltas += assistantEvent.delta;
                    streamedAnyText = true;
                    onStdout?.(assistantEvent.delta);
                }
            }
            if (type === "message_end") {
                const message = event.message;
                if (message?.role === "assistant") {
                    finalMessage = event.message;
                    if (message.stopReason === "error" || message.stopReason === "aborted") {
                        promptResponseError = message.errorMessage || `Request ${message.stopReason}`;
                    }
                }
            }
            if (event.usage) {
                extractedUsage = event.usage;
            }
            if (type === "turn_end") {
                const message = event.message;
                if (message?.role === "assistant") {
                    finalMessage = event.message ?? finalMessage;
                    if (message.usage)
                        extractedUsage = message.usage;
                    if (message.stopReason === "error" || message.stopReason === "aborted") {
                        promptResponseError = message.errorMessage || `Request ${message.stopReason}`;
                    }
                    const extracted = finalMessage ? extractTextFromJsonValue(finalMessage) : undefined;
                    const text = extracted ?? textDeltas;
                    if (!streamedAnyText && text) {
                        onStdout?.(text);
                    }
                    inactivity.clear();
                    totalTimeout.clear();
                    if (promptResponseError) {
                        handleError(makeAgentCliError(promptResponseError));
                        return;
                    }
                    finalize(text, finalMessage ?? text);
                    child.stdin?.end();
                    terminateChild();
                }
            }
            if (type === "extension_ui_request") {
                await maybeWriteExtensionResponse(event);
            }
        };
        let lineQueue = Promise.resolve();
        rl.on("line", (line) => {
            lineQueue = lineQueue.then(() => handleLine(line)).catch((err) => {
                handleError(err instanceof SmithersError
                    ? err
                    : toSmithersError(err, undefined, { code: "AGENT_CLI_ERROR" }));
            });
        });
        child.stdout?.on("data", () => {
            inactivity.reset();
        });
        child.stderr?.on("data", (chunk) => {
            inactivity.reset();
            const text = chunk.toString("utf8");
            const nextStderr = stderr + text;
            if (!stderrTruncated && maxOutputBytes && Buffer.byteLength(nextStderr, "utf8") > maxOutputBytes) {
                stderrTruncated = true;
                void Effect.runPromise(Metric.increment(toolOutputTruncatedTotal));
                logWarning("agent RPC stderr truncated", {
                    ...logAnnotations,
                    maxOutputBytes,
                }, span);
            }
            stderr = truncateToBytes(nextStderr, maxOutputBytes);
            onStderr?.(text);
        });
        child.on("error", (err) => {
            inactivity.clear();
            totalTimeout.clear();
            handleError(toSmithersError(err, undefined, {
                code: "AGENT_CLI_ERROR",
                details: {
                    agentArgs: args,
                    agentCommand: command,
                    cwd,
                },
            }));
        });
        child.on("close", (code) => {
            exitCode = code ?? null;
            inactivity.clear();
            totalTimeout.clear();
            if (settled)
                return;
            if (promptResponseError) {
                handleError(makeAgentCliError(promptResponseError));
                return;
            }
            if (code && code !== 0) {
                handleError(makeAgentCliError(stderr.trim() || `CLI exited with code ${code}`));
                return;
            }
            const text = finalMessage ? extractTextFromJsonValue(finalMessage) ?? textDeltas : textDeltas;
            if (!streamedAnyText && text) {
                onStdout?.(text);
            }
            finalize(text ?? "", finalMessage ?? text ?? "");
        });
        const promptPayload = { id: randomUUID(), type: "prompt", message: prompt };
        if (!child.stdin) {
            handleError(makeAgentCliError("Child process stdin is not available; cannot send prompt payload."));
            return;
        }
        child.stdin.write(`${JSON.stringify(promptPayload)}\n`);
        return Effect.sync(() => {
            try {
                rl.close();
            }
            catch {
                // ignore
            }
            if (signal) {
                signal.removeEventListener("abort", onAbort);
            }
            killProcessGroup("SIGKILL");
        });
    }).pipe(Effect.annotateLogs(logAnnotations), Effect.withLogSpan(span));
}
