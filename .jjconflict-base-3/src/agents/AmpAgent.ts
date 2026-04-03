import {
  type AgentCliActionKind,
  type AgentCliEvent,
  BaseCliAgent,
  type CliOutputInterpreter,
  pushFlag,
} from "./BaseCliAgent";
import type { BaseCliAgentOptions } from "./BaseCliAgent";

/**
 * Configuration options for the AmpAgent.
 */
export type AmpAgentOptions = BaseCliAgentOptions & {
  /** Visibility setting for the new thread (e.g., private, public) */
  visibility?: "private" | "public" | "workspace" | "group";
  
  /** Path to a specific MCP configuration file */
  mcpConfig?: string;
  
  /** Path to a specific settings file */
  settingsFile?: string;
  
  /** Logging severity level */
  logLevel?: "error" | "warn" | "info" | "debug" | "audit";
  
  /** File path to write logs to */
  logFile?: string;
  
  /** 
   * If true, dangerously allows all commands without asking for permission.
   * Equivalent to yolo mode but explicit.
   */
  dangerouslyAllowAll?: boolean;
  
  /** Whether to enable IDE integrations (disabled by default in AmpAgent) */
  ide?: boolean;
  
  /** Whether to enable JetBrains IDE integration */
  jetbrains?: boolean;
};

/**
 * Agent implementation that wraps the 'amp' CLI executable.
 * It translates generation requests into CLI arguments and executes the process.
 */
export class AmpAgent extends BaseCliAgent {
  private readonly opts: AmpAgentOptions;
  readonly cliEngine = "amp";

  /**
   * Initializes a new AmpAgent with the given options.
   * 
   * @param opts - Configuration options for the agent
   */
  constructor(opts: AmpAgentOptions = {}) {
    super(opts);
    this.opts = opts;
  }

  protected createOutputInterpreter(): CliOutputInterpreter {
    let sessionId: string | undefined;
    let finalAnswer = "";
    let syntheticCounter = 0;

    const nextSyntheticId = (prefix: string) => {
      syntheticCounter += 1;
      return `${prefix}-${syntheticCounter}`;
    };

    const asString = (value: unknown) =>
      typeof value === "string" ? value : undefined;

    const isRecord = (value: unknown): value is Record<string, unknown> =>
      Boolean(value) && typeof value === "object" && !Array.isArray(value);

    const toolKindForAmp = (name: string | undefined): AgentCliActionKind => {
      const normalized = (name ?? "").toLowerCase();
      if (!normalized) return "tool";
      if (normalized.includes("bash") || normalized.includes("shell") || normalized.includes("command")) {
        return "command";
      }
      if (normalized.includes("search") || normalized.includes("web")) {
        return "web_search";
      }
      if (normalized.includes("todo")) {
        return "todo_list";
      }
      return "tool";
    };

    const parseLine = (line: string): AgentCliEvent[] => {
      const trimmed = line.trim();
      if (!trimmed) return [];

      let payload: unknown;
      try {
        payload = JSON.parse(trimmed);
      } catch {
        return [];
      }
      if (!isRecord(payload)) return [];

      const type = asString(payload.type);
      if (!type) return [];

      if (type === "system" && asString(payload.subtype) === "init") {
        sessionId = asString(payload.session_id);
        return [{
          type: "started",
          engine: this.cliEngine,
          title: "Amp",
          resume: sessionId,
          detail: {
            cwd: asString(payload.cwd),
            tools: payload.tools,
          },
        }];
      }

      if (type === "assistant") {
        const message = isRecord(payload.message) ? payload.message : undefined;
        const content = Array.isArray(message?.content) ? message.content : [];
        const events: AgentCliEvent[] = [];

        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type === "text" && typeof block.text === "string") {
            finalAnswer += block.text;
            continue;
          }
          if (block.type === "tool_use") {
            const name = asString(block.name) ?? "tool";
            const id = asString(block.id) ?? nextSyntheticId("amp-tool");
            events.push({
              type: "action",
              engine: this.cliEngine,
              phase: "started",
              entryType: "thought",
              action: {
                id,
                kind: toolKindForAmp(name),
                title: name,
                detail: {
                  input: block.input,
                  parentToolUseId: payload.parent_tool_use_id,
                },
              },
              message: `Running ${name}`,
              level: "info",
            });
          }
        }

        return events;
      }

