import { BaseCliAgent, pushFlag, } from "./BaseCliAgent/index.js";
import { randomUUID } from "node:crypto";
/** @typedef {import("./BaseCliAgent/BaseCliAgentOptions.ts").BaseCliAgentOptions} BaseCliAgentOptions */
/** @typedef {import("./BaseCliAgent/CliOutputInterpreter.ts").CliOutputInterpreter} CliOutputInterpreter */
/** @typedef {import("./ForgeAgentOptions.ts").ForgeAgentOptions} ForgeAgentOptions */

export class ForgeAgent extends BaseCliAgent {
    opts;
    capabilities;
    cliEngine = "forge";
    issuedConversationId;
    /**
   * @param {ForgeAgentOptions} [opts]
   */
    constructor(opts = {}) {
        super(opts);
        this.opts = opts;
        this.capabilities = {
            version: 1,
            engine: "forge",
            runtimeTools: {},
            mcp: {
                bootstrap: "unsupported",
                supportsProjectScope: false,
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
            builtIns: ["default"],
        };
    }
    /**
   * @returns {CliOutputInterpreter}
   */
    createOutputInterpreter() {
        let emittedStarted = false;
        return {
            onStdoutLine: () => {
                if (emittedStarted)
                    return [];
                emittedStarted = true;
                return [{
                        type: "started",
                        engine: this.cliEngine,
                        title: "Forge",
                        resume: this.issuedConversationId,
                    }];
            },
            onExit: (result) => {
                const started = !emittedStarted && this.issuedConversationId
                    ? [{
                            type: "started",
                            engine: this.cliEngine,
                            title: "Forge",
                            resume: this.issuedConversationId,
                        }]
                    : [];
                return [
                    ...started,
                    {
                        type: "completed",
                        engine: this.cliEngine,
                        ok: !result.exitCode || result.exitCode === 0,
                        answer: result.stdout.trim() || undefined,
                        error: result.exitCode && result.exitCode !== 0
                            ? result.stderr.trim() || `Forge exited with code ${result.exitCode}`
                            : undefined,
                        resume: this.issuedConversationId,
                    },
                ];
            },
        };
    }
    /**
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} params
   */
    async buildCommand(params) {
        const args = [];
        // Model
        pushFlag(args, "--model", this.opts.model ?? this.model);
        // Provider
        pushFlag(args, "--provider", this.opts.provider);
        // Agent type
        pushFlag(args, "--agent", this.opts.agent);
        // Conversation ID
        const resumeSession = typeof params.options?.resumeSession === "string"
            ? params.options.resumeSession
            : undefined;
        this.issuedConversationId = resumeSession ?? this.opts.conversationId ?? randomUUID();
        pushFlag(args, "--conversation-id", this.issuedConversationId);
        // Sandbox
        pushFlag(args, "--sandbox", this.opts.sandbox);
        // Restricted mode
        if (this.opts.restricted)
            args.push("--restricted");
        // Verbose
        if (this.opts.verbose)
            args.push("--verbose");
        // Workflow file
        pushFlag(args, "--workflow", this.opts.workflow);
        // Event JSON
        pushFlag(args, "--event", this.opts.event);
        // Conversation file
        pushFlag(args, "--conversation", this.opts.conversation);
        // Directory — default to cwd
        pushFlag(args, "-C", this.opts.directory ?? params.cwd);
        if (this.extraArgs?.length)
            args.push(...this.extraArgs);
        // Build prompt with system prompt prepended
        const systemPrefix = params.systemPrompt
            ? `${params.systemPrompt}\n\n`
            : "";
        const fullPrompt = `${systemPrefix}${params.prompt ?? ""}`;
        // Pass prompt via --prompt flag
        pushFlag(args, "--prompt", fullPrompt);
        return {
            command: "forge",
            args,
            outputFormat: "text",
        };
    }
}
