// @smithers-type-exports-begin
/** @typedef {import("./SmithersIdeAskUserResult.ts").SmithersIdeAskUserResult} SmithersIdeAskUserResult */
/** @typedef {import("./SmithersIdeAvailability.ts").SmithersIdeAvailability} SmithersIdeAvailability */
/** @typedef {import("./SmithersIdeCommandBaseResult.ts").SmithersIdeCommandBaseResult} SmithersIdeCommandBaseResult */
/** @typedef {import("./SmithersIdeOpenDiffResult.ts").SmithersIdeOpenDiffResult} SmithersIdeOpenDiffResult */
/** @typedef {import("./SmithersIdeOpenFileResult.ts").SmithersIdeOpenFileResult} SmithersIdeOpenFileResult */
/** @typedef {import("./SmithersIdeOpenWebviewResult.ts").SmithersIdeOpenWebviewResult} SmithersIdeOpenWebviewResult */
/** @typedef {import("./SmithersIdeOverlayResult.ts").SmithersIdeOverlayResult} SmithersIdeOverlayResult */
/** @typedef {import("./SmithersIdeRunTerminalResult.ts").SmithersIdeRunTerminalResult} SmithersIdeRunTerminalResult */
// @smithers-type-exports-end

import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { spawnCaptureEffect } from "@smithers/driver/child-process";
import { SmithersError } from "@smithers/errors/SmithersError";
/** @typedef {import("./SmithersIdeOverlayOptions.ts").SmithersIdeOverlayOptions} SmithersIdeOverlayOptions */
/** @typedef {import("./SmithersIdeOverlayType.ts").SmithersIdeOverlayType} SmithersIdeOverlayType */
/** @typedef {import("./SmithersIdeResolvedConfig.ts").SmithersIdeResolvedConfig} SmithersIdeResolvedConfig */
/** @typedef {import("./SmithersIdeServiceApi.ts").SmithersIdeServiceApi} SmithersIdeServiceApi */
/** @typedef {import("./SmithersIdeServiceConfig.ts").SmithersIdeServiceConfig} SmithersIdeServiceConfig */

const DEFAULT_COMMAND = "smithers-ctl";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 200_000;
export class SmithersIdeService extends Context.Tag("SmithersIdeService")() {
}
/**
 * @param {SmithersIdeServiceConfig} [config]
 * @returns {SmithersIdeResolvedConfig}
 */
function resolveConfig(config = {}) {
    return {
        command: config.command ?? DEFAULT_COMMAND,
        cwd: config.cwd ?? process.cwd(),
        env: config.env ?? process.env,
        idleTimeoutMs: config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
        maxOutputBytes: config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
}
/**
 * @param {string | undefined} value
 */
function isTruthyEnv(value) {
    if (!value)
        return false;
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
}
/**
 * @param {Record<string, string | undefined>} env
 */
function detectSmithersIdeEnvironment(env) {
    const signals = [];
    if (isTruthyEnv(env.SMITHERS_IDE)) {
        signals.push("SMITHERS_IDE");
    }
    if (isTruthyEnv(env.SMITHERS_CTL_ACTIVE)) {
        signals.push("SMITHERS_CTL_ACTIVE");
    }
    if ((env.SMITHERS_SESSION_KIND ?? "").trim().toLowerCase() === "ide") {
        signals.push("SMITHERS_SESSION_KIND");
    }
    if ((env.TERM_PROGRAM ?? "").trim().toLowerCase() === "smithers") {
        signals.push("TERM_PROGRAM");
    }
    if ((env.__CFBundleIdentifier ?? "").trim().toLowerCase().includes("smithers")) {
        signals.push("__CFBundleIdentifier");
    }
    return {
        active: signals.length > 0,
        signals: signals,
    };
}
/**
 * @param {string} command
 * @param {Record<string, string | undefined>} env
 */
function resolveBinaryOnPath(command, env) {
    if (!command.trim())
        return null;
    /**
   * @param {string} candidate
   */
    const checkCandidate = (candidate) => {
        try {
            accessSync(candidate, constants.X_OK);
            return candidate;
        }
        catch {
            return null;
        }
    };
    if (command.includes("/") || isAbsolute(command)) {
        return checkCandidate(command);
    }
    const pathValue = env.PATH ?? process.env.PATH ?? "";
    for (const entry of pathValue.split(delimiter)) {
        if (!entry)
            continue;
        const resolved = checkCandidate(join(entry, command));
        if (resolved)
            return resolved;
    }
    return null;
}
/**
 * @param {string} stdout
 */
function parseJsonObject(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed)
        return null;
    try {
        const parsed = JSON.parse(trimmed);
        return parsed && typeof parsed === "object" ? parsed : null;
    }
    catch {
        return null;
    }
}
/**
 * @param {string} stdout
 * @param {readonly string[]} keys
 */