      if (type === "user") {
        const message = isRecord(payload.message) ? payload.message : undefined;
        const content = Array.isArray(message?.content) ? message.content : [];
        const events: AgentCliEvent[] = [];

        for (const block of content) {
          if (!isRecord(block) || block.type !== "tool_result") continue;
          const id = asString(block.tool_use_id) ?? nextSyntheticId("amp-tool");
          events.push({
            type: "action",
            engine: this.cliEngine,
            phase: "completed",
            entryType: "thought",
            action: {
              id,
              kind: "tool",
              title: "tool result",
              detail: {
                parentToolUseId: payload.parent_tool_use_id,
              },
            },
            message: asString(block.content),
            ok: block.is_error !== true,
            level: block.is_error === true ? "warning" : "info",
          });
        }

        return events;
      }

      if (type === "result") {
        const ok = payload.is_error !== true;
        return [{
          type: "completed",
          engine: this.cliEngine,
          ok,
          answer: finalAnswer || asString(payload.result),
          error: ok ? undefined : asString(payload.error),
          resume: asString(payload.session_id) ?? sessionId,
          usage: isRecord(payload.usage) ? payload.usage : undefined,
        }];
      }

      return [];
    };

    return {
      onStdoutLine: parseLine,
      onExit: (result) => {
        if (result.exitCode === 0) return [];
        return [{
          type: "completed",
          engine: this.cliEngine,
          ok: false,
          answer: finalAnswer || undefined,
          error: result.stderr.trim() || `Amp exited with code ${result.exitCode}`,
          resume: sessionId,
        }];
      },
    };
  }

  protected async buildCommand(params: {
    prompt: string;
    systemPrompt?: string;
    cwd: string;
    options: any;
  }) {
    const args: string[] = [];
    const yoloEnabled = this.opts.yolo ?? this.yolo;

    // Dangerous allow all (yolo mode) — must come before --execute
    if (this.opts.dangerouslyAllowAll || yoloEnabled) {
      args.push("--dangerously-allow-all");
    }

    // Model / mode
    pushFlag(args, "--model", this.opts.model ?? this.model);

    // Visibility for new threads
    pushFlag(args, "--visibility", this.opts.visibility);

    // MCP config
    pushFlag(args, "--mcp-config", this.opts.mcpConfig);

    // Settings file
    pushFlag(args, "--settings-file", this.opts.settingsFile);

    // Log level
    pushFlag(args, "--log-level", this.opts.logLevel);

    // Log file
    pushFlag(args, "--log-file", this.opts.logFile);

    // IDE integration — disable by default for headless execution
    args.push("--no-ide");
    args.push("--no-jetbrains");

    // Color handling
    args.push("--no-color");

    // Archive thread after execution to keep things clean
    args.push("--archive");

    if (this.extraArgs?.length) args.push(...this.extraArgs);

    // Build prompt with system prompt prepended
    const systemPrefix = params.systemPrompt
      ? `${params.systemPrompt}\n\n`
      : "";
    const fullPrompt = `${systemPrefix}${params.prompt ?? ""}`;

    // Execute mode with prompt as argument
    args.push("--execute", fullPrompt);

    const useStreamJson = Boolean(params.options?.onEvent);

    if (useStreamJson) {
      args.push("--stream-json");
    }

    return {
      command: "amp",
      args,
      outputFormat: useStreamJson ? "stream-json" as const : "text" as const,
    };
  }
}
