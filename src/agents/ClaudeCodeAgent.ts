import {
  BaseCliAgent,
  pushFlag,
  pushList,
} from "./BaseCliAgent";
import type { BaseCliAgentOptions } from "./BaseCliAgent";

type ClaudeCodeAgentOptions = BaseCliAgentOptions & {
  addDir?: string[];
  agent?: string;
  agents?: Record<string, { description?: string; prompt?: string }> | string;
  allowDangerouslySkipPermissions?: boolean;
  allowedTools?: string[];
  appendSystemPrompt?: string;
  betas?: string[];
  chrome?: boolean;
  continue?: boolean;
  dangerouslySkipPermissions?: boolean;
  debug?: boolean | string;
  debugFile?: string;
  disableSlashCommands?: boolean;
  disallowedTools?: string[];
  fallbackModel?: string;
  file?: string[];
  forkSession?: boolean;
  fromPr?: string;
  ide?: boolean;
  includePartialMessages?: boolean;
  inputFormat?: "text" | "stream-json";
  jsonSchema?: string;
  maxBudgetUsd?: number;
  mcpConfig?: string[];
  mcpDebug?: boolean;
  model?: string;
  noChrome?: boolean;
  noSessionPersistence?: boolean;
  outputFormat?: "text" | "json" | "stream-json";
  permissionMode?:
    | "acceptEdits"
    | "bypassPermissions"
    | "default"
    | "delegate"
    | "dontAsk"
    | "plan";
  pluginDir?: string[];
  replayUserMessages?: boolean;
  resume?: string;
  sessionId?: string;
  settingSources?: string;
  settings?: string;
  strictMcpConfig?: boolean;
  systemPrompt?: string;
  tools?: string[] | "default" | "";
  verbose?: boolean;
};

export class ClaudeCodeAgent extends BaseCliAgent {
  private readonly opts: ClaudeCodeAgentOptions;

  constructor(opts: ClaudeCodeAgentOptions = {}) {
    // Clear env vars that cause "Cannot run nested Claude Code instances" errors.
    // CLAUDE_CODE_ENTRYPOINT / CLAUDECODE are set by a parent Claude Code process;
    // child instances refuse to start when they detect these.
    // ANTHROPIC_API_KEY is cleared so Claude Code uses the subscription instead of API billing.
    const parentEnvOverrides: Record<string, string> = {};
    if (process.env.CLAUDE_CODE_ENTRYPOINT) parentEnvOverrides.CLAUDE_CODE_ENTRYPOINT = "";
    if (process.env.CLAUDECODE) parentEnvOverrides.CLAUDECODE = "";
    if (process.env.ANTHROPIC_API_KEY) {
      console.warn(
        "[smithers] ClaudeCodeAgent: unsetting ANTHROPIC_API_KEY so Claude Code uses your subscription. " +
        "To use API billing instead, use ToolLoopAgent from 'ai' with anthropic() provider.",
      );
      parentEnvOverrides.ANTHROPIC_API_KEY = "";
    }
    if (Object.keys(parentEnvOverrides).length > 0) {
      opts = { ...opts, env: { ...parentEnvOverrides, ...opts.env } };
    }
    super(opts);
    this.opts = opts;
  }

  protected async buildCommand(params: {
    prompt: string;
    systemPrompt?: string;
    cwd: string;
    options: any;
  }) {
    const args: string[] = ["--print"];
    // Default to "stream-json" to capture NDJSON events that include token
    // usage (message_start has input_tokens, message_delta has output_tokens).
    // BaseCliAgent.extractUsageFromOutput will parse these for metrics.
    const outputFormat = this.opts.outputFormat ?? "stream-json";
    // Recent Claude CLI builds require --verbose when --print is combined with
    // --output-format=stream-json.
    const requiresVerbose = outputFormat === "stream-json";

    pushList(args, "--add-dir", this.opts.addDir);
    pushFlag(args, "--agent", this.opts.agent);
    if (this.opts.agents) {
      const agentsJson =
        typeof this.opts.agents === "string"
          ? this.opts.agents
          : JSON.stringify(this.opts.agents);
      pushFlag(args, "--agents", agentsJson);
    }

    const yoloEnabled = this.opts.yolo ?? this.yolo;
    if (yoloEnabled) {
      args.push("--allow-dangerously-skip-permissions");
      args.push("--dangerously-skip-permissions");
      if (!this.opts.permissionMode) {
        args.push("--permission-mode", "bypassPermissions");
      }
    }

    if (this.opts.allowDangerouslySkipPermissions)
      args.push("--allow-dangerously-skip-permissions");
    if (this.opts.dangerouslySkipPermissions)
      args.push("--dangerously-skip-permissions");
    pushList(args, "--allowed-tools", this.opts.allowedTools);
    pushFlag(args, "--append-system-prompt", this.opts.appendSystemPrompt);
    pushList(args, "--betas", this.opts.betas);
    if (this.opts.chrome) args.push("--chrome");
    if (this.opts.noChrome) args.push("--no-chrome");
    if (this.opts.continue) args.push("--continue");
    if (this.opts.debug === true) {
      args.push("--debug");
    } else if (typeof this.opts.debug === "string") {
      pushFlag(args, "--debug", this.opts.debug);
    }
    pushFlag(args, "--debug-file", this.opts.debugFile);
    if (this.opts.disableSlashCommands) args.push("--disable-slash-commands");
    pushList(args, "--disallowed-tools", this.opts.disallowedTools);
    pushFlag(args, "--fallback-model", this.opts.fallbackModel);
    pushList(args, "--file", this.opts.file);
    if (this.opts.forkSession) args.push("--fork-session");
    pushFlag(args, "--from-pr", this.opts.fromPr);
    if (this.opts.ide) args.push("--ide");
    if (this.opts.includePartialMessages)
      args.push("--include-partial-messages");
    pushFlag(args, "--input-format", this.opts.inputFormat);
    pushFlag(args, "--json-schema", this.opts.jsonSchema);
    pushFlag(args, "--max-budget-usd", this.opts.maxBudgetUsd);
    pushList(args, "--mcp-config", this.opts.mcpConfig);
    if (this.opts.mcpDebug) args.push("--mcp-debug");
    pushFlag(args, "--model", this.opts.model ?? this.model);
    if (this.opts.noSessionPersistence) args.push("--no-session-persistence");
    pushFlag(args, "--output-format", outputFormat);
    pushFlag(args, "--permission-mode", this.opts.permissionMode);
    pushList(args, "--plugin-dir", this.opts.pluginDir);
    if (this.opts.replayUserMessages) args.push("--replay-user-messages");
    pushFlag(args, "--resume", this.opts.resume);
    pushFlag(args, "--session-id", this.opts.sessionId);
    pushFlag(args, "--setting-sources", this.opts.settingSources);
    pushFlag(args, "--settings", this.opts.settings);
    if (this.opts.strictMcpConfig) args.push("--strict-mcp-config");
    if (params.systemPrompt) {
      pushFlag(args, "--system-prompt", params.systemPrompt);
    }
    if (this.opts.tools !== undefined) {
      if (this.opts.tools === "") {
        pushFlag(args, "--tools", "");
      } else if (this.opts.tools === "default") {
        pushFlag(args, "--tools", "default");
      } else {
        pushList(args, "--tools", this.opts.tools as string[]);
      }
    }
    if (this.opts.verbose || requiresVerbose) args.push("--verbose");
    if (this.extraArgs?.length) args.push(...this.extraArgs);

    if (params.prompt) args.push(params.prompt);

    return {
      command: "claude",
      args,
      outputFormat,
    };
  }
}
