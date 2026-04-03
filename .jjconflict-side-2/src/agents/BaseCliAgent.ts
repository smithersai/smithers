import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import { Effect, Metric } from "effect";
import type {
  Agent,
  GenerateTextResult,
  StreamTextResult,
  ModelMessage,
} from "ai";
import { spawnCaptureEffect } from "../effect/child-process";
import { fromPromise } from "../effect/interop";
import { runPromise } from "../effect/runtime";
import { logDebug, logWarning } from "../effect/logging";
import { toolOutputTruncatedTotal } from "../effect/metrics";
import { getToolContext } from "../tools/context";
import { SmithersError, toSmithersError } from "../utils/errors";
import { launchDiagnostics, enrichReportWithErrorAnalysis, formatDiagnosticSummary } from "./diagnostics";

type TimeoutInput = number | { totalMs?: number; idleMs?: number } | undefined;

export type BaseCliAgentOptions = {
  id?: string;
  model?: string;
  systemPrompt?: string;
  instructions?: string;
  cwd?: string;
  env?: Record<string, string>;
  yolo?: boolean;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxOutputBytes?: number;
  extraArgs?: string[];
};

// PiExtensionUiRequest is defined here because RunRpcCommandOptions references it.
// It is re-exported from PiAgent.ts for the public API barrel.
export type PiExtensionUiRequest = {
  type: "extension_ui_request";
  id: string;
  method: string;
  title?: string;
  placeholder?: string;
  [key: string]: unknown;
};

export type PiExtensionUiResponse = {
  type: "extension_ui_response";
  id: string;
  value?: string;
  cancelled?: boolean;
  [key: string]: unknown;
};

type RunRpcCommandOptions = {
  cwd: string;
  env: Record<string, string>;
  prompt: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onJsonEvent?: (event: Record<string, unknown>) => Promise<void> | void;
  onExtensionUiRequest?: (request: PiExtensionUiRequest) =>
    | Promise<PiExtensionUiResponse | null>
    | PiExtensionUiResponse
    | null;
};

type PromptParts = {
  prompt: string;
  systemFromMessages?: string;
};

type RunCommandOptions = {
  cwd: string;
  env: Record<string, string>;
  input?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export type RunCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

type CliCommandSpec = {
  command: string;
  args: string[];
  stdin?: string;
  outputFormat?: string;
  outputFile?: string;
  cleanup?: () => Promise<void>;
  env?: Record<string, string>;
  stdoutBannerPatterns?: RegExp[];
  stdoutErrorPatterns?: RegExp[];
  errorOnBannerOnly?: boolean;
};

export type AgentCliActionKind =
  | "turn"
  | "command"
  | "tool"
  | "file_change"
  | "web_search"
  | "todo_list"
  | "reasoning"
  | "warning"
  | "note";

export type AgentCliActionPhase = "started" | "updated" | "completed";
export type AgentCliEventLevel = "debug" | "info" | "warning" | "error";

export type AgentCliStartedEvent = {
  type: "started";
  engine: string;
  title: string;
  resume?: string;
  detail?: Record<string, unknown>;
};

export type AgentCliActionEvent = {
  type: "action";
  engine: string;
  phase: AgentCliActionPhase;
  entryType?: "thought" | "message";
  action: {
    id: string;
    kind: AgentCliActionKind;
    title: string;
    detail?: Record<string, unknown>;
  };
  message?: string;
  ok?: boolean;
  level?: AgentCliEventLevel;
};

export type AgentCliCompletedEvent = {
  type: "completed";
  engine: string;
  ok: boolean;
  answer?: string;
  error?: string;
  resume?: string;
  usage?: Record<string, unknown>;
};

export type AgentCliEvent =
  | AgentCliStartedEvent
  | AgentCliActionEvent
  | AgentCliCompletedEvent;

export type CliOutputInterpreter = {
  onStdoutLine?: (line: string) => AgentCliEvent[] | AgentCliEvent | null | undefined;
  onStderrLine?: (line: string) => AgentCliEvent[] | AgentCliEvent | null | undefined;
  onExit?: (result: RunCommandResult) => AgentCliEvent[] | AgentCliEvent | null | undefined;
};

export function isBlockingAgentActionKind(kind: AgentCliActionKind): boolean {
  return kind === "command" || kind === "tool" || kind === "web_search";
}

export function resolveTimeouts(
  timeout: TimeoutInput,
  fallback?: { totalMs?: number; idleMs?: number },
): { totalMs?: number; idleMs?: number } {
  if (typeof timeout === "number") {
    return { totalMs: timeout };
  }
  if (timeout && typeof timeout === "object") {
    return {
      totalMs: typeof timeout.totalMs === "number" ? timeout.totalMs : fallback?.totalMs,
      idleMs: typeof timeout.idleMs === "number" ? timeout.idleMs : fallback?.idleMs,
    };
  }
  return {
    totalMs: fallback?.totalMs,
    idleMs: fallback?.idleMs,
  };
}

export function combineNonEmpty(parts: Array<string | undefined>): string | undefined {
  const filtered = parts.map((part) => (part ?? "").trim()).filter(Boolean);
  return filtered.length ? filtered.join("\n\n") : undefined;
}

function contentToText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          if (typeof part.text === "string") return part.text;
          if (typeof part.content === "string") return part.content;
        }
        return "";
      })
      .join("");
  }
  if (content == null) return "";
  return String(content);
}

