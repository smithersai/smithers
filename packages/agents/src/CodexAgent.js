import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BaseCliAgent, normalizeCodexConfig, pushFlag, pushList, isRecord, asString, asNumber, truncate, shouldSurfaceUnparsedStdout, createSyntheticIdGenerator, } from "./BaseCliAgent/index.js";
import { normalizeCapabilityStringList, } from "./capability-registry/index.js";
import { sanitizeForOpenAI } from "./sanitizeForOpenAI.js";
/** @typedef {import("./BaseCliAgent/BaseCliAgentOptions.ts").BaseCliAgentOptions} BaseCliAgentOptions */
/** @typedef {import("./BaseCliAgent/CodexConfigOverrides.ts").CodexConfigOverrides} CodexConfigOverrides */
/** @typedef {import("./capability-registry/AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./BaseCliAgent/CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/** @typedef {import("./CodexAgentOptions.ts").CodexAgentOptions} CodexAgentOptions */

/**
 * @param {CodexAgentOptions} opts
 */
function resolveCodexBuiltIns(opts) {
    if (opts.enable?.length || opts.disable?.length) {
        return normalizeCapabilityStringList([
            ...(opts.enable ?? []).map((feature) => `enable:${feature}`),
            ...(opts.disable ?? []).map((feature) => `disable:${feature}`),
        ]);
    }
    return ["default"];
}
/**
 * @param {CodexAgentOptions} [opts]
 * @returns {AgentCapabilityRegistry}
 */