function parseIdentifier(stdout, keys) {
    const parsed = parseJsonObject(stdout);
    if (parsed) {
        for (const key of keys) {
            const value = parsed[key];
            if (typeof value === "string" && value.trim()) {
                return value.trim();
            }
        }
    }
    const line = stdout
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .find(Boolean);
    return line ?? null;
}
/**
 * @param {string} stdout
 * @param {string} fallback
 */
function parseStatus(stdout, fallback) {
    const parsed = parseJsonObject(stdout);
    const candidates = [
        parsed?.status,
        parsed?.result,
        parsed?.exitStatus,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim()) {
            return candidate.trim();
        }
    }
    return fallback;
}
/**
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 */
function invalidInput(message, details) {
    return new SmithersError("INVALID_INPUT", message, details);
}
/**
 * @param {SmithersError} error
 * @param {SmithersIdeResolvedConfig} config
 * @param {readonly string[]} args
 */
function mapSpawnError(error, config, args) {
    if (error.code === "PROCESS_SPAWN_FAILED" &&
        (error.cause?.code === "ENOENT" ||
            error.message.includes("ENOENT"))) {
        return new SmithersError("PROCESS_SPAWN_FAILED", `smithers-ctl is not installed or not on PATH (${config.command})`, {
            args: [...args],
            command: config.command,
            cwd: config.cwd,
        }, { cause: error });
    }
    return error;
}
/**
 * @param {SmithersIdeResolvedConfig} config
 * @param {readonly string[]} args
 * @param {string} stdout
 * @param {string} stderr
 * @param {number | null} exitCode
 */
function commandFailedError(config, args, stdout, stderr, exitCode) {
    return new SmithersError("TOOL_COMMAND_FAILED", `${config.command} ${args.join(" ")} failed with exit code ${exitCode ?? "unknown"}`, {
        args: [...args],
        command: config.command,
        cwd: config.cwd,
        exitCode,
        stderr,
        stdout,
    });
}
/**
 * @param {SmithersIdeResolvedConfig} config
 * @param {string} toolName
 * @param {readonly string[]} args
 */
function runCtlCommand(config, toolName, args) {
    return spawnCaptureEffect(config.command, [...args], {
        cwd: config.cwd,
        env: config.env,
        idleTimeoutMs: config.idleTimeoutMs,
        maxOutputBytes: config.maxOutputBytes,
        timeoutMs: config.timeoutMs,
    }).pipe(Effect.mapError((error) => mapSpawnError(error, config, args)), Effect.flatMap((result) => result.exitCode === 0
        ? Effect.succeed(result)
        : Effect.fail(commandFailedError(config, args, result.stdout, result.stderr, result.exitCode))), Effect.annotateLogs({
        command: config.command,
        cwd: config.cwd,
        toolName,
    }), Effect.withLogSpan("ide:tool-call"));
}
/**
 * @param {SmithersIdeServiceConfig} [config]
 */
export function detectSmithersIdeAvailabilityEffect(config = {}) {
    const resolved = resolveConfig(config);
    return Effect.sync(() => {
        const binaryPath = resolveBinaryOnPath(resolved.command, resolved.env);
        const environment = detectSmithersIdeEnvironment(resolved.env);
        if (!binaryPath) {
            return {
                available: false,
                binaryAvailable: false,
                binaryPath: null,
                environmentActive: environment.active,
                reason: "binary-missing",
                signals: environment.signals,
            };
        }
        if (!environment.active) {
            return {
                available: false,
                binaryAvailable: true,
                binaryPath,
                environmentActive: false,
                reason: "environment-inactive",
                signals: environment.signals,
            };
        }
        return {
            available: true,
            binaryAvailable: true,
            binaryPath,
            environmentActive: true,
            reason: "available",
            signals: environment.signals,
        };
    }).pipe(Effect.annotateLogs({ command: resolved.command }), Effect.withLogSpan("ide:capability-detect"));
}
/**
 * @param {SmithersIdeServiceConfig} [config]
 * @returns {SmithersIdeServiceApi}
 */