export function extractPrompt(options: any): PromptParts {
  if (!options) return { prompt: "" };
  if ("prompt" in options) {
    const promptInput = options.prompt;
    if (typeof promptInput === "string") {
      return { prompt: promptInput };
    }
    if (Array.isArray(promptInput)) {
      return messagesToPrompt(promptInput as ModelMessage[]);
    }
    return { prompt: "" };
  }
  if (Array.isArray(options.messages)) {
    return messagesToPrompt(options.messages as ModelMessage[]);
  }
  return { prompt: "" };
}

function messagesToPrompt(messages: ModelMessage[]): PromptParts {
  const systemParts: string[] = [];
  const promptParts: string[] = [];
  for (const msg of messages) {
    const text = contentToText((msg as any).content);
    if (!text) continue;
    const role = (msg as any).role;
    if (role === "system") {
      systemParts.push(text);
      continue;
    }
    if (role) {
      promptParts.push(`${String(role).toUpperCase()}: ${text}`);
    } else {
      promptParts.push(text);
    }
  }
  return {
    prompt: promptParts.join("\n\n"),
    systemFromMessages: systemParts.length
      ? systemParts.join("\n\n")
      : undefined,
  };
}

export function tryParseJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function extractTextFromJsonValue(value: any): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) {
    const parts = value.content
      .map((part: any) => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (typeof part.text === "string") return part.text;
        if (typeof part.content === "string") return part.content;
        return "";
      })
      .join("");
    if (parts.trim()) return parts;
  }
  if (value.response) return extractTextFromJsonValue(value.response);
  if (value.message) return extractTextFromJsonValue(value.message);
  if (value.result) return extractTextFromJsonValue(value.result);
  if (value.output) return extractTextFromJsonValue(value.output);
  if (value.data) return extractTextFromJsonValue(value.data);
  return undefined;
}

function extractTextFromJsonPayload(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return extractTextFromJsonValue(parsed);
  } catch {
    // Possibly JSONL
  }
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  const chunks: string[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const text = extractTextFromJsonValue(parsed);
      if (text) chunks.push(text);
    } catch {
      continue;
    }
  }
  return chunks.length ? chunks.join("") : undefined;
}

export function extractTextFromPiNdjson(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  let turnEndMessage: any = null;
  let agentEndMessage: any = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!);
      if (parsed.type === "turn_end" && parsed.message?.role === "assistant") {
        turnEndMessage = parsed.message;
        break;
      }
      if (parsed.type === "agent_end" && Array.isArray(parsed.messages)) {
        for (let j = parsed.messages.length - 1; j >= 0; j--) {
          const msg = parsed.messages[j];
          if (msg?.role === "assistant") {
            agentEndMessage = msg;
            break;
          }
        }
        if (agentEndMessage) break;
      }
    } catch {
      continue;
    }
  }

  const message = turnEndMessage ?? agentEndMessage;
  if (message) {
    const text = extractTextFromJsonValue(message);
    if (text) return text;
  }

  return extractTextFromJsonPayload(raw);
}

type AgentStdoutTextEmitterOptions = {
  outputFormat?: string;
  onText?: (text: string) => void;
};

type AgentStdoutTextEmitter = {
  push: (chunk: string) => void;
  flush: (finalText?: string) => void;
};

function extractLastAssistantMessage(messages: unknown): unknown | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as any;
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function extractCliStreamTextChunks(
  parsed: any,
  state: { sawDeltaSinceBoundary: boolean },
): string[] {
  const chunks: string[] = [];

  const emitDelta = (text: string | undefined) => {
    if (!text) return;
    state.sawDeltaSinceBoundary = true;
    chunks.push(text);
  };

  const emitFinal = (text: string | undefined) => {
    if (text && !state.sawDeltaSinceBoundary) {
      chunks.push(text);
    }
    state.sawDeltaSinceBoundary = false;
  };

  const type = typeof parsed?.type === "string" ? parsed.type : "";
  const upperType = type.toUpperCase();

  if (type === "content_block_delta" && parsed?.delta?.type === "text_delta") {
    emitDelta(typeof parsed.delta.text === "string" ? parsed.delta.text : undefined);
  }

  if (type === "message_update") {
    const assistantEvent = parsed?.assistantMessageEvent;
    if (
      assistantEvent?.type === "text_delta" &&
      typeof assistantEvent.delta === "string"
    ) {
      emitDelta(assistantEvent.delta);
    }
  }

  if (/delta/i.test(type) && type !== "content_block_delta" && type !== "message_update") {
    if (typeof parsed?.delta === "string") {
      emitDelta(parsed.delta);
    } else if (typeof parsed?.delta?.text === "string") {
      emitDelta(parsed.delta.text);
    } else if (typeof parsed?.text === "string") {
      emitDelta(parsed.text);
    }
  }

  if (type === "message" && parsed?.role === "assistant") {
    emitFinal(extractTextFromJsonValue(parsed.content ?? parsed.message ?? parsed));
  }

  if (upperType === "MESSAGE" && parsed?.role === "assistant") {
    if (parsed?.delta === true && typeof parsed?.content === "string") {
      emitDelta(parsed.content);
    } else {
      emitFinal(extractTextFromJsonValue(parsed.content ?? parsed.message ?? parsed));
    }
  }

  if (parsed?.role === "assistant" && typeof parsed?.content === "string") {
    emitFinal(parsed.content);
  }

  if (type === "assistant" && parsed?.message?.role === "assistant") {
    emitFinal(extractTextFromJsonValue(parsed.message));
  }

  if (type === "result") {
    emitFinal(extractTextFromJsonValue(parsed.result ?? parsed.response ?? parsed.output ?? parsed));
  }

  if (type === "turn_end" && parsed?.message?.role === "assistant") {
    emitFinal(extractTextFromJsonValue(parsed.message));
  }

  if (type === "message_end" && parsed?.message?.role === "assistant") {
    emitFinal(extractTextFromJsonValue(parsed.message));
  }

  if (type === "agent_end") {
    emitFinal(extractTextFromJsonValue(extractLastAssistantMessage(parsed.messages)));
  }

  if (
    type === "message_stop" ||
    type === "turn.completed" ||
    type === "turn_end" ||
    type === "message_end" ||
    type === "agent_end" ||
    type === "result"
  ) {
    state.sawDeltaSinceBoundary = false;
  }

  return chunks;
}

