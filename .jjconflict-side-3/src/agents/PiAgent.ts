import type { GenerateTextResult } from "ai";
import { Effect } from "effect";
import {
  type AgentCliActionKind,
  type AgentCliEvent,
  BaseCliAgent,
  buildGenerateResult,
  combineNonEmpty,
  createAgentStdoutTextEmitter,
  type CliOutputInterpreter,
  extractPrompt,
  extractTextFromJsonValue,
  extractTextFromPiNdjson,
  pushFlag,
  resolveTimeouts,
  runCommandEffect,
  runRpcCommandEffect,
  tryParseJson,
} from "./BaseCliAgent";
import type {
  BaseCliAgentOptions,
  PiExtensionUiRequest,
  PiExtensionUiResponse,
} from "./BaseCliAgent";
import { fromPromise } from "../effect/interop";
import { runPromise } from "../effect/runtime";
import { getToolContext } from "../tools/context";
import { SmithersError } from "../utils/errors";
import { enrichReportWithErrorAnalysis, formatDiagnosticSummary, launchDiagnostics } from "./diagnostics";

export type { PiExtensionUiRequest, PiExtensionUiResponse };

export type PiAgentOptions = BaseCliAgentOptions & {
  provider?: string;
  model?: string;
  apiKey?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  mode?: "text" | "json" | "rpc";
  print?: boolean;
  continue?: boolean;
  resume?: boolean;
  session?: string;
  sessionDir?: string;
  noSession?: boolean;
  models?: string | string[];
  listModels?: boolean | string;
  tools?: string[];
  noTools?: boolean;
  extension?: string[];
  noExtensions?: boolean;
  skill?: string[];
  noSkills?: boolean;
  promptTemplate?: string[];
  noPromptTemplates?: boolean;
  theme?: string[];
  noThemes?: boolean;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  export?: string;
  files?: string[];
  verbose?: boolean;
  onExtensionUiRequest?: (request: PiExtensionUiRequest) =>
    | Promise<PiExtensionUiResponse | null>
    | PiExtensionUiResponse
    | null;
};

type PiMode = "text" | "json" | "rpc";
type PiNonRpcMode = Exclude<PiMode, "rpc">;

export class PiAgent extends BaseCliAgent {
  private readonly opts: PiAgentOptions;
  readonly cliEngine = "pi";
  private issuedSessionRef?: string;

  constructor(opts: PiAgentOptions = {}) {
    super(opts);
    this.opts = opts;
  }

  private resolveMode(options: any): PiMode {
    if (this.opts.mode === "rpc") return "rpc";
    if (options?.onEvent) return "json";
    return this.opts.mode ?? "text";
  }

