// @smithers-type-exports-begin
/** @typedef {import("./PiAgent.ts").PiExtensionUiRequest} PiExtensionUiRequest */
/** @typedef {import("./PiAgent.ts").PiExtensionUiResponse} PiExtensionUiResponse */
// @smithers-type-exports-end

import { Effect } from "effect";
import { BaseCliAgent, buildGenerateResult, combineNonEmpty, extractPrompt, extractTextFromJsonValue, pushFlag, resolveTimeouts, runAgentPromise, runRpcCommandEffect, tryParseJson, asString, truncate, toolKindFromName, } from "./BaseCliAgent/index.js";
import { normalizeCapabilityStringList, } from "./capability-registry/index.js";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import { SmithersError } from "@smithers/errors/SmithersError";
import { enrichReportWithErrorAnalysis, launchDiagnostics } from "./diagnostics/index.js";
/** @typedef {import("./capability-registry/index.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./BaseCliAgent/index.ts").CliOutputInterpreter} CliOutputInterpreter */
/** @typedef {import("ai").GenerateTextResult} GenerateTextResult */
/** @typedef {import("./PiAgent.ts").PiAgentOptions} PiAgentOptions */

/**
 * @param {PiAgentOptions} opts
 */
function resolvePiBuiltIns(opts) {
    if (opts.noTools) {
        return [];
    }
    return opts.tools?.length
        ? normalizeCapabilityStringList(opts.tools)
        : ["default"];
}
/**
 * @param {PiAgentOptions} [opts]
 * @returns {AgentCapabilityRegistry}
 */