export function createAgentStdoutTextEmitter(
  options: AgentStdoutTextEmitterOptions,
): AgentStdoutTextEmitter {
  const { outputFormat, onText } = options;
  let buffer = "";
  let emittedAnyText = false;
  const state = { sawDeltaSinceBoundary: false };

  const emitText = (text: string | undefined) => {
    if (!onText || !text) return;
    emittedAnyText = true;
    onText(text);
  };

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    for (const chunk of extractCliStreamTextChunks(parsed, state)) {
      emitText(chunk);
    }
  };

  return {
    push(chunk: string) {
      if (!onText || !chunk) return;
      if (!outputFormat || outputFormat === "text") {
        emitText(chunk);
        return;
      }

      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        processLine(line);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    flush(finalText?: string) {
      if (!onText) return;
      if (outputFormat && outputFormat !== "text" && buffer.trim()) {
        processLine(buffer);
      }
      buffer = "";
      if (!emittedAnyText && finalText) {
        emitText(finalText);
      }
    },
  };
}

export function truncateToBytes(text: string, maxBytes?: number): string {
  if (!maxBytes || maxBytes <= 0) return text;
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf8");
}

export type CliUsageInfo = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
};

/**
 * Extract token usage from raw CLI stdout. Each CLI harness reports usage
 * differently:
 *  - Claude Code stream-json: `message_start` has input, `message_delta` has output
 *  - Codex --json: `turn.completed` has usage
 *  - Gemini json: top-level `stats.models` with per-model tokens
 *  - Generic: any NDJSON line with a `usage` object
 */
export function extractUsageFromOutput(raw: string): CliUsageInfo | undefined {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const usage: CliUsageInfo = {};
  let found = false;

  for (const line of lines) {
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== "object") continue;

    // Claude Code stream-json: message_start contains input token counts
    if (parsed.type === "message_start" && parsed.message?.usage) {
      const u = parsed.message.usage;
      usage.inputTokens = (usage.inputTokens ?? 0) + (u.input_tokens ?? 0);
      if (u.cache_read_input_tokens) {
        usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + u.cache_read_input_tokens;
      }
      if (u.cache_creation_input_tokens) {
        usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + u.cache_creation_input_tokens;
      }
      found = true;
      continue;
    }

    // Claude Code stream-json: message_delta has output token count
    if (parsed.type === "message_delta" && parsed.usage) {
      if (parsed.usage.output_tokens) {
        usage.outputTokens = (usage.outputTokens ?? 0) + parsed.usage.output_tokens;
      }
      found = true;
      continue;
    }

    // Codex --json: turn.completed event
    if (parsed.type === "turn.completed" && parsed.usage) {
      const u = parsed.usage;
      if (u.input_tokens) usage.inputTokens = (usage.inputTokens ?? 0) + u.input_tokens;
      if (u.output_tokens) usage.outputTokens = (usage.outputTokens ?? 0) + u.output_tokens;
      if (u.cached_input_tokens) usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + u.cached_input_tokens;
      found = true;
      continue;
    }

    // Generic: any event with a top-level "usage" containing token fields
    if (parsed.usage && typeof parsed.usage === "object") {
      const u = parsed.usage;
      const inTok = u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? 0;
      const outTok = u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? 0;
      if (inTok > 0 || outTok > 0) {
        usage.inputTokens = (usage.inputTokens ?? 0) + inTok;
        usage.outputTokens = (usage.outputTokens ?? 0) + outTok;
        if (u.cache_read_input_tokens || u.cacheReadTokens || u.cached_input_tokens) {
          usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) +
            (u.cache_read_input_tokens ?? u.cacheReadTokens ?? u.cached_input_tokens ?? 0);
        }
        if (u.reasoning_tokens ?? u.reasoningTokens) {
          usage.reasoningTokens = (usage.reasoningTokens ?? 0) +
            (u.reasoning_tokens ?? u.reasoningTokens ?? 0);
        }
        found = true;
        continue;
      }
    }
  }

  // Gemini JSON output: single result object with stats.models map
  if (!found) {
    try {
      const parsed = JSON.parse(raw.trim());
      if (parsed?.stats?.models && typeof parsed.stats.models === "object") {
        for (const data of Object.values(parsed.stats.models as Record<string, any>)) {
          if (data?.tokens) {
            usage.inputTokens = (usage.inputTokens ?? 0) + (data.tokens.input ?? data.tokens.prompt ?? 0);
            usage.outputTokens = (usage.outputTokens ?? 0) + (data.tokens.output ?? 0);
            found = true;
          }
        }
      }
    } catch { /* not single JSON */ }
  }

  return found ? usage : undefined;
}