export function createCodexCapabilityRegistry(opts = {}) {
    return {
        version: 1,
        engine: "codex",
        runtimeTools: {},
        mcp: {
            bootstrap: "inline-config",
            supportsProjectScope: true,
            supportsUserScope: false,
        },
        skills: {
            supportsSkills: false,
            smithersSkillIds: [],
        },
        humanInteraction: {
            supportsUiRequests: false,
            methods: [],
        },
        builtIns: resolveCodexBuiltIns(opts),
    };
}
export class CodexAgent extends BaseCliAgent {
    opts;
    capabilities;
    cliEngine = "codex";
    /**
   * @param {CodexAgentOptions} [opts]
   */
    constructor(opts = {}) {
        super(opts);
        this.opts = opts;
        this.capabilities = createCodexCapabilityRegistry(opts);
    }
    /**
   * @returns {CliOutputInterpreter}
   */
    createOutputInterpreter() {
        let turnIndex = 0;
        let threadId;
        let finalAnswer = "";
        let didEmitCompleted = false;
        const nextSyntheticId = createSyntheticIdGenerator();
        /**
     * @param {Record<string, unknown>} item
     * @param {"started" | "updated" | "completed"} phase
     * @returns {AgentCliEvent | null}
     */
        const actionForItem = (item, phase) => {
            const itemId = asString(item.id) ?? nextSyntheticId("item");
            const itemType = asString(item.type) ?? "note";
            if (itemType === "agent_message") {
                if (phase === "completed") {
                    const text = asString(item.text)?.trim();
                    if (text) {
                        finalAnswer = text;
                        return {
                            type: "action",
                            engine: this.cliEngine,
                            phase: "completed",
                            entryType: "message",
                            action: {
                                id: itemId,
                                kind: "note",
                                title: "assistant",
                                detail: { type: itemType },
                            },
                            message: text,
                            ok: true,
                            level: "info",
                        };
                    }
                }
                return null;
            }
            if (itemType === "reasoning") {
                return {
                    type: "action",
                    engine: this.cliEngine,
                    phase,
                    entryType: "thought",
                    action: {
                        id: itemId,
                        kind: "reasoning",
                        title: "reasoning",
                        detail: { type: itemType },
                    },
                    message: asString(item.text),
                    ok: phase === "completed" ? true : undefined,
                    level: "info",
                };
            }
            if (itemType === "command_execution") {
                const status = asString(item.status);
                const exitCode = asNumber(item.exit_code);
                const command = asString(item.command) ?? "command";
                return {
                    type: "action",
                    engine: this.cliEngine,
                    phase,
                    entryType: "thought",
                    action: {
                        id: itemId,
                        kind: "command",
                        title: truncate(command, 160),
                        detail: {
                            type: itemType,
                            status,
                            exitCode,
                        },
                    },
                    message: phase === "started" ? `Running ${truncate(command, 120)}` : undefined,
                    ok: phase === "completed"
                        ? status === "completed" && (exitCode === undefined || exitCode === 0)
                        : undefined,
                    level: phase === "completed" && status === "failed" ? "warning" : "info",
                };
            }
            if (itemType === "file_change") {
                const rawChanges = Array.isArray(item.changes) ? item.changes : [];
                const files = rawChanges
                    .map((entry) => {
                    if (!isRecord(entry))
                        return null;
                    const pathValue = asString(entry.path);
                    const kindValue = asString(entry.kind);
                    if (!pathValue || !kindValue)
                        return null;
                    return `${kindValue} ${pathValue}`;
                })
                    .filter((entry) => Boolean(entry));
                const message = files.length > 0 ? files.slice(0, 4).join(", ") : "Updated files";
                return {
                    type: "action",
                    engine: this.cliEngine,
                    phase: "completed",
                    entryType: "thought",
                    action: {
                        id: itemId,
                        kind: "file_change",
                        title: "file changes",
                        detail: {
                            type: itemType,
                            changes: rawChanges,
                        },
                    },
                    message,
                    ok: asString(item.status) !== "failed",
                    level: "info",
                };
            }
            if (itemType === "mcp_tool_call") {
                const server = asString(item.server) ?? "mcp";
                const tool = asString(item.tool) ?? "tool";
                const status = asString(item.status);
                const errorMessage = isRecord(item.error) ? asString(item.error.message) : undefined;
                return {
                    type: "action",
                    engine: this.cliEngine,
                    phase,
                    entryType: "thought",
                    action: {
                        id: itemId,
                        kind: "tool",
                        title: `${server}.${tool}`,
                        detail: {
                            type: itemType,
                            server,
                            tool,
                            status,
                            arguments: item.arguments,
                        },
                    },
                    message: errorMessage,
                    ok: phase === "completed" ? status !== "failed" : undefined,
                    level: phase === "completed" && status === "failed" ? "warning" : "info",
                };
            }
            if (itemType === "web_search") {
                const query = asString(item.query) ?? "";
                return {
                    type: "action",
                    engine: this.cliEngine,
                    phase: "completed",
                    entryType: "thought",
                    action: {
                        id: itemId,
                        kind: "web_search",
                        title: "web search",
                        detail: {
                            type: itemType,
                            query,
                        },
                    },
                    message: query ? `Web search: ${truncate(query, 120)}` : undefined,
                    ok: true,
                    level: "info",
                };
            }
            if (itemType === "todo_list") {
                const items = Array.isArray(item.items) ? item.items : [];
                const completedCount = items.filter((entry) => isRecord(entry) && entry.completed === true).length;
                const message = `${completedCount}/${items.length} tasks complete`;
                return {
                    type: "action",
                    engine: this.cliEngine,
                    phase,
                    entryType: "thought",
                    action: {
                        id: itemId,
                        kind: "todo_list",
                        title: "todo list",
                        detail: {
                            type: itemType,
                            items,
                        },
                    },
                    message,
                    ok: phase === "completed" ? true : undefined,
                    level: "info",
                };
            }
            if (itemType === "error") {
                return {
                    type: "action",
                    engine: this.cliEngine,
                    phase: "completed",
                    entryType: "thought",
                    action: {
                        id: itemId,
                        kind: "warning",
                        title: "warning",
                        detail: { type: itemType },
                    },
                    message: asString(item.message) ?? "Codex reported a warning",
                    ok: true,
                    level: "warning",
                };
            }
            return {
                type: "action",
                engine: this.cliEngine,
                phase,
                entryType: "thought",
                action: {
                    id: itemId,
                    kind: "note",
                    title: itemType,
                    detail: { item },
                },
                level: "debug",
            };
        };
        /**
     * @param {string} line
     * @returns {AgentCliEvent[]}
     */
        const parseLine = (line) => {
            const trimmedLine = line.trim();
            if (!trimmedLine) {
                return [];
            }
            let payload;
            try {
                payload = JSON.parse(trimmedLine);
            }
            catch {
                if (!shouldSurfaceUnparsedStdout(trimmedLine)) {
                    return [];
                }
                return [
                    {
                        type: "action",
                        engine: this.cliEngine,
                        phase: "completed",
                        entryType: "thought",
                        action: {
                            id: nextSyntheticId("codex-line"),
                            kind: "warning",
                            title: "stdout",
                            detail: {},
                        },
                        message: truncate(trimmedLine, 220),
                        ok: true,
                        level: "warning",
                    },
                ];
            }
            if (!isRecord(payload)) {
                return [];
            }
            const payloadType = asString(payload.type);
            if (!payloadType) {
                return [];
            }
            if (payloadType === "thread.started") {
                const parsedThreadId = asString(payload.thread_id);
                if (parsedThreadId) {
                    threadId = parsedThreadId;
                }
                return [
                    {
                        type: "started",
                        engine: this.cliEngine,
                        title: "Codex",
                        resume: threadId,
                        detail: threadId ? { threadId } : undefined,
                    },
                ];
            }
            if (payloadType === "turn.started") {
                turnIndex += 1;
                return [
                    {
                        type: "action",
                        engine: this.cliEngine,
                        phase: "started",
                        entryType: "thought",
                        action: {
                            id: `turn-${turnIndex}`,
                            kind: "turn",
                            title: `turn ${turnIndex}`,
                            detail: {},
                        },
                        message: `Turn ${turnIndex} started`,
                        level: "info",
                    },
                ];
            }
            if (payloadType === "item.started" ||
                payloadType === "item.updated" ||
                payloadType === "item.completed") {
                const item = isRecord(payload.item) ? payload.item : null;
                if (!item) {
                    return [];
                }
                const phase = payloadType === "item.started"
                    ? "started"
                    : payloadType === "item.updated"
                        ? "updated"
                        : "completed";
                const action = actionForItem(item, phase);
                return action ? [action] : [];
            }
            if (payloadType === "turn.completed") {
                if (didEmitCompleted) {
                    return [];
                }
                didEmitCompleted = true;
                return [
                    {
                        type: "completed",
                        engine: this.cliEngine,
                        ok: true,
                        answer: finalAnswer,
                        resume: threadId,
                        usage: isRecord(payload.usage) ? payload.usage : undefined,
                    },
                ];
            }
            if (payloadType === "turn.failed") {
                if (didEmitCompleted) {
                    return [];
                }
                didEmitCompleted = true;
                const errorMessage = isRecord(payload.error)
                    ? asString(payload.error.message)
                    : undefined;
                return [
                    {
                        type: "completed",
                        engine: this.cliEngine,
                        ok: false,
                        answer: finalAnswer || undefined,
                        error: errorMessage ?? "Codex turn failed",
                        resume: threadId,
                    },
                ];
            }
            if (payloadType === "error") {
                const message = asString(payload.message) ?? "Codex stream error";
                if (/reconnecting/i.test(message)) {
                    return [
                        {
                            type: "action",
                            engine: this.cliEngine,
                            phase: "updated",
                            entryType: "thought",
                            action: {
                                id: nextSyntheticId("codex-reconnect"),
                                kind: "warning",
                                title: "stream reconnect",
                                detail: { message },
                            },
                            message,
                            ok: true,
                            level: "warning",
                        },
                    ];
                }
                if (didEmitCompleted) {
                    return [
                        {
                            type: "action",
                            engine: this.cliEngine,
                            phase: "completed",
                            entryType: "thought",
                            action: {
                                id: nextSyntheticId("codex-error"),
                                kind: "warning",
                                title: "stream error",
                                detail: { message },
                            },
                            message,
                            ok: false,
                            level: "error",
                        },
                    ];
                }
                didEmitCompleted = true;
                return [
                    {
                        type: "completed",
                        engine: this.cliEngine,
                        ok: false,
                        answer: finalAnswer || undefined,
                        error: message,
                        resume: threadId,
                    },
                ];
            }
            return [];
        };
        return {
            onStdoutLine: parseLine,
            onStderrLine: (line) => {
                const trimmedLine = line.trim();
                if (!trimmedLine) {
                    return [];
                }
                return [
                    {
                        type: "action",
                        engine: this.cliEngine,
                        phase: "completed",
                        entryType: "thought",
                        action: {
                            id: nextSyntheticId("codex-stderr"),
                            kind: "warning",
                            title: "stderr",
                            detail: {},
                        },
                        message: truncate(trimmedLine, 220),
                        ok: true,
                        level: "warning",
                    },
                ];
            },
            onExit: (result) => {
                if (didEmitCompleted) {
                    return [];
                }
                const isSuccess = (result.exitCode ?? 0) === 0;
                didEmitCompleted = true;
                return [
                    {
                        type: "completed",
                        engine: this.cliEngine,
                        ok: isSuccess,
                        answer: finalAnswer || undefined,
                        error: isSuccess ? undefined : `Codex exited with code ${result.exitCode ?? -1}`,
                        resume: threadId,
                    },
                ];
            },
        };
    }
    /**
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
   */
    async buildCommand(params) {
        const resumeSession = typeof params.options?.resumeSession === "string"
            ? params.options.resumeSession
            : undefined;
        const args = resumeSession ? ["exec", "resume", resumeSession] : ["exec"];
        const yoloEnabled = this.opts.yolo ?? this.yolo;
        const configOverrides = normalizeCodexConfig(this.opts.config);
        for (const entry of configOverrides) {
            args.push("-c", entry);
        }
        pushList(args, "--enable", this.opts.enable);
        pushList(args, "--disable", this.opts.disable);
        pushList(args, "--image", this.opts.image);
        pushFlag(args, "--model", this.opts.model ?? this.model);
        if (this.opts.oss)
            args.push("--oss");
        pushFlag(args, "--local-provider", this.opts.localProvider);
        pushFlag(args, "--sandbox", this.opts.sandbox);
        pushFlag(args, "--profile", this.opts.profile);
        if (this.opts.fullAuto) {
            args.push("--full-auto");
        }
        else if (yoloEnabled || this.opts.dangerouslyBypassApprovalsAndSandbox) {
            args.push("--dangerously-bypass-approvals-and-sandbox");
        }
        pushFlag(args, "--cd", this.opts.cd);
        if (this.opts.skipGitRepoCheck)
            args.push("--skip-git-repo-check");
        pushList(args, "--add-dir", this.opts.addDir);
        if (!resumeSession) {
            pushFlag(args, "--output-schema", this.opts.outputSchema);
        }
        pushFlag(args, "--color", this.opts.color);
        // Always enable JSON output to capture JSONL events including
        // turn.completed with token usage for metrics. extractUsageFromOutput
        // in BaseCliAgent will parse these automatically.
        args.push("--json");
        // Auto-wire output schema from task context if not explicitly set.
        // Skip when resuming — `codex exec resume` does not accept --output-schema.
        let schemaCleanupFile = null;
        if (!resumeSession && !this.opts.outputSchema && params.options?.outputSchema) {
            const schema = params.options.outputSchema;
            const { z } = await import("zod");
            let jsonSchema = z.toJSONSchema(schema);
            // Sanitize for OpenAI structured output compatibility
            sanitizeForOpenAI(jsonSchema);
            const schemaFile = join(tmpdir(), `smithers-schema-${randomUUID()}.json`);
            await fs.writeFile(schemaFile, JSON.stringify(jsonSchema), "utf8");
            pushFlag(args, "--output-schema", schemaFile);
            schemaCleanupFile = schemaFile;
        }
        const outputFile = this.opts.outputLastMessage ??
            join(tmpdir(), `smithers-codex-${randomUUID()}.txt`);
        pushFlag(args, "--output-last-message", outputFile);
        if (this.extraArgs?.length)
            args.push(...this.extraArgs);
        const systemPrefix = params.systemPrompt
            ? `${params.systemPrompt}\n\n`
            : "";
        const fullPrompt = `${systemPrefix}${params.prompt ?? ""}`;
        args.push("-");
        return {
            command: "codex",
            args,
            stdin: fullPrompt,
            outputFile,
            outputFormat: "stream-json",
            stdoutBannerPatterns: [
                // Codex CLI prints a startup banner like:
                // "OpenAI Codex v0.99.0-alpha.13 (research preview)"
                /^OpenAI Codex v[^\n]*$/gm,
            ],
            cleanup: async () => {
                if (!this.opts.outputLastMessage) {
                    await fs.rm(outputFile, { force: true }).catch(() => undefined);
                }
                if (schemaCleanupFile) {
                    await fs
                        .rm(schemaCleanupFile, { force: true })
                        .catch(() => undefined);
                }
            },
        };
    }
}