  private buildArgs(params: {
    prompt: string;
    cwd: string;
    options: any;
    mode: PiMode;
  }): string[] {
    const args: string[] = [];
    const { systemFromMessages } = extractPrompt(params.options);
    const resumeSession = typeof params.options?.resumeSession === "string"
      ? params.options.resumeSession
      : undefined;
    const effectiveSession = resumeSession ?? this.opts.session;

    this.issuedSessionRef = effectiveSession;

    if (params.mode === "text") {
      if (this.opts.print !== false) args.push("--print");
    } else {
      args.push("--mode", params.mode);
    }

    pushFlag(args, "--provider", this.opts.provider);
    pushFlag(args, "--model", this.opts.model ?? this.model);
    pushFlag(args, "--api-key", this.opts.apiKey);
    pushFlag(args, "--system-prompt", this.systemPrompt);
    pushFlag(
      args,
      "--append-system-prompt",
      combineNonEmpty([this.opts.appendSystemPrompt, systemFromMessages]),
    );

    if (this.opts.continue) args.push("--continue");
    if (this.opts.resume) args.push("--resume");
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
      } else {
        args.push("--list-models");
      }
    }
    pushFlag(args, "--export", this.opts.export);

    if (this.opts.tools?.length) {
      args.push("--tools", this.opts.tools.join(","));
    }
    if (this.opts.noTools) args.push("--no-tools");

    if (this.opts.extension) {
      for (const value of this.opts.extension) {
        args.push("--extension", value);
      }
    }
    if (this.opts.noExtensions) args.push("--no-extensions");

    if (this.opts.skill) {
      for (const value of this.opts.skill) {
        args.push("--skill", value);
      }
    }
    if (this.opts.noSkills) args.push("--no-skills");

    if (this.opts.promptTemplate) {
      for (const value of this.opts.promptTemplate) {
        args.push("--prompt-template", value);
      }
    }
    if (this.opts.noPromptTemplates) args.push("--no-prompt-templates");

    if (this.opts.theme) {
      for (const value of this.opts.theme) {
        args.push("--theme", value);
      }
    }
    if (this.opts.noThemes) args.push("--no-themes");

    pushFlag(args, "--thinking", this.opts.thinking);
    if (this.opts.verbose) args.push("--verbose");
    if (this.extraArgs?.length) args.push(...this.extraArgs);

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

  protected createOutputInterpreter(): CliOutputInterpreter {
    let sessionId = this.issuedSessionRef;
    let emittedStarted = false;
    let finalAnswer = "";

    const asString = (value: unknown) =>
      typeof value === "string" ? value : undefined;

    const truncate = (value: string, maxLength = 400) =>
      value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;

    const summarizeValue = (value: unknown) => {
      if (value == null) return undefined;
      const text = extractTextFromJsonValue(value);
      if (text) return truncate(text);
      try {
        return truncate(JSON.stringify(value));
      } catch {
        return truncate(String(value));
      }
    };

    const toolKindForPi = (name: string | undefined): AgentCliActionKind => {
      const normalized = (name ?? "").toLowerCase();
      if (!normalized) return "tool";
      if (normalized.includes("bash") || normalized.includes("shell") || normalized.includes("command")) {
        return "command";
      }
      if (normalized.includes("search") || normalized.includes("web")) {
        return "web_search";
      }
      if (normalized.includes("todo") || normalized.includes("plan")) {
        return "todo_list";
      }
      if (normalized.includes("write") || normalized.includes("edit") || normalized.includes("file")) {
        return "file_change";
      }
      return "tool";
    };

    const startedEvents = (detail?: Record<string, unknown>): AgentCliEvent[] => {
      if (emittedStarted || !sessionId) return [];
      emittedStarted = true;
      return [{
        type: "started",
        engine: this.cliEngine,
        title: "PI",
        resume: sessionId,
        detail,
      }];
    };

    const parseLine = (line: string): AgentCliEvent[] => {
      const trimmed = line.trim();
      if (!trimmed) return [];

      let payload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return [];
        }
        payload = parsed as Record<string, unknown>;
      } catch {
        return [];
      }

      const type = asString(payload.type);
      if (!type) return [];

      if (type === "session") {
        sessionId = asString(payload.id) ?? sessionId;
        return startedEvents({
          cwd: asString(payload.cwd),
          version: payload.version,
        });
      }

      if (type === "message_update") {
        const assistantEvent = (payload as any).assistantMessageEvent as
          | { type?: string; delta?: string }
          | undefined;
        if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
          finalAnswer += assistantEvent.delta;
        }
        return startedEvents();
      }

      if (type === "message_end" || type === "turn_end") {
        const message = (payload as any).message as { role?: string; content?: unknown } | undefined;
        if (message?.role === "assistant") {
          const extracted = extractTextFromJsonValue(message);
          if (extracted) {
            finalAnswer = extracted;
          }
        }
        return startedEvents();
      }

      if (type === "tool_execution_start") {
        const toolName = asString((payload as any).toolName) ?? "tool";
        const toolId = asString((payload as any).toolCallId) ?? toolName;
        return [
          ...startedEvents(),
          {
            type: "action",
            engine: this.cliEngine,
            phase: "started",
            entryType: "thought",
            action: {
              id: toolId,
              kind: toolKindForPi(toolName),
              title: toolName,
              detail: {
                args: (payload as any).args,
              },
            },
            message: `Running ${toolName}`,
            level: "info",
          },
        ];
      }

      if (type === "tool_execution_update") {
        const toolName = asString((payload as any).toolName) ?? "tool";
        const toolId = asString((payload as any).toolCallId) ?? toolName;
        return [
          ...startedEvents(),
          {
            type: "action",
            engine: this.cliEngine,
            phase: "updated",
            entryType: "thought",
            action: {
              id: toolId,
              kind: toolKindForPi(toolName),
              title: toolName,
              detail: {
                args: (payload as any).args,
              },
            },
            message: summarizeValue((payload as any).partialResult),
            level: "info",
          },
        ];
      }

      if (type === "tool_execution_end") {
        const toolName = asString((payload as any).toolName) ?? "tool";
        const toolId = asString((payload as any).toolCallId) ?? toolName;
        const ok = (payload as any).isError !== true;
        return [
          ...startedEvents(),
          {
            type: "action",
            engine: this.cliEngine,
            phase: "completed",
            entryType: "thought",
            action: {
              id: toolId,
              kind: toolKindForPi(toolName),
              title: toolName,
              detail: {
                result: summarizeValue((payload as any).result),
              },
            },
            message: summarizeValue((payload as any).result),
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
            type: "completed" as const,
            engine: this.cliEngine,
            ok: !result.exitCode || result.exitCode === 0,
            answer: finalAnswer || undefined,
            error:
              result.exitCode && result.exitCode !== 0
                ? result.stderr.trim() || `PI exited with code ${result.exitCode}`
                : undefined,
            resume: sessionId,
          },
        ];
      },
    };
  }

  async generate(options: any): Promise<GenerateTextResult<any, any>> {
    const { prompt } = extractPrompt(options);
    const callTimeouts = resolveTimeouts(options?.timeout, {
      totalMs: this.timeoutMs,
      idleMs: this.idleTimeoutMs,
    });
    const cwd = this.cwd ?? getToolContext()?.rootDir ?? process.cwd();
    const env = { ...process.env, ...(this.env ?? {}) } as Record<string, string>;
    const mode = this.resolveMode(options);

    if (mode === "rpc" && this.opts.files?.length) {
      throw new SmithersError("AGENT_RPC_FILE_ARGS", "RPC mode does not support file arguments");
    }

    const args = this.buildArgs({ prompt, cwd, options, mode });
    const diagnosticsPromise = launchDiagnostics("pi", env, cwd);

    const interpreter = this.createOutputInterpreter();
    const emitEvents = (
      payload: AgentCliEvent[] | AgentCliEvent | null | undefined,
    ) => {
      if (!payload || !options?.onEvent) return;
      const events = Array.isArray(payload) ? payload : [payload];
      for (const event of events) {
        void Promise.resolve(options.onEvent(event)).catch(() => undefined);
      }
    };

    const diagnosticsEnrichment = (err: Error) =>
      fromPromise("enrich diagnostics", async () => {
        if (!diagnosticsPromise) return;
        const report = await diagnosticsPromise.catch(() => null);
        if (report && err instanceof SmithersError) {
          enrichReportWithErrorAnalysis(report, err.message);
          err.details = { ...err.details, diagnostics: report };
          console.warn(formatDiagnosticSummary(report));
        }
      }).pipe(Effect.ignore);

    if (mode !== "rpc") {
      const stdoutEmitter = createAgentStdoutTextEmitter({
        outputFormat: mode,
        onText: options?.onStdout,
      });
      let stdoutBuffer = "";
      let stderrBuffer = "";

      const flushBufferedLines = (
        stream: "stdout" | "stderr",
        includePartial: boolean,
      ) => {
        let buffer = stream === "stdout" ? stdoutBuffer : stderrBuffer;
        const lines = buffer.split("\n");
        if (!includePartial) {
          buffer = lines.pop() ?? "";
        } else {
          buffer = "";
        }

        for (const line of lines) {
          if (!line) continue;
          emitEvents(
            stream === "stdout"
              ? interpreter.onStdoutLine?.(line)
              : interpreter.onStderrLine?.(line),
          );
        }

        if (stream === "stdout") {
          stdoutBuffer = buffer;
        } else {
          stderrBuffer = buffer;
        }
      };

      const handleInterpreterChunk = (
        stream: "stdout" | "stderr",
        chunk: string,
      ) => {
        if (!chunk) return;
        if (stream === "stdout") {
          stdoutBuffer += chunk;
        } else {
          stderrBuffer += chunk;
        }
        flushBufferedLines(stream, false);
      };

      const nonRpcProgram = Effect.gen(this, function* () {
        const result = yield* runCommandEffect("pi", args, {
          cwd,
          env,
          timeoutMs: callTimeouts.totalMs,
          idleTimeoutMs: callTimeouts.idleMs,
          signal: options?.abortSignal,
          maxOutputBytes: this.maxOutputBytes ?? getToolContext()?.maxOutputBytes,
          onStdout: (chunk) => {
            stdoutEmitter.push(chunk);
            handleInterpreterChunk("stdout", chunk);
          },
          onStderr: (chunk) => {
            options?.onStderr?.(chunk);
            handleInterpreterChunk("stderr", chunk);
          },
        });

        flushBufferedLines("stdout", true);
        flushBufferedLines("stderr", true);
        emitEvents(interpreter.onExit?.(result));

        if (result.exitCode && result.exitCode !== 0) {
          return yield* Effect.fail(new SmithersError(
            "AGENT_CLI_ERROR",
            result.stderr.trim() || result.stdout.trim() || `CLI exited with code ${result.exitCode}`,
          ));
        }

        const rawText = result.stdout.trim();
        const extractedText = mode === "json"
          ? (extractTextFromPiNdjson(rawText) ?? rawText)
          : rawText;
        stdoutEmitter.flush(extractedText);
        const output = tryParseJson(extractedText);
        return buildGenerateResult(extractedText, output, this.opts.model ?? "pi");
      }).pipe(
        Effect.ensuring(Effect.sync(() => { stdoutEmitter.flush(); })),
        Effect.tapError(diagnosticsEnrichment),
      );

      return runPromise(nonRpcProgram);
    }

    const rpcProgram = Effect.gen(this, function* () {
      const rpcResult = yield* runRpcCommandEffect("pi", args, {
        cwd,
        env,
        prompt,
        timeoutMs: callTimeouts.totalMs,
        idleTimeoutMs: callTimeouts.idleMs,
        signal: options?.abortSignal,
        maxOutputBytes: this.maxOutputBytes ?? getToolContext()?.maxOutputBytes,
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

      return buildGenerateResult(
        rpcResult.text,
        rpcResult.output,
        this.opts.model ?? "pi",
        rpcResult.usage,
      );
    }).pipe(
      Effect.tapError(diagnosticsEnrichment),
    );

    return runPromise(rpcProgram);
  }

  protected async buildCommand(params: {
    prompt: string;
    systemPrompt?: string;
    cwd: string;
    options: any;
  }): Promise<{
    command: string;
    args: string[];
    stdin?: string;
    outputFormat?: string;
    outputFile?: string;
    cleanup?: () => Promise<void>;
  }> {
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