function createOneShotTimer(timeoutMs: number | undefined, onTimeout: () => void) {
  if (!timeoutMs || !Number.isFinite(timeoutMs)) {
    return { clear: () => {} };
  }
  const timer = setTimeout(onTimeout, timeoutMs);
  return {
    clear: () => clearTimeout(timer),
  };
}

function createInactivityTimer(timeoutMs: number | undefined, onTimeout: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (!timeoutMs || !Number.isFinite(timeoutMs)) {
    return {
      reset: () => {},
      clear: () => {},
    };
  }

  const reset = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onTimeout, timeoutMs);
  };

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  reset();
  return { reset, clear };
}

function emptyUsage() {
  return {
    inputTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: undefined,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
    totalTokens: undefined,
  };
}

export function buildGenerateResult(
  text: string,
  output: unknown,
  modelId: string,
  usage?: any,
): GenerateTextResult<any, any> {
  const finalUsage = usage ?? emptyUsage();
  return {
    content: [{ type: "text", text }],
    text,
    reasoning: [],
    reasoningText: undefined,
    files: [],
    sources: [],
    toolCalls: [],
    staticToolCalls: [],
    dynamicToolCalls: [],
    toolResults: [],
    staticToolResults: [],
    dynamicToolResults: [],
    finishReason: "stop",
    rawFinishReason: undefined,
    usage: finalUsage,
    totalUsage: finalUsage,
    warnings: undefined,
    request: {},
    response: {
      id: randomUUID(),
      timestamp: new Date(),
      modelId,
      messages: [],
    },
    providerMetadata: undefined,
    steps: [],
    experimental_output: output as any,
    output: output as any,
  } as GenerateTextResult<any, any>;
}

function asyncIterableToStream<T>(
  iterable: AsyncIterable<T>,
): ReadableStream<T> & AsyncIterable<T> {
  const stream = new ReadableStream<T>({
    async start(controller) {
      try {
        for await (const item of iterable) {
          controller.enqueue(item);
        }
      } catch (err) {
        controller.error(err);
        return;
      }
      controller.close();
    },
  });
  (stream as any)[Symbol.asyncIterator] =
    iterable[Symbol.asyncIterator].bind(iterable);
  return stream as any;
}

export function buildStreamResult(
  result: GenerateTextResult<any, any>,
): StreamTextResult<any, any> {
  const text = result.text ?? "";
  const content = result.content ?? [];
  const steps = result.steps ?? [];
  const usage = result.usage ?? emptyUsage();
  const totalUsage = result.totalUsage ?? usage;
  const response = result.response ?? {
    id: randomUUID(),
    timestamp: new Date(),
    modelId: "unknown",
    messages: [],
  };
  const request = result.request ?? {};

  const textStream = asyncIterableToStream<string>(
    (async function* () {
      if (text) yield text;
    })(),
  );
  const fullStream = asyncIterableToStream<any>(
    (async function* () {
      const id = randomUUID();
      yield { type: "text-start", id };
      if (text) {
        yield { type: "text-delta", id, text };
      }
      yield { type: "text-end", id };
    })(),
  );

  return {
    content: Promise.resolve(content),
    text: Promise.resolve(text),
    reasoning: Promise.resolve(result.reasoning ?? []),
    reasoningText: Promise.resolve(result.reasoningText),
    files: Promise.resolve(result.files ?? []),
    sources: Promise.resolve(result.sources ?? []),
    toolCalls: Promise.resolve(result.toolCalls ?? []),
    staticToolCalls: Promise.resolve(result.staticToolCalls ?? []),
    dynamicToolCalls: Promise.resolve(result.dynamicToolCalls ?? []),
    staticToolResults: Promise.resolve(result.staticToolResults ?? []),
    dynamicToolResults: Promise.resolve(result.dynamicToolResults ?? []),
    toolResults: Promise.resolve(result.toolResults ?? []),
    finishReason: Promise.resolve(result.finishReason ?? "stop"),
    rawFinishReason: Promise.resolve(result.rawFinishReason),
    usage: Promise.resolve(usage),
    totalUsage: Promise.resolve(totalUsage),
    warnings: Promise.resolve(result.warnings),
    steps: Promise.resolve(steps),
    request: Promise.resolve(request),
    response: Promise.resolve(response),
    providerMetadata: Promise.resolve(result.providerMetadata),
    textStream: textStream as any,
    fullStream: fullStream as any,
  } as unknown as StreamTextResult<any, any>;
}