export function createSmithersIdeService(config = {}) {
    const resolved = resolveConfig(config);
    return {
        config: resolved,
        detectAvailability: () => detectSmithersIdeAvailabilityEffect(resolved),
        openFile: (path, line, column) => {
            if (!path.trim()) {
                return Effect.fail(invalidInput("openFile requires a non-empty path"));
            }
            if (column !== undefined && line === undefined) {
                return Effect.fail(invalidInput("openFile requires line when column is provided", {
                    column,
                    path,
                }));
            }
            const args = ["open", path];
            if (line !== undefined) {
                args.push(`+${line}${column !== undefined ? `:${column}` : ""}`);
            }
            return runCtlCommand(resolved, "smithers_ide_open_file", args).pipe(Effect.map((result) => ({
                args: [...args],
                column: column ?? null,
                command: resolved.command,
                exitCode: result.exitCode,
                line: line ?? null,
                opened: true,
                path,
                stderr: result.stderr,
                stdout: result.stdout,
            })));
        },
        openDiff: (content) => {
            if (!content.trim()) {
                return Effect.fail(invalidInput("openDiff requires non-empty diff content"));
            }
            const args = ["diff", "show", "--content", content];
            return runCtlCommand(resolved, "smithers_ide_open_diff", args).pipe(Effect.map((result) => ({
                args: [...args],
                command: resolved.command,
                exitCode: result.exitCode,
                opened: true,
                stderr: result.stderr,
                stdout: result.stdout,
            })));
        },
        showOverlay: (type, options) => {
            if (!options.message.trim()) {
                return Effect.fail(invalidInput("showOverlay requires a message"));
            }
            const args = ["overlay", "--type", type, "--message", options.message];
            if (options.title) {
                args.push("--title", options.title);
            }
            if (options.position) {
                args.push("--position", options.position);
            }
            if (options.duration !== undefined) {
                args.push("--duration", String(options.duration));
            }
            if (options.percent !== undefined) {
                args.push("--percent", String(options.percent));
            }
            return runCtlCommand(resolved, "smithers_ide_show_overlay", args).pipe(Effect.map((result) => ({
                args: [...args],
                command: resolved.command,
                exitCode: result.exitCode,
                overlayId: parseIdentifier(result.stdout, ["overlayId", "id"]),
                shown: true,
                stderr: result.stderr,
                stdout: result.stdout,
                type,
            })));
        },
        runTerminal: (command, cwd) => {
            if (!command.trim()) {
                return Effect.fail(invalidInput("runTerminal requires a non-empty command"));
            }
            const args = ["terminal"];
            if (cwd) {
                args.push("--cwd", cwd);
            }
            args.push("run", command);
            return runCtlCommand(resolved, "smithers_ide_run_terminal", args).pipe(Effect.map((result) => ({
                args: [...args],
                command: resolved.command,
                cwd: cwd ?? null,
                exitCode: result.exitCode,
                launched: true,
                status: parseStatus(result.stdout, "launched"),
                stderr: result.stderr,
                stdout: result.stdout,
                terminalCommand: command,
            })));
        },
        askUser: (prompt) => Effect.flatMap(createSmithersIdeService(resolved).showOverlay("chat", { message: prompt }), (result) => Effect.succeed({
            args: result.args,
            command: result.command,
            exitCode: result.exitCode,
            overlayId: result.overlayId,
            prompt,
            status: "prompted",
            stderr: result.stderr,
            stdout: result.stdout,
        })),
        openWebview: (url) => {
            if (!url.trim()) {
                return Effect.fail(invalidInput("openWebview requires a non-empty url"));
            }
            const args = ["webview", "open", url];
            return runCtlCommand(resolved, "smithers_ide_open_webview", args).pipe(Effect.map((result) => ({
                args: [...args],
                command: resolved.command,
                exitCode: result.exitCode,
                opened: true,
                stderr: result.stderr,
                stdout: result.stdout,
                tabId: parseIdentifier(result.stdout, ["tabId", "id"]),
                url,
            })));
        },
    };
}
/**
 * @param {SmithersIdeServiceConfig} [config]
 */
export function createSmithersIdeLayer(config = {}) {
    return Layer.succeed(SmithersIdeService, createSmithersIdeService(config));
}
/**
 * @param {string} path
 * @param {number} [line]
 * @param {number} [column]
 */
export function openFile(path, line, column) {
    return Effect.flatMap(SmithersIdeService, (service) => service.openFile(path, line, column));
}
/**
 * @param {string} content
 */
export function openDiff(content) {
    return Effect.flatMap(SmithersIdeService, (service) => service.openDiff(content));
}
/**
 * @param {SmithersIdeOverlayType} type
 * @param {SmithersIdeOverlayOptions} options
 */
export function showOverlay(type, options) {
    return Effect.flatMap(SmithersIdeService, (service) => service.showOverlay(type, options));
}
/**
 * @param {string} command
 * @param {string} [cwd]
 */
export function runTerminal(command, cwd) {
    return Effect.flatMap(SmithersIdeService, (service) => service.runTerminal(command, cwd));
}
/**
 * @param {string} prompt
 */
export function askUser(prompt) {
    return Effect.flatMap(SmithersIdeService, (service) => service.askUser(prompt));
}
/**
 * @param {string} url
 */
export function openWebview(url) {
    return Effect.flatMap(SmithersIdeService, (service) => service.openWebview(url));
}
