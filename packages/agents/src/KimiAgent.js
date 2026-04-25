import { mkdtempSync, cpSync, existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { BaseCliAgent, pushFlag, pushList, isRecord, asString, toolKindFromName, createSyntheticIdGenerator, } from "./BaseCliAgent/index.js";
import { normalizeCapabilityStringList, } from "./capability-registry/index.js";
/** @typedef {import("./BaseCliAgent/BaseCliAgentOptions.ts").BaseCliAgentOptions} BaseCliAgentOptions */
/** @typedef {import("./capability-registry/AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./BaseCliAgent/CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/** @typedef {import("./KimiAgentOptions.ts").KimiAgentOptions} KimiAgentOptions */

function resolveKimiBuiltIns() {
    return ["default"];
}
/**
 * @param {KimiAgentOptions} [opts]
 * @returns {AgentCapabilityRegistry}
 */
export function createKimiCapabilityRegistry(opts = {}) {
    return {
        version: 1,
        engine: "kimi",
        runtimeTools: {},
        mcp: {
            bootstrap: "project-config",
            supportsProjectScope: true,
            supportsUserScope: true,
        },
        skills: {
            supportsSkills: true,
            installMode: "dir",
            smithersSkillIds: normalizeCapabilityStringList(opts.skillsDir ? [`dir:${opts.skillsDir}`] : []),
        },
        humanInteraction: {
            supportsUiRequests: false,
            methods: [],
        },
        builtIns: resolveKimiBuiltIns(),
    };
}
export class KimiAgent extends BaseCliAgent {
    opts;
    capabilities;
    cliEngine = "kimi";
    issuedSessionId;
    /**
   * @param {KimiAgentOptions} [opts]
   */
    constructor(opts = {}) {
        super(opts);
        this.opts = opts;
        this.capabilities = createKimiCapabilityRegistry(opts);
    }
    /**
   * @returns {CliOutputInterpreter}
   */
    createOutputInterpreter() {
        let emittedStarted = false;
        let didEmitCompleted = false;
        let finalAnswer = "";
        const nextSyntheticId = createSyntheticIdGenerator();
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
                payload = JSON.parse(trimmed);
            }
            catch {
                return [];
            }
            if (!isRecord(payload))
                return [];
            const role = asString(payload.role);
            const events = [];
            if (!emittedStarted) {
                emittedStarted = true;
                events.push({
                    type: "started",
                    engine: this.cliEngine,
                    title: "Kimi",
                    resume: this.issuedSessionId,
                });
            }
            if (role === "assistant") {
                const content = asString(payload.content);
                if (content) {
                    finalAnswer = content;
                }
                const toolCalls = Array.isArray(payload.tool_calls) ? payload.tool_calls : [];
                for (const toolCall of toolCalls) {
                    if (!isRecord(toolCall))
                        continue;
                    const fn = isRecord(toolCall.function) ? toolCall.function : undefined;
                    const name = asString(fn?.name) ?? "tool";
                    const id = asString(toolCall.id) ?? nextSyntheticId("kimi-tool");
                    events.push({
                        type: "action",
                        engine: this.cliEngine,
                        phase: "started",
                        entryType: "thought",
                        action: {
                            id,
                            kind: toolKindFromName(name),
                            title: name,
                            detail: {
                                arguments: asString(fn?.arguments),
                            },
                        },
                        message: `Running ${name}`,
                        level: "info",
                    });
                }
            }
            if (role === "tool") {
                const id = asString(payload.tool_call_id) ?? nextSyntheticId("kimi-tool");
                events.push({
                    type: "action",
                    engine: this.cliEngine,
                    phase: "completed",
                    entryType: "thought",
                    action: {
                        id,
                        kind: "tool",
                        title: "tool result",
                        detail: {},
                    },
                    message: asString(payload.content),
                    ok: true,
                    level: "info",
                });
            }
            return events;
        };
        return {
            onStdoutLine: parseLine,
            onExit: (result) => {
                if (didEmitCompleted)
                    return [];
                didEmitCompleted = true;
                return [{
                        type: "completed",
                        engine: this.cliEngine,
                        ok: !result.exitCode || result.exitCode === 0,
                        answer: finalAnswer || undefined,
                        error: result.exitCode && result.exitCode !== 0
                            ? result.stderr.trim() || `Kimi exited with code ${result.exitCode}`
                            : undefined,
                        resume: this.issuedSessionId,
                    }];
            },
        };
    }
    /**
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
   */
    async buildCommand(params) {
        const args = [];
        let commandEnv;
        let cleanup;
        // Isolate kimi metadata per invocation to avoid concurrent writes to
        // ~/.kimi/kimi.json across parallel tasks. If caller explicitly provides
        // KIMI_SHARE_DIR in opts.env, preserve that override.
        if (!this.opts.env?.KIMI_SHARE_DIR) {
            const defaultShareDir = process.env.KIMI_SHARE_DIR ?? join(homedir(), ".kimi");
            const isolatedShareDir = mkdtempSync(join(tmpdir(), "kimi-share-"));
            if (existsSync(defaultShareDir)) {
                for (const name of ["config.toml", "credentials", "device_id", "latest_version.txt"]) {
                    const src = join(defaultShareDir, name);
                    if (existsSync(src)) {
                        try {
                            cpSync(src, join(isolatedShareDir, name), { recursive: true });
                        }
                        catch {
                            // Best-effort seed only; missing copy should not prevent execution.
                        }
                    }
                }
            }
            commandEnv = { KIMI_SHARE_DIR: isolatedShareDir };
            cleanup = async () => {
                rmSync(isolatedShareDir, { recursive: true, force: true });
            };
        }
        // Print mode is required for non-interactive execution
        // Note: --print implicitly adds --yolo
        args.push("--print");
        // Output format — use text with --final-message-only to get only the
        // model's final response without tool call outputs mixed in.
        const outputFormat = this.opts.outputFormat ??
            (params.options?.onEvent ? "stream-json" : "text");
        pushFlag(args, "--output-format", outputFormat);
        // When using text format, --final-message-only ensures we only get
        // the model's final response, not intermediate tool output.
        const finalMessageOnly = this.opts.finalMessageOnly ?? (outputFormat === "text");
        if (finalMessageOnly)
            args.push("--final-message-only");
        // Other flags
        const resumeSession = typeof params.options?.resumeSession === "string"
            ? params.options.resumeSession
            : undefined;
        const sessionId = resumeSession ?? this.opts.session ?? randomUUID();
        this.issuedSessionId = sessionId;
        pushFlag(args, "--work-dir", this.opts.workDir ?? params.cwd);
        pushFlag(args, "--session", sessionId);
        if (this.opts.continue)
            args.push("--continue");
        pushFlag(args, "--model", this.opts.model ?? this.model);
        const thinking = this.opts.thinking ?? true;
        args.push(thinking ? "--thinking" : "--no-thinking");
        if (this.opts.quiet)
            args.push("--quiet");
        pushFlag(args, "--agent", this.opts.agent);
        pushFlag(args, "--agent-file", this.opts.agentFile);
        pushList(args, "--mcp-config-file", this.opts.mcpConfigFile);
        pushList(args, "--mcp-config", this.opts.mcpConfig);
        pushFlag(args, "--skills-dir", this.opts.skillsDir);
        pushFlag(args, "--max-steps-per-turn", this.opts.maxStepsPerTurn);
        pushFlag(args, "--max-retries-per-step", this.opts.maxRetriesPerStep);
        pushFlag(args, "--max-ralph-iterations", this.opts.maxRalphIterations);
        if (this.opts.verbose)
            args.push("--verbose");
        if (this.opts.debug)
            args.push("--debug");
        if (this.extraArgs?.length)
            args.push(...this.extraArgs);
        // Build prompt with system prompt prepended
        const systemPrefix = params.systemPrompt
            ? `${params.systemPrompt}\n\n`
            : "";
        const jsonReminder = params.prompt?.includes("REQUIRED OUTPUT")
            ? "\n\nREMINDER: Your response MUST end with a ```json code fence containing the required JSON object. Do NOT skip this step — the pipeline will reject your response without it.\n"
            : "";
        const fullPrompt = `${systemPrefix}${params.prompt ?? ""}${jsonReminder}`;
        // Pass prompt via --prompt flag
        pushFlag(args, "--prompt", fullPrompt);
        return {
            command: "kimi",
            args,
            outputFormat,
            env: commandEnv,
            cleanup,
            stdoutBannerPatterns: [/^YOLO mode is enabled\b[^\n]*/gm],
            stdoutErrorPatterns: [
                /^LLM not set/i,
                /^LLM not supported/i,
                /^Max steps reached/i,
                /^Interrupted by user$/i,
                /^Unknown error:/i,
                /^Error:/i,
            ],
            // The kimi CLI emits "To resume this session: kimi -r <id>" to stderr
            // on every non-zero exit (it's a hint for interactive users, not the
            // actual error). Strip it so the real underlying error surfaces — and
            // when it's the only stderr content, our runner will fall back to a
            // useful "exited with code N" message that the engine can retry.
            benignStderrPatterns: [
                /^\s*To resume this session: kimi -r [0-9a-f-]+\s*$/gim,
            ],
            errorOnBannerOnly: true,
        };
    }
}