export function runCommandEffect(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Effect.Effect<RunCommandResult, SmithersError> {
  const {
    cwd,
    env,
    input,
    timeoutMs,
    idleTimeoutMs,
    signal,
    maxOutputBytes,
    onStdout,
    onStderr,
  } = options;
  return spawnCaptureEffect(command, args, {
    cwd,
    env,
    input,
    signal,
    timeoutMs,
    idleTimeoutMs,
    maxOutputBytes,
    onStdout,
    onStderr,
  }).pipe(
    Effect.annotateLogs({
      agentCommand: command,
      agentArgs: args.join(" "),
      cwd,
    }),
    Effect.withLogSpan(`agent:${command}`),
  );
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<RunCommandResult> {
  return runPromise(runCommandEffect(command, args, options));
}

export function runRpcCommandEffect(command: string, args: string[], options: RunRpcCommandOptions): Effect.Effect<{
   text: string;
   output: unknown;
   stderr: string;
   exitCode: number | null;
   usage?: any;
 }, SmithersError> {
   const {
     cwd,
     env,
     prompt,
     timeoutMs,
     idleTimeoutMs,
     signal,
     maxOutputBytes,
     onStdout,
     onStderr,
     onJsonEvent,
     onExtensionUiRequest,
   } = options;
   const span = `agent:${command}:rpc`;
   const logAnnotations = {
     agentCommand: command,
     agentArgs: args.join(" "),
     cwd,
     rpc: true,
     timeoutMs: timeoutMs ?? null,
     idleTimeoutMs: idleTimeoutMs ?? null,
   };
   return Effect.async<{
     text: string;
     output: unknown;
     stderr: string;
     exitCode: number | null;
     usage?: any;
   }, SmithersError>((resume) => {
     let stderr = "";
     let settled = false;
     let exitCode: number | null = null;
     let textDeltas = "";
     let streamedAnyText = false;
     let finalMessage: unknown | null = null;
     let promptResponseError: string | null = null;
     let extractedUsage: any = undefined;
     let stderrTruncated = false;

     logDebug("starting agent RPC command", logAnnotations, span);
 
     const child = spawn(command, args, {
       cwd,
       env,
       stdio: ["pipe", "pipe", "pipe"],
     });
 
     const rl = createInterface({ input: child.stdout });

     const makeAgentCliError = (
       message: string,
       details?: Record<string, unknown>,
       cause?: unknown,
     ) =>
       new SmithersError(
         "AGENT_CLI_ERROR",
         message,
         {
           agentArgs: args,
           agentCommand: command,
           cwd,
           ...details,
         },
         { cause },
       );
 
     const handleError = (
       err: SmithersError,
       message = "agent RPC command failed",
     ) => {
       if (settled) return;
       settled = true;
       logWarning(
         message,
         {
           ...logAnnotations,
           error: err.message,
         },
         span,
       );
       try {
         rl.close();
       } catch {
         // ignore
       }
       resume(Effect.fail(err));
     };

     const finalize = (text: string, output: unknown) => {
       if (settled) return;
       settled = true;
       logDebug(
         "agent RPC command completed",
         {
           ...logAnnotations,
           exitCode: child.exitCode ?? exitCode,
           stderrBytes: Buffer.byteLength(stderr, "utf8"),
           textBytes: Buffer.byteLength(text, "utf8"),
         },
         span,
       );
       try {
         rl.close();
       } catch {
         // ignore
       }
       resume(Effect.succeed({ text, output, stderr, exitCode: child.exitCode, usage: extractedUsage }));
     };

     const terminateChild = () => {
       try {
         child.kill("SIGTERM");
       } catch {
         // ignore
       }
       const killTimer = setTimeout(() => {
         try {
           child.kill("SIGKILL");
         } catch {
           // ignore
         }
       }, 250);
       child.once("close", () => clearTimeout(killTimer));
     };
 
     const kill = (reason: string) => {
       terminateChild();
       handleError(makeAgentCliError(reason), "agent RPC command interrupted");
     };

     const totalTimeout = createOneShotTimer(timeoutMs, () =>
       kill(`CLI timed out after ${timeoutMs}ms`),
     );
     const inactivity = createInactivityTimer(idleTimeoutMs, () =>
       kill(`CLI idle timed out after ${idleTimeoutMs}ms`),
     );

     if (signal) {
       if (signal.aborted) {
         kill("CLI aborted");
       } else {
         signal.addEventListener("abort", () => kill("CLI aborted"), { once: true });
       }
     }
 
     const maybeWriteExtensionResponse = async (request: PiExtensionUiRequest) => {
       const needsResponse = ["select", "confirm", "input", "editor"].includes(request.method);
       if (!needsResponse && !onExtensionUiRequest) return;
 
       let response = onExtensionUiRequest ? await onExtensionUiRequest(request) : null;
       if (!response && needsResponse) {
         response = { type: "extension_ui_response", id: request.id, cancelled: true };
       }
       if (!response) return;
      const normalized = { ...response, id: request.id, type: "extension_ui_response" } as PiExtensionUiResponse;
      if (!child.stdin) {
        handleError(
          makeAgentCliError(
            "Failed to send extension UI response: child stdin is not available",
          ),
        );
        terminateChild();
        return;
      }
      child.stdin.write(`${JSON.stringify(normalized)}\n`);
     };
 
     const handleLine = async (line: string) => {
       inactivity.reset();
       let parsed: unknown;
       try {
         parsed = JSON.parse(line);
       } catch {
         return;
       }
       if (!parsed || typeof parsed !== "object") return;
       const event = parsed as Record<string, unknown>;
       void Promise.resolve(onJsonEvent?.(event)).catch(() => undefined);
       const type = event.type;
       if (type === "response" && event.command === "prompt" && event.success === false) {
         const errorMessage = typeof event.error === "string" ? event.error : "PI RPC prompt failed";
         promptResponseError = errorMessage;
         kill(errorMessage);
         return;
       }
       if (type === "message_update") {
         const assistantEvent = (event as any).assistantMessageEvent as { type?: string; delta?: string } | undefined;
         if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
           textDeltas += assistantEvent.delta;
           streamedAnyText = true;
           onStdout?.(assistantEvent.delta);
         }
       }
       if (type === "message_end") {
         const message = (event as any).message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
         if (message?.role === "assistant") {
           finalMessage = (event as any).message;
           if (message.stopReason === "error" || message.stopReason === "aborted") {
             promptResponseError = message.errorMessage || `Request ${message.stopReason}`;
           }
         }
       }
       if (event.usage) {
         extractedUsage = event.usage;
       }

       if (type === "turn_end") {
         const message = (event as any).message as { role?: string; stopReason?: string; errorMessage?: string; usage?: any } | undefined;
         if (message?.role === "assistant") {
           finalMessage = (event as any).message ?? finalMessage;
           if (message.usage) extractedUsage = message.usage;
           if (message.stopReason === "error" || message.stopReason === "aborted") {
             promptResponseError = message.errorMessage || `Request ${message.stopReason}`;
           }
           const extracted = finalMessage ? extractTextFromJsonValue(finalMessage) : undefined;
           const text = extracted ?? textDeltas;
           if (!streamedAnyText && text) {
             onStdout?.(text);
           }
           inactivity.clear();
           totalTimeout.clear();
           if (promptResponseError) {
             handleError(makeAgentCliError(promptResponseError));
             return;
           }
           finalize(text, finalMessage ?? text);
           child.stdin?.end();
           terminateChild();
         }
       }
       if (type === "extension_ui_request") {
         await maybeWriteExtensionResponse(event as PiExtensionUiRequest);
       }
     };
 
     let lineQueue = Promise.resolve();
     rl.on("line", (line) => {
       lineQueue = lineQueue.then(() => handleLine(line)).catch((err) => {
         handleError(
           err instanceof SmithersError
             ? err
             : toSmithersError(err, undefined, { code: "AGENT_CLI_ERROR" }),
         );
       });
     });

     child.stdout?.on("data", () => {
       inactivity.reset();
     });

     child.stderr?.on("data", (chunk) => {
       inactivity.reset();
       const text = chunk.toString("utf8");
       const nextStderr = stderr + text;
       if (!stderrTruncated && maxOutputBytes && Buffer.byteLength(nextStderr, "utf8") > maxOutputBytes) {
         stderrTruncated = true;
         void runPromise(Metric.increment(toolOutputTruncatedTotal));
         logWarning(
           "agent RPC stderr truncated",
           {
             ...logAnnotations,
             maxOutputBytes,
           },
           span,
         );
       }
       stderr = truncateToBytes(nextStderr, maxOutputBytes);
       onStderr?.(text);
     });

     child.on("error", (err) => {
       inactivity.clear();
       totalTimeout.clear();
       handleError(
         toSmithersError(err, undefined, {
           code: "AGENT_CLI_ERROR",
           details: {
             agentArgs: args,
             agentCommand: command,
             cwd,
           },
         }),
       );
     });

     child.on("close", (code) => {
       exitCode = code ?? null;
       inactivity.clear();
       totalTimeout.clear();
       if (settled) return;
       if (promptResponseError) {
         handleError(makeAgentCliError(promptResponseError));
         return;
       }
       if (code && code !== 0) {
         handleError(
           makeAgentCliError(stderr.trim() || `CLI exited with code ${code}`),
         );
         return;
       }
       const text = finalMessage ? extractTextFromJsonValue(finalMessage) ?? textDeltas : textDeltas;
       if (!streamedAnyText && text) {
         onStdout?.(text);
       }
       finalize(text ?? "", finalMessage ?? text ?? "");
     });
 
     const promptPayload = { id: randomUUID(), type: "prompt", message: prompt };
     if (!child.stdin) {
       handleError(
         makeAgentCliError(
           "Child process stdin is not available; cannot send prompt payload.",
         ),
       );
       return;
     }
     child.stdin.write(`${JSON.stringify(promptPayload)}\n`);
     return Effect.sync(() => {
       try {
         rl.close();
       } catch {
         // ignore
       }
       try {
         child.kill("SIGKILL");
       } catch {
         // ignore
       }
     });
   }).pipe(
     Effect.annotateLogs(logAnnotations),
     Effect.withLogSpan(span),
   );
}

export async function runRpcCommand(command: string, args: string[], options: RunRpcCommandOptions): Promise<{
   text: string;
   output: unknown;
   stderr: string;
   exitCode: number | null;
   usage?: any;
 }> {
   return runPromise(runRpcCommandEffect(command, args, options));
}

export abstract class BaseCliAgent implements Agent<any, any, any> {
  readonly version = "agent-v1" as const;
  readonly tools: Record<string, never> = {};
  readonly id: string;
  protected readonly model?: string;
  protected readonly systemPrompt?: string;
  protected readonly cwd?: string;
  protected readonly env?: Record<string, string>;
  protected readonly yolo: boolean;
  protected readonly timeoutMs?: number;
  protected readonly idleTimeoutMs?: number;
  protected readonly maxOutputBytes?: number;
  protected readonly extraArgs?: string[];

  constructor(opts: BaseCliAgentOptions) {
    this.id = opts.id ?? randomUUID();
    this.model = opts.model;
    this.systemPrompt = opts.systemPrompt ?? opts.instructions;
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.yolo = opts.yolo ?? true;
    this.timeoutMs = opts.timeoutMs;
    this.idleTimeoutMs = opts.idleTimeoutMs;
    this.maxOutputBytes = opts.maxOutputBytes;
    this.extraArgs = opts.extraArgs;
  }

  async generate(options: any): Promise<GenerateTextResult<any, any>> {
    const { prompt, systemFromMessages } = extractPrompt(options);
    const callTimeouts = resolveTimeouts(options?.timeout, {
      totalMs: this.timeoutMs,
      idleMs: this.idleTimeoutMs,
    });
    const cwd = this.cwd ?? getToolContext()?.rootDir ?? process.cwd();
    const env = { ...process.env, ...(this.env ?? {}) } as Record<
      string,
      string
    >;
    const combinedSystem = combineNonEmpty([
      this.systemPrompt,
      systemFromMessages,
    ]);
    const commandSpec = await this.buildCommand({
      prompt,
      systemPrompt: combinedSystem,
      cwd,
      options,
    });
    const commandEnv = commandSpec.env
      ? ({ ...env, ...commandSpec.env } as Record<string, string>)
      : env;
    const stdoutEmitter = createAgentStdoutTextEmitter({
      outputFormat: commandSpec.outputFormat,
      onText: options?.onStdout,
    });
    const interpreter = this.createOutputInterpreter();
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const emitEvents = (
      eventPayload: AgentCliEvent[] | AgentCliEvent | null | undefined,
    ) => {
      if (!eventPayload || !options?.onEvent) return;
      const events = Array.isArray(eventPayload) ? eventPayload : [eventPayload];
      for (const event of events) {
        void Promise.resolve(options.onEvent(event)).catch(() => undefined);
      }
    };

    const flushBufferedLines = (
      stream: "stdout" | "stderr",
      includePartial: boolean,
    ) => {
      if (!interpreter) return;
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
      if (!interpreter || !chunk) return;
      if (stream === "stdout") {
        stdoutBuffer += chunk;
      } else {
        stderrBuffer += chunk;
      }
      flushBufferedLines(stream, false);
    };

    // Launch diagnostics optimistically alongside the agent
    const diagnosticsPromise = launchDiagnostics(commandSpec.command, commandEnv, cwd);

    function filterBenignStderr(stderr: string): string {
      const benignPatterns = [
        /^.*state db missing rollout path.*$/gm,
        /^.*codex_core::rollout::list.*$/gm,
        /^.*failed to record rollout items: failed to queue rollout items: channel closed.*$/gim,
        /^.*Failed to shutdown rollout recorder.*$/gm,
        /^.*failed to renew cache TTL: Operation not permitted.*$/gim,
      ];
      let filtered = stderr;
      for (const pattern of benignPatterns) {
        filtered = filtered.replace(pattern, "");
      }
      // Clean up extra blank lines
      return filtered.replace(/\n{3,}/g, "\n\n").trim();
    }

    const program = Effect.gen(this, function* () {
      const result = yield* runCommandEffect(commandSpec.command, commandSpec.args, {
        cwd,
        env: commandEnv,
        input: commandSpec.stdin,
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
      emitEvents(interpreter?.onExit?.(result));

      const stdout = commandSpec.outputFile
        ? yield* fromPromise("read output file", () =>
            fs.readFile(commandSpec.outputFile!, "utf8"),
          ).pipe(Effect.catchAll(() => Effect.succeed(result.stdout)))
        : result.stdout;

      if (result.exitCode && result.exitCode !== 0) {
        const filteredStderr = filterBenignStderr(result.stderr);
        if (!(commandSpec.command === "codex" && filteredStderr.length === 0)) {
          const errorText =
            filteredStderr ||
            result.stdout.trim() ||
            `CLI exited with code ${result.exitCode}`;
          return yield* Effect.fail(new SmithersError("AGENT_CLI_ERROR", errorText));
        }
      }

      // Some CLIs may print extra banners to stdout. Allow individual agents
      // to provide patterns so this logic stays opt-in and agent-specific.
      const stdoutBannerPatterns = commandSpec.stdoutBannerPatterns ?? [];
      let cleanedStdout = stdout;
      for (const pattern of stdoutBannerPatterns) {
        const regex = new RegExp(pattern.source, pattern.flags);
        cleanedStdout = cleanedStdout.replace(regex, "");
      }
      const rawText = cleanedStdout.trim();

      // Optionally treat "banner-only" output as an error when requested.
      if (commandSpec.errorOnBannerOnly && !rawText && stdout.trim()) {
        return yield* Effect.fail(new SmithersError(
          "AGENT_CLI_ERROR",
          `CLI agent error (stdout): output was only a banner with no model response`,
        ));
      }

      // Some CLIs report failures on stdout even with exit code 0. Keep
      // detection patterns opt-in so normal model text is not misclassified.
      const stdoutErrorPatterns = commandSpec.stdoutErrorPatterns ?? [];
      if (rawText && !rawText.startsWith("{") && !rawText.startsWith("[")) {
        for (const pattern of stdoutErrorPatterns) {
          const regex = new RegExp(pattern.source, pattern.flags);
          if (regex.test(rawText)) {
            return yield* Effect.fail(
              new SmithersError("AGENT_CLI_ERROR", `CLI agent error (stdout): ${rawText.slice(0, 500)}`),
            );
          }
        }
      }

      const outputFormat = commandSpec.outputFormat;
      const extractedText =
        outputFormat === "json" || outputFormat === "stream-json"
          ? (extractTextFromJsonPayload(rawText) ?? rawText)
          : rawText;

      const output = tryParseJson(extractedText);
      // Extract token usage from raw stdout before text extraction strips it.
      // Each CLI harness embeds usage differently (NDJSON events, JSON stats, etc.)
      const cliUsage = extractUsageFromOutput(stdout);
      const usage = cliUsage ? {
        inputTokens: cliUsage.inputTokens,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: cliUsage.cacheReadTokens,
          cacheWriteTokens: cliUsage.cacheWriteTokens,
        },
        outputTokens: cliUsage.outputTokens,
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: cliUsage.reasoningTokens,
        },
        totalTokens: (cliUsage.inputTokens ?? 0) + (cliUsage.outputTokens ?? 0) || undefined,
      } : undefined;
      stdoutEmitter.flush(extractedText);
      return buildGenerateResult(
        extractedText,
        output,
        this.model ?? commandSpec.command,
        usage,
      );
    }).pipe(
      Effect.tapError((err) =>
        fromPromise("enrich diagnostics", async () => {
          if (!diagnosticsPromise) return;
          const report = await diagnosticsPromise.catch(() => null);
          if (report && err instanceof SmithersError) {
            enrichReportWithErrorAnalysis(report, err.message);
            err.details = { ...err.details, diagnostics: report };
            console.warn(formatDiagnosticSummary(report));
          }
        }).pipe(Effect.ignore),
      ),
      Effect.ensuring(Effect.sync(() => { stdoutEmitter.flush(); })),
      Effect.ensuring(
        commandSpec.cleanup
          ? fromPromise("agent cleanup", () => commandSpec.cleanup!()).pipe(Effect.ignore)
          : Effect.void,
      ),
    );

    return runPromise(program);
  }

  async stream(options: any): Promise<StreamTextResult<any, any>> {
    const result = await this.generate(options);
    return buildStreamResult(result);
  }

  protected createOutputInterpreter(): CliOutputInterpreter | undefined {
    return undefined;
  }

  protected abstract buildCommand(params: {
    prompt: string;
    systemPrompt?: string;
    cwd: string;
    options: any;
  }): Promise<CliCommandSpec>;
}

export function pushFlag(
  args: string[],
  flag: string,
  value?: string | number | boolean,
) {
  if (value === undefined) return;
  if (value === true) {
    args.push(flag);
  } else if (value === false) {
    return;
  } else {
    args.push(flag, String(value));
  }
}

export function pushList(args: string[], flag: string, values?: string[]) {
  if (!values || values.length === 0) return;
  args.push(flag, ...values.map(String));
}

export type CodexConfigOverrides =
  | Record<string, string | number | boolean | object | null>
  | string[];

export function normalizeCodexConfig(config?: CodexConfigOverrides): string[] {
  if (!config) return [];
  if (Array.isArray(config)) return config.map(String);
  const entries = Object.entries(config);
  return entries.map(([key, value]) => {
    if (value === null) return `${key}=null`;
    if (typeof value === "string") return `${key}=${value}`;
    if (typeof value === "number" || typeof value === "boolean")
      return `${key}=${value}`;
    return `${key}=${JSON.stringify(value)}`;
  });
}
