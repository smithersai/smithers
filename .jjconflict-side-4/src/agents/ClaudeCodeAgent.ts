import {
  BaseCliAgent,
  type AgentCliActionKind,
  type AgentCliEvent,
  pushFlag,
  pushList,
  type CliOutputInterpreter,
  type RunCommandResult,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

const TOOL_OUTPUT_MAX_CHARS = 500;

function truncate(value: string, maxLength = TOOL_OUTPUT_MAX_CHARS) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

function isLikelyRuntimeMetadata(value: string) {
  const lower = value.toLowerCase();
  const markers = [
    "\"mcp_servers\"",
    "\"slash_commands\"",
    "\"permissionmode\"",
    "\"claude_code_version\"",
    "\"apikeysource\"",
    "\"plugins\"",
    "\"skills\"",
  ];

  let matches = 0;
  for (const marker of markers) {
    if (lower.includes(marker)) {
      matches += 1;
    }
  }

  return matches >= 3;
}

function summarizeToolOutput(toolName: string, rawOutput: string | undefined) {
  const output = rawOutput?.trim();
  if (!output) {
    return undefined;
  }

  const toolErrorMatch = output.match(/<tool_use_error>([\s\S]*?)<\/tool_use_error>/i);
  if (toolErrorMatch?.[1]) {
    return `Tool error: ${truncate(toolErrorMatch[1].trim(), 240)}`;
  }

  if (isLikelyRuntimeMetadata(output)) {
    return "Tool output omitted (runtime metadata).";
  }

  const normalizedToolName = toolName.toLowerCase();
  if (normalizedToolName.includes("read")) {
    const numberedLines = output.split("\n").filter((line) => /^\s*\d+→/.test(line));
    if (numberedLines.length > 8) {
      return `Read output (${numberedLines.length} lines)`;
    }
  }

  const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length > 5) {
    const preview = lines.slice(0, 3).join("\n");
    return `${truncate(preview, 300)}\n… (+${lines.length - 3} lines)`;
  }

  return truncate(output);
}

function shouldSurfaceUnparsedStdout(line: string) {
  const lower = line.toLowerCase();
  if (line.length > 220) {
    return false;
  }

  return (
    lower.includes("error") ||
    lower.includes("failed") ||
    lower.includes("denied") ||
    lower.includes("exception") ||
    lower.includes("timeout")
  );
}

function toolKindForClaude(name: string | undefined): AgentCliActionKind {
  const normalized = (name ?? "").toLowerCase();
  if (!normalized) {
    return "tool";
  }

  if (normalized.includes("bash") || normalized.includes("command")) {
    return "command";
  }

  if (normalized.includes("web")) {
    return "web_search";
  }

  return "tool";
}

export class ClaudeCodeAgent extends BaseCliAgent {
  private readonly opts: ClaudeCodeAgentOptions;
  readonly cliEngine = "claude-code";

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

