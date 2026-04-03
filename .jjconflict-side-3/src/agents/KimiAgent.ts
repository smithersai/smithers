import { mkdtempSync, cpSync, existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  type AgentCliActionKind,
  type AgentCliEvent,
  BaseCliAgent,
  type CliOutputInterpreter,
  pushFlag,
  pushList,
} from "./BaseCliAgent";
import type { BaseCliAgentOptions } from "./BaseCliAgent";

type KimiAgentOptions = BaseCliAgentOptions & {
  workDir?: string;
  session?: string;
  continue?: boolean;
  thinking?: boolean;
  outputFormat?: "text" | "stream-json";
  finalMessageOnly?: boolean;
  quiet?: boolean;
  agent?: "default" | "okabe";
  agentFile?: string;
  mcpConfigFile?: string[];
  mcpConfig?: string[];
  skillsDir?: string;
  maxStepsPerTurn?: number;
  maxRetriesPerStep?: number;
  maxRalphIterations?: number;
  verbose?: boolean;
  debug?: boolean;
};

export class KimiAgent extends BaseCliAgent {
  private readonly opts: KimiAgentOptions;
  readonly cliEngine = "kimi";
  private issuedSessionId?: string;

  constructor(opts: KimiAgentOptions = {}) {
    super(opts);
    this.opts = opts;
  }

  protected createOutputInterpreter(): CliOutputInterpreter {
    let emittedStarted = false;
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

    const toolKindForKimi = (name: string | undefined): AgentCliActionKind => {
      const normalized = (name ?? "").toLowerCase();
      if (!normalized) return "tool";
      if (normalized.includes("shell") || normalized.includes("bash") || normalized.includes("command")) {
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

      const role = asString(payload.role);
      const events: AgentCliEvent[] = [];

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
          if (!isRecord(toolCall)) continue;
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
              kind: toolKindForKimi(name),
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
      onExit: (result) => [{
        type: "completed",
        engine: this.cliEngine,
        ok: !result.exitCode || result.exitCode === 0,
        answer: finalAnswer || undefined,
        error:
          result.exitCode && result.exitCode !== 0
            ? result.stderr.trim() || `Kimi exited with code ${result.exitCode}`
            : undefined,
        resume: this.issuedSessionId,
      }],
    };
  }

  protected async buildCommand(params: {
    prompt: string;
    systemPrompt?: string;
    cwd: string;
    options: any;
  }) {
    const args: string[] = [];
    let commandEnv: Record<string, string> | undefined;
    let cleanup: (() => Promise<void>) | undefined;

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
            } catch {
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
    if (finalMessageOnly) args.push("--final-message-only");

    // Other flags
    const resumeSession = typeof params.options?.resumeSession === "string"
      ? params.options.resumeSession
      : undefined;
    const sessionId = resumeSession ?? this.opts.session ?? randomUUID();
    this.issuedSessionId = sessionId;

    pushFlag(args, "--work-dir", this.opts.workDir ?? params.cwd);
    pushFlag(args, "--session", sessionId);
    if (this.opts.continue) args.push("--continue");
    pushFlag(args, "--model", this.opts.model ?? this.model);
    const thinking = this.opts.thinking ?? true;
    args.push(thinking ? "--thinking" : "--no-thinking");
    if (this.opts.finalMessageOnly) args.push("--final-message-only");
    if (this.opts.quiet) args.push("--quiet");
    pushFlag(args, "--agent", this.opts.agent);
    pushFlag(args, "--agent-file", this.opts.agentFile);
    pushList(args, "--mcp-config-file", this.opts.mcpConfigFile);
    pushList(args, "--mcp-config", this.opts.mcpConfig);
    pushFlag(args, "--skills-dir", this.opts.skillsDir);
    pushFlag(args, "--max-steps-per-turn", this.opts.maxStepsPerTurn);
    pushFlag(args, "--max-retries-per-step", this.opts.maxRetriesPerStep);
    pushFlag(args, "--max-ralph-iterations", this.opts.maxRalphIterations);
    if (this.opts.verbose) args.push("--verbose");
    if (this.opts.debug) args.push("--debug");

    if (this.extraArgs?.length) args.push(...this.extraArgs);

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
      errorOnBannerOnly: true,
    };
  }
}