export function createPiCapabilityRegistry(opts = {}) {
    return {
        version: 1,
        engine: "pi",
        runtimeTools: {},
        mcp: {
            bootstrap: "unsupported",
            supportsProjectScope: false,
            supportsUserScope: false,
        },
        skills: {
            supportsSkills: true,
            installMode: "files",
            smithersSkillIds: normalizeCapabilityStringList(opts.skill),
        },
        humanInteraction: {
            supportsUiRequests: true,
            methods: ["extension_ui_request"],
        },
        builtIns: resolvePiBuiltIns(opts),
    };
}
export class PiAgent extends BaseCliAgent {
    opts;
    capabilities;
    cliEngine = "pi";
    issuedSessionRef;
    /**
   * @param {PiAgentOptions} [opts]
   */
    constructor(opts = {}) {
        super(opts);
        this.opts = opts;
        this.capabilities = createPiCapabilityRegistry(opts);
    }
    /**
   * @param {any} options
   * @returns {PiMode}
   */
    resolveMode(options) {
        if (this.opts.mode === "rpc")
            return "rpc";
        if (options?.onEvent)
            return "json";
        return this.opts.mode ?? "text";
    }
    /**
   * @param {{ prompt: string; cwd: string; options: any; mode: PiMode; }} params
   * @returns {string[]}
   */
    buildArgs(params) {
        const args = [];
        const { systemFromMessages } = extractPrompt(params.options);
        const resumeSession = typeof params.options?.resumeSession === "string"
            ? params.options.resumeSession
            : undefined;
        const effectiveSession = resumeSession ?? this.opts.session;
        this.issuedSessionRef = effectiveSession;
        if (params.mode === "text") {
            if (this.opts.print !== false)
                args.push("--print");
        }
        else {
            args.push("--mode", params.mode);
        }
        pushFlag(args, "--provider", this.opts.provider);
        pushFlag(args, "--model", this.opts.model ?? this.model);
        pushFlag(args, "--api-key", this.opts.apiKey);
        pushFlag(args, "--system-prompt", this.systemPrompt);
        pushFlag(args, "--append-system-prompt", combineNonEmpty([this.opts.appendSystemPrompt, systemFromMessages]));
        if (this.opts.continue)
            args.push("--continue");
        if (this.opts.resume)
            args.push("--resume");
        pushFlag(args, "--session", effectiveSession);
        pushFlag(args, "--session-dir", this.opts.sessionDir);
        const needsDurableSession = Boolean(params.options?.onEvent || effectiveSession);
        const hasSessionFlags = needsDurableSession ||
            Boolean(this.opts.sessionDir || this.opts.continue || this.opts.resume);
        if (!needsDurableSession && (this.opts.noSession ?? (!hasSessionFlags))) {
            args.push("--no-session");
        }
        if (this.opts.models) {
            const models = Array.isArray(this.opts.models)
                ? this.opts.models.join(",")
                : this.opts.models;
            args.push("--models", models);
        }
        if (this.opts.listModels !== undefined && this.opts.listModels !== false) {
            if (typeof this.opts.listModels === "string") {
                args.push("--list-models", this.opts.listModels);
            }
            else {
                args.push("--list-models");
            }
        }
        pushFlag(args, "--export", this.opts.export);
        if (this.opts.tools?.length) {
            args.push("--tools", this.opts.tools.join(","));
        }
        if (this.opts.noTools)
            args.push("--no-tools");
        if (this.opts.extension) {
            for (const value of this.opts.extension) {
                args.push("--extension", value);
            }
        }
        if (this.opts.noExtensions)
            args.push("--no-extensions");
        if (this.opts.skill) {
            for (const value of this.opts.skill) {
                args.push("--skill", value);
            }
        }
        if (this.opts.noSkills)
            args.push("--no-skills");
        if (this.opts.promptTemplate) {
            for (const value of this.opts.promptTemplate) {
                args.push("--prompt-template", value);
            }
        }
        if (this.opts.noPromptTemplates)
            args.push("--no-prompt-templates");
        if (this.opts.theme) {
            for (const value of this.opts.theme) {
                args.push("--theme", value);
            }
        }
        if (this.opts.noThemes)
            args.push("--no-themes");
        pushFlag(args, "--thinking", this.opts.thinking);
        if (this.opts.verbose)
            args.push("--verbose");
        if (this.extraArgs?.length)
            args.push(...this.extraArgs);
        if (params.mode !== "rpc" && this.opts.files) {
            for (const value of this.opts.files) {
                args.push(`@${value}`);
            }
        }
        if (params.prompt) {
            args.push(params.prompt);
        }
        return args;
    }
    /**
   * @returns {CliOutputInterpreter}
   */
    createOutputInterpreter() {
        let sessionId = this.issuedSessionRef;
        let emittedStarted = false;
        let finalAnswer = "";
        /**
     * @param {unknown} value
     */
        const summarizeValue = (value) => {
            if (value == null)
                return undefined;
            const text = extractTextFromJsonValue(value);
            if (text)
                return truncate(text, 400);
            try {
                return truncate(JSON.stringify(value), 400);
            }
            catch {
                return truncate(String(value), 400);
            }
        };
        /**
     * @param {Record<string, unknown>} [detail]
     * @returns {AgentCliEvent[]}
     */
        const startedEvents = (detail) => {
            if (emittedStarted || !sessionId)
                return [];
            emittedStarted = true;
            return [{
                    type: "started",
                    engine: this.cliEngine,
                    title: "PI",
                    resume: sessionId,
                    detail,
                }];
        };
        /**
     * @param {string} line
     * @returns {AgentCliEvent[]}
     */
        const parseLine = (line) => {
            const trimmed = line.trim();
            if (!trimmed)
                return [];
            let payload;
            try {
                const parsed = JSON.parse(trimmed);
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                    return [];
                }
                payload = parsed;
            }
            catch {
                return [];
            }
            const type = asString(payload.type);
            if (!type)
                return [];
            if (type === "session") {
                sessionId = asString(payload.id) ?? sessionId;
                return startedEvents({
                    cwd: asString(payload.cwd),
                    version: payload.version,
                });
            }
            if (type === "message_update") {
                const assistantEvent = payload.assistantMessageEvent;
                if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
                    finalAnswer += assistantEvent.delta;
                }
                return startedEvents();
            }
            if (type === "message_end" || type === "turn_end") {
                const message = payload.message;
                if (message?.role === "assistant") {
                    const extracted = extractTextFromJsonValue(message);
                    if (extracted) {
                        finalAnswer = extracted;
                    }
                }
                return startedEvents();
            }
            if (type === "tool_execution_start") {
                const toolName = asString(payload.toolName) ?? "tool";
                const toolId = asString(payload.toolCallId) ?? toolName;
                return [
                    ...startedEvents(),
                    {
                        type: "action",
                        engine: this.cliEngine,
                        phase: "started",
                        entryType: "thought",
                        action: {
                            id: toolId,
                            kind: toolKindFromName(toolName),
                            title: toolName,
                            detail: {
                                args: payload.args,
                            },
                        },
                        message: `Running ${toolName}`,
                        level: "info",
                    },
                ];
            }
            if (type === "tool_execution_update") {
                const toolName = asString(payload.toolName) ?? "tool";
                const toolId = asString(payload.toolCallId) ?? toolName;
                return [
                    ...startedEvents(),
                    {
                        type: "action",
                        engine: this.cliEngine,
                        phase: "updated",
                        entryType: "thought",
                        action: {
                            id: toolId,
                            kind: toolKindFromName(toolName),
                            title: toolName,
                            detail: {
                                args: payload.args,
                            },
                        },
                        message: summarizeValue(payload.partialResult),
                        level: "info",
                    },
                ];
            }
            if (type === "tool_execution_end") {
                const toolName = asString(payload.toolName) ?? "tool";
                const toolId = asString(payload.toolCallId) ?? toolName;
                const ok = payload.isError !== true;
                return [
                    ...startedEvents(),
                    {
                        type: "action",
                        engine: this.cliEngine,
                        phase: "completed",
                        entryType: "thought",
                        action: {
                            id: toolId,
                            kind: toolKindFromName(toolName),
                            title: toolName,
                            detail: {
                                result: summarizeValue(payload.result),
                            },
                        },
                        message: summarizeValue(payload.result),
                        ok,
                        level: ok ? "info" : "warning",
                    },
                ];
            }
            return startedEvents();
        };
        return {
            onStdoutLine: parseLine,
            onExit: (result) => {
                const started = !emittedStarted && sessionId
                    ? startedEvents()
                    : [];
                return [
                    ...started,
                    {
                        type: "completed",
                        engine: this.cliEngine,
                        ok: !result.exitCode || result.exitCode === 0,
                        answer: finalAnswer || undefined,
                        error: result.exitCode && result.exitCode !== 0
                            ? result.stderr.trim() || `PI exited with code ${result.exitCode}`
                            : undefined,
                        resume: sessionId,
                    },
                ];
            },
        };
    }
    /**
   * @param {any} options
   * @returns {Promise<GenerateTextResult<any, any>>}
   */
    async generate(options) {
        const mode = this.resolveMode(options);
        // Non-RPC modes delegate to BaseCliAgent.generate() which handles
        // metrics, diagnostics, and the full process lifecycle.
        if (mode !== "rpc") {
            return super.generate(options);
        }
        // RPC mode requires a custom transport (stdin/stdout JSON-RPC).
        if (this.opts.files?.length) {
            throw new SmithersError("AGENT_RPC_FILE_ARGS", "RPC mode does not support file arguments");
        }
        const { prompt } = extractPrompt(options);
        const callTimeouts = resolveTimeouts(options?.timeout, {
            totalMs: this.timeoutMs,
            idleMs: this.idleTimeoutMs,
        });
        const cwd = this.cwd ?? options?.rootDir ?? process.cwd();
        const env = { ...process.env, ...this.env };
        const args = this.buildArgs({ prompt, cwd, options, mode });
        const diagnosticsPromise = launchDiagnostics("pi", env, cwd);
        const interpreter = this.createOutputInterpreter();
        /**
     * @param {AgentCliEvent[] | AgentCliEvent | null | undefined} payload
     */
        const emitEvents = (payload) => {
            if (!payload || !options?.onEvent)
                return;
            const events = Array.isArray(payload) ? payload : [payload];
            for (const event of events) {
                void Promise.resolve(options.onEvent(event)).catch(() => undefined);
            }
        };
        /**
     * @param {unknown} err
     */
        const diagnosticsEnrichment = (err) => Effect.tryPromise({
            try: async () => {
                if (!diagnosticsPromise)
                    return;
                const report = await diagnosticsPromise.catch(() => null);
                if (report && err instanceof SmithersError) {
                    enrichReportWithErrorAnalysis(report, err.message);
                    err.details = { ...err.details, diagnostics: report };
                }
            },
            catch: (cause) => toSmithersError(cause, "enrich diagnostics"),
        }).pipe(Effect.ignore);
        const rpcProgram = Effect.gen(this, function* () {
            const rpcResult = yield* runRpcCommandEffect("pi", args, {
                cwd,
                env,
                prompt,
                timeoutMs: callTimeouts.totalMs,
                idleTimeoutMs: callTimeouts.idleMs,
                signal: options?.abortSignal,
                maxOutputBytes: this.maxOutputBytes ?? options?.maxOutputBytes,
                onStdout: options?.onStdout,
                onStderr: options?.onStderr,
                onJsonEvent: (event) => emitEvents(interpreter.onStdoutLine?.(JSON.stringify(event))),
                onExtensionUiRequest: this.opts.onExtensionUiRequest,
            });
            emitEvents(interpreter.onExit?.({
                stdout: rpcResult.text,
                stderr: rpcResult.stderr,
                exitCode: rpcResult.exitCode,
            }));
            return buildGenerateResult(rpcResult.text, rpcResult.output, this.opts.model ?? "pi", rpcResult.usage);
        }).pipe(Effect.tapError(diagnosticsEnrichment));
        return runAgentPromise(rpcProgram);
    }
    /**
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
   * @returns {Promise<{ command: string; args: string[]; stdin?: string; outputFormat?: string; outputFile?: string; cleanup?: () => Promise<void>; }>}
   */
    async buildCommand(params) {
        const mode = this.resolveMode(params.options);
        if (mode === "rpc") {
            throw new SmithersError("AGENT_BUILD_COMMAND", "Pi RPC mode uses the custom RPC transport");
        }
        return {
            command: "pi",
            args: this.buildArgs({
                prompt: params.prompt,
                cwd: params.cwd,
                options: params.options,
                mode,
            }),
            outputFormat: mode,
        };
    }
}
