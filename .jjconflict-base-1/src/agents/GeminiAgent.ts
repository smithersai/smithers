import {
  type AgentCliActionKind,
  type AgentCliEvent,
  BaseCliAgent,
  type CliOutputInterpreter,
  pushFlag,
  pushList,
} from "./BaseCliAgent";
import type { BaseCliAgentOptions } from "./BaseCliAgent";

type GeminiAgentOptions = BaseCliAgentOptions & {
  debug?: boolean;
  model?: string;
  sandbox?: boolean;
  yolo?: boolean;
  approvalMode?: "default" | "auto_edit" | "yolo" | "plan";
  experimentalAcp?: boolean;
  allowedMcpServerNames?: string[];
  allowedTools?: string[];
  extensions?: string[];
  listExtensions?: boolean;
  resume?: string;
  listSessions?: boolean;
  deleteSession?: string;
  includeDirectories?: string[];
  screenReader?: boolean;
  outputFormat?: "text" | "json" | "stream-json";
};

export class GeminiAgent extends BaseCliAgent {
  private readonly opts: GeminiAgentOptions;
  readonly cliEngine = "gemini";

  constructor(opts: GeminiAgentOptions = {}) {
    super(opts);
    this.opts = opts;
  }

  protected createOutputInterpreter(): CliOutputInterpreter {
    let sessionId: string | undefined;
    let finalAnswer = "";
    let emittedStarted = false;
    let syntheticCounter = 0;

    const nextSyntheticId = (prefix: string) => {
      syntheticCounter += 1;
      return `${prefix}-${syntheticCounter}`;
    };

    const truncate = (value: string, maxLength = 240) =>
      value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;

    const asString = (value: unknown) =>
      typeof value === "string" ? value : undefined;

    const isRecord = (value: unknown): value is Record<string, unknown> =>
      Boolean(value) && typeof value === "object" && !Array.isArray(value);

    const toolKindForGemini = (name: string | undefined): AgentCliActionKind => {
      const normalized = (name ?? "").toLowerCase();
      if (!normalized) return "tool";
      if (normalized.includes("bash") || normalized.includes("shell") || normalized.includes("command")) {
        return "command";
      }
      if (normalized.includes("search") || normalized.includes("web")) {
        return "web_search";
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

      if (type === "init") {
        const resume = asString(payload.session_id);
        if (resume) {
          sessionId = resume;
        }
        emittedStarted = true;
        return [{
          type: "started",
          engine: this.cliEngine,
          title: "Gemini CLI",
          resume: sessionId,
          detail: {
            model: asString(payload.model),
          },
        }];
      }

      if (type === "MESSAGE") {
        const role = asString(payload.role);
        const content = asString(payload.content);
        if (role === "assistant" && content) {
          if (payload.delta === true) {
            finalAnswer += content;
          } else {
            finalAnswer = content;
          }
        }
        return [];
      }

      if (type === "TOOL_USE") {
        const toolName = asString(payload.tool_name) ?? "tool";
        const toolId = asString(payload.tool_id) ?? nextSyntheticId("gemini-tool");
        return [{
          type: "action",
          engine: this.cliEngine,
          phase: "started",
          entryType: "thought",
          action: {
            id: toolId,
            kind: toolKindForGemini(toolName),
            title: toolName,
            detail: {
              parameters: payload.parameters,
            },
          },
          message: `Running ${toolName}`,
          level: "info",
        }];
      }

      if (type === "TOOL_RESULT") {
        const toolId = asString(payload.tool_id) ?? nextSyntheticId("gemini-tool");
        const ok = asString(payload.status) !== "error";
        const error = isRecord(payload.error) ? asString(payload.error.message) : undefined;
        const output = asString(payload.output);
        return [{
          type: "action",
          engine: this.cliEngine,
          phase: "completed",
          entryType: "thought",
          action: {
            id: toolId,
            kind: "tool",
            title: "tool result",
            detail: {
              status: asString(payload.status),
              output: output ? truncate(output, 400) : undefined,
            },
          },
          message: error ?? output,
          ok,
          level: ok ? "info" : "warning",
        }];
      }

      if (type === "ERROR") {
        return [{
          type: "action",
          engine: this.cliEngine,
          phase: "completed",
          entryType: "thought",
          action: {
            id: nextSyntheticId("gemini-warning"),
            kind: "warning",
            title: "warning",
            detail: {
              severity: asString(payload.severity),
            },
          },
          message: asString(payload.message),
          ok: asString(payload.severity) !== "error",
          level: asString(payload.severity) === "error" ? "error" : "warning",
        }];
      }

      if (type === "RESULT") {
        return [{
          type: "completed",
          engine: this.cliEngine,
          ok: asString(payload.status) !== "error",
          answer: finalAnswer || asString(payload.response),
          resume: sessionId,
          usage: isRecord(payload.stats) ? payload.stats : undefined,
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
          error: result.stderr.trim() || `Gemini exited with code ${result.exitCode}`,
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
    // Default to "json" output format to separate model responses from tool
    // output text. With "text" format, tool call results (file contents etc.)
    // are concatenated into the response, making JSON extraction unreliable.
    const outputFormat = this.opts.outputFormat ??
      (params.options?.onEvent ? "stream-json" : "json");
    const resumeSession = typeof params.options?.resumeSession === "string"
      ? params.options.resumeSession
      : this.opts.resume;

    if (this.opts.debug) args.push("--debug");
    pushFlag(args, "--model", this.opts.model ?? this.model);
    if (this.opts.sandbox) args.push("--sandbox");
    if (this.opts.approvalMode) {
      pushFlag(args, "--approval-mode", this.opts.approvalMode);
    } else if (yoloEnabled) {
      args.push("--yolo");
    }
    if (this.opts.experimentalAcp) args.push("--experimental-acp");
    pushList(
      args,
      "--allowed-mcp-server-names",
      this.opts.allowedMcpServerNames,
    );
    pushList(args, "--allowed-tools", this.opts.allowedTools);
    pushList(args, "--extensions", this.opts.extensions);
    if (this.opts.listExtensions) args.push("--list-extensions");
    pushFlag(args, "--resume", resumeSession);
    if (this.opts.listSessions) args.push("--list-sessions");
    pushFlag(args, "--delete-session", this.opts.deleteSession);
    pushList(args, "--include-directories", this.opts.includeDirectories);
    if (this.opts.screenReader) args.push("--screen-reader");
    pushFlag(args, "--output-format", outputFormat);
    if (this.extraArgs?.length) args.push(...this.extraArgs);

    const systemPrefix = params.systemPrompt
      ? `${params.systemPrompt}\n\n`
      : "";
    // Reinforce JSON output requirement in the prompt for Gemini models which
    // tend to forget structured output instructions on long responses.
    const jsonReminder = params.prompt?.includes("REQUIRED OUTPUT")
      ? "\n\nREMINDER: Your response MUST end with a ```json code fence containing the required JSON object. Do NOT skip this step — the pipeline will reject your response without it.\n"
      : "";
    const fullPrompt = `${systemPrefix}${params.prompt ?? ""}${jsonReminder}`;
    args.push("--prompt", fullPrompt);

    return {
      command: "gemini",
      args,
      outputFormat,
    };
  }
}