  protected createOutputInterpreter(): CliOutputInterpreter {
    let sessionId: string | undefined;
    let didEmitStarted = false;
    let didEmitCompleted = false;
    let lastAssistantText = "";
    let syntheticCounter = 0;
    const toolNameByUseId = new Map<string, string>();
    const nextSyntheticId = (prefix: string) => {
      syntheticCounter += 1;
      return `${prefix}-${syntheticCounter}`;
    };

    const warningAction = (
      title: string,
      message: string,
      level: "warning" | "error" = "warning",
    ): AgentCliEvent => ({
      type: "action",
      engine: this.cliEngine,
      phase: "completed",
      entryType: "thought",
      action: {
        id: nextSyntheticId("claude-warning"),
        kind: "warning",
        title,
        detail: {},
      },
      message,
      ok: level !== "error",
      level,
    });

    const parseLine = (line: string): AgentCliEvent[] => {
      const trimmedLine = line.trim();
      if (!trimmedLine) {
        return [];
      }

      let payload: unknown;
      try {
        payload = JSON.parse(trimmedLine);
      } catch {
        if (!shouldSurfaceUnparsedStdout(trimmedLine)) {
          return [];
        }
        return [warningAction("stdout", truncate(trimmedLine, 220), "warning")];
      }

      if (!isRecord(payload)) {
        return [];
      }

      const payloadType = asString(payload.type);
      if (!payloadType) {
        return [];
      }

      if (payloadType === "system" && asString(payload.subtype) === "init") {
        const parsedSessionId = asString(payload.session_id);
        if (parsedSessionId) {
          sessionId = parsedSessionId;
        }

        if (!didEmitStarted) {
          didEmitStarted = true;
          return [
            {
              type: "started",
              engine: this.cliEngine,
              title: "Claude Code",
              resume: sessionId,
              detail: sessionId ? { sessionId } : undefined,
            },
          ];
        }

        return [];
      }

      if (payloadType === "assistant" || payloadType === "user") {
        const message = isRecord(payload.message) ? payload.message : null;
        const contentBlocks = message && Array.isArray(message.content) ? message.content : [];
        const events: AgentCliEvent[] = [];

        for (const block of contentBlocks) {
          if (!isRecord(block)) continue;
          const blockType = asString(block.type);
          if (!blockType) continue;

          if (blockType === "text") {
            const text = asString(block.text)?.trim();
            if (payloadType === "assistant" && text) {
              lastAssistantText = text;
              events.push({
                type: "action",
                engine: this.cliEngine,
                phase: "updated",
                entryType: "message",
                action: {
                  id: nextSyntheticId("claude-text"),
                  kind: "note",
                  title: "assistant",
                  detail: {},
                },
                message: text,
                ok: true,
                level: "info",
              });
            }
            continue;
          }

          if (blockType === "tool_use") {
            const toolUseId = asString(block.id);
            const toolName = asString(block.name) ?? "tool";
            if (!toolUseId) continue;

            toolNameByUseId.set(toolUseId, toolName);
            events.push({
              type: "action",
              engine: this.cliEngine,
              phase: "started",
              entryType: "thought",
              action: {
                id: toolUseId,
                kind: toolKindForClaude(toolName),
                title: toolName,
                detail: isRecord(block.input)
                  ? {
                      input: block.input,
                    }
                  : {},
              },
              message: `Running ${toolName}`,
              level: "info",
            });
            continue;
          }

          if (blockType === "tool_result") {
            const toolUseId = asString(block.tool_use_id);
            if (!toolUseId) continue;
            const toolName = toolNameByUseId.get(toolUseId) ?? "tool";
            const toolResultContent = block.content;
            const resultSummary =
              typeof toolResultContent === "string"
                ? toolResultContent
                : Array.isArray(toolResultContent)
                ? toolResultContent
                    .map((entry) => (isRecord(entry) ? asString(entry.text) : undefined))
                    .filter((entry): entry is string => Boolean(entry))
                    .join("\n")
                : undefined;
            const isToolError = block.is_error === true;
            const summarizedMessage = summarizeToolOutput(toolName, resultSummary);

            events.push({
              type: "action",
              engine: this.cliEngine,
              phase: "completed",
              entryType: "thought",
              action: {
                id: toolUseId,
                kind: toolKindForClaude(toolName),
                title: toolName,
                detail: {},
              },
              message: summarizedMessage,
              ok: !isToolError,
              level: isToolError ? "warning" : "info",
            });
          }
        }

        return events;
      }

      if (payloadType === "result") {
        if (didEmitCompleted) {
          return [];
        }

        const denials = Array.isArray(payload.permission_denials) ? payload.permission_denials : [];
        const events: AgentCliEvent[] = denials
          .map((denial) => {
            if (!isRecord(denial)) return null;
            const toolName = asString(denial.tool_name) ?? "tool";
            return warningAction(
              `permission denied: ${toolName}`,
              `Permission denied for ${toolName}`,
              "warning",
            );
          })
          .filter((event): event is AgentCliEvent => Boolean(event));

        const subtype = asString(payload.subtype) ?? "success";
        const isError = payload.is_error === true || subtype === "error";
        const resultText = asString(payload.result);
        const resultError = asString(payload.error);

        didEmitCompleted = true;
        events.push({
          type: "completed",
          engine: this.cliEngine,
          ok: !isError,
          answer: !isError ? resultText || lastAssistantText || undefined : undefined,
          error: isError ? resultError || "Claude run failed" : undefined,
          resume: asString(payload.session_id) ?? sessionId,
          usage: isRecord(payload.usage) ? payload.usage : undefined,
        });
        return events;
      }

      return [];
    };

    return {
      onStdoutLine: parseLine,
      onStderrLine: (line: string): AgentCliEvent[] => {
        const trimmedLine = line.trim();
        if (!trimmedLine) {
          return [];
        }
        return [warningAction("stderr", truncate(trimmedLine, 220), "warning")];
      },
      onExit: (result: RunCommandResult): AgentCliEvent[] => {
        if (didEmitCompleted) {
          return [];
        }

        didEmitCompleted = true;
        const isSuccess = (result.exitCode ?? 0) === 0;
        return [
          {
            type: "completed",
            engine: this.cliEngine,
            ok: isSuccess,
            answer: isSuccess ? lastAssistantText || undefined : undefined,
            error: isSuccess ? undefined : `Claude exited with code ${result.exitCode ?? -1}`,
            resume: sessionId,
          },
        ];
      },
    };
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
    const resumeSession = typeof params.options?.resumeSession === "string"
      ? params.options.resumeSession
      : undefined;
    pushFlag(args, "--resume", resumeSession ?? this.opts.resume);
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
