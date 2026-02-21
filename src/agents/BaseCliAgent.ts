import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import type {
  Agent,
  GenerateTextResult,
  StreamTextResult,
  ModelMessage,
} from "ai";
import { getToolContext } from "../tools/context";

type TimeoutInput = number | { totalMs?: number } | undefined;

export type BaseCliAgentOptions = {
  id?: string;
  model?: string;
  systemPrompt?: string;
  instructions?: string;
  cwd?: string;
  env?: Record<string, string>;
  yolo?: boolean;
  timeoutMs?: number;
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
  signal?: AbortSignal;
  maxOutputBytes?: number;
  onStderr?: (chunk: string) => void;
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
  signal?: AbortSignal;
  maxOutputBytes?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

type RunCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export function resolveTimeoutMs(
  timeout: TimeoutInput,
  fallback?: number,
): number | undefined {
  if (typeof timeout === "number") return timeout;
  if (
    timeout &&
    typeof timeout === "object" &&
    typeof timeout.totalMs === "number"
  )
    return timeout.totalMs;
  return fallback;
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

export function truncateToBytes(text: string, maxBytes?: number): string {
  if (!maxBytes || maxBytes <= 0) return text;
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf8");
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
): GenerateTextResult<any, any> {
  const usage = emptyUsage();
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
    usage,
    totalUsage: usage,
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

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<RunCommandResult> {
  const {
    cwd,
    env,
    input,
    timeoutMs,
    signal,
    maxOutputBytes,
    onStdout,
    onStderr,
  } = options;
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const onData = (chunk: Buffer, target: "stdout" | "stderr") => {
      const text = chunk.toString("utf8");
      const next = truncateToBytes(
        target === "stdout" ? stdout + text : stderr + text,
        maxOutputBytes,
      );
      if (target === "stdout") {
        stdout = next;
        onStdout?.(text);
      } else {
        stderr = next;
        onStderr?.(text);
      }
    };

    child.stdout?.on("data", (chunk) => onData(chunk, "stdout"));
    child.stderr?.on("data", (chunk) => onData(chunk, "stderr"));

    const finalize = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) {
        reject(err);
      } else {
        resolve({ stdout, stderr, exitCode: child.exitCode });
      }
    };

    const kill = (reason: string) => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finalize(new Error(reason));
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs && Number.isFinite(timeoutMs)) {
      timer = setTimeout(
        () => kill(`CLI timed out after ${timeoutMs}ms`),
        timeoutMs,
      );
    }

    if (signal) {
      if (signal.aborted) {
        kill("CLI aborted");
      } else {
        signal.addEventListener("abort", () => kill("CLI aborted"), {
          once: true,
        });
      }
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      finalize(err);
    });
    child.on("close", () => {
      if (timer) clearTimeout(timer);
      finalize();
    });

    if (input) {
      child.stdin?.write(input);
    }
    child.stdin?.end();
  });
}

export async function runRpcCommand(command: string, args: string[], options: RunRpcCommandOptions): Promise<{
   text: string;
   output: unknown;
   stderr: string;
   exitCode: number | null;
 }> {
   const { cwd, env, prompt, timeoutMs, signal, maxOutputBytes, onStderr, onExtensionUiRequest } = options;
   return await new Promise((resolve, reject) => {
     let stderr = "";
     let settled = false;
     let exitCode: number | null = null;
     let textDeltas = "";
     let finalMessage: unknown | null = null;
     let promptResponseError: string | null = null;
 
     const child = spawn(command, args, {
       cwd,
       env,
       stdio: ["pipe", "pipe", "pipe"],
     });
 
     const rl = createInterface({ input: child.stdout });
 
     const handleError = (err: Error) => {
       if (settled) return;
       settled = true;
       try {
         rl.close();
       } catch {
         // ignore
       }
       reject(err);
     };
 
     const finalize = (text: string, output: unknown) => {
       if (settled) return;
       settled = true;
       try {
         rl.close();
       } catch {
         // ignore
       }
       resolve({ text, output, stderr, exitCode: child.exitCode });
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
       handleError(new Error(reason));
     };
 
     let timer: ReturnType<typeof setTimeout> | undefined;
     if (timeoutMs && Number.isFinite(timeoutMs)) {
       timer = setTimeout(() => kill(`CLI timed out after ${timeoutMs}ms`), timeoutMs);
     }
 
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
        handleError(new Error("Failed to send extension UI response: child stdin is not available"));
        terminateChild();
        return;
      }
      child.stdin.write(`${JSON.stringify(normalized)}\n`);
     };
 
     const handleLine = async (line: string) => {
       let parsed: unknown;
       try {
         parsed = JSON.parse(line);
       } catch {
         return;
       }
       if (!parsed || typeof parsed !== "object") return;
       const event = parsed as Record<string, unknown>;
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
       if (type === "turn_end") {
         const message = (event as any).message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
         if (message?.role === "assistant") {
           finalMessage = (event as any).message ?? finalMessage;
           if (message.stopReason === "error" || message.stopReason === "aborted") {
             promptResponseError = message.errorMessage || `Request ${message.stopReason}`;
           }
           const extracted = finalMessage ? extractTextFromJsonValue(finalMessage) : undefined;
           const text = extracted ?? textDeltas;
           if (timer) clearTimeout(timer);
           if (promptResponseError) {
             handleError(new Error(promptResponseError));
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
         handleError(err instanceof Error ? err : new Error(String(err)));
       });
     });
 
     child.stderr?.on("data", (chunk) => {
       const text = chunk.toString("utf8");
       stderr = truncateToBytes(stderr + text, maxOutputBytes);
       onStderr?.(text);
     });
 
     child.on("error", (err) => {
       if (timer) clearTimeout(timer);
       handleError(err);
     });
 
     child.on("close", (code) => {
       exitCode = code ?? null;
       if (timer) clearTimeout(timer);
       if (settled) return;
       if (promptResponseError) {
         handleError(new Error(promptResponseError));
         return;
       }
       if (code && code !== 0) {
         handleError(new Error(stderr.trim() || `CLI exited with code ${code}`));
         return;
       }
       const text = finalMessage ? extractTextFromJsonValue(finalMessage) ?? textDeltas : textDeltas;
       finalize(text ?? "", finalMessage ?? text ?? "");
     });
 
     const promptPayload = { id: randomUUID(), type: "prompt", message: prompt };
    if (!child.stdin) {
      handleError(new Error("Child process stdin is not available; cannot send prompt payload."));
      return;
    }
    child.stdin.write(`${JSON.stringify(promptPayload)}\n`);
   });
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
    this.maxOutputBytes = opts.maxOutputBytes;
    this.extraArgs = opts.extraArgs;
  }

  async generate(options: any): Promise<GenerateTextResult<any, any>> {
    const { prompt, systemFromMessages } = extractPrompt(options);
    const callTimeout = resolveTimeoutMs(options?.timeout, this.timeoutMs);
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
    try {
      const result = await runCommand(commandSpec.command, commandSpec.args, {
        cwd,
        env,
        input: commandSpec.stdin,
        timeoutMs: callTimeout,
        signal: options?.abortSignal,
        maxOutputBytes: this.maxOutputBytes ?? getToolContext()?.maxOutputBytes,
        onStdout: options?.onStdout,
        onStderr: options?.onStderr,
      });

      const stdout = commandSpec.outputFile
        ? await fs
            .readFile(commandSpec.outputFile, "utf8")
            .catch(() => result.stdout)
        : result.stdout;

      function filterBenignStderr(stderr: string): string {
        const benignPatterns = [
          /^.*state db missing rollout path.*$/gm,
          /^.*codex_core::rollout::list.*$/gm,
        ];
        let filtered = stderr;
        for (const pattern of benignPatterns) {
          filtered = filtered.replace(pattern, "");
        }
        // Clean up extra blank lines
        return filtered.replace(/\n{3,}/g, "\n\n").trim();
      }

      if (result.exitCode && result.exitCode !== 0) {
        const filteredStderr = filterBenignStderr(result.stderr);
        const errorText =
          filteredStderr ||
          result.stdout.trim() ||
          `CLI exited with code ${result.exitCode}`;
        throw new Error(errorText);
      }

      const rawText = stdout.trim();
      const outputFormat = commandSpec.outputFormat;
      const extractedText =
        outputFormat === "json" || outputFormat === "stream-json"
          ? (extractTextFromJsonPayload(rawText) ?? rawText)
          : rawText;

      const output = tryParseJson(extractedText);
      return buildGenerateResult(
        extractedText,
        output,
        this.model ?? commandSpec.command,
      );
    } finally {
      if (commandSpec.cleanup) {
        await commandSpec.cleanup().catch(() => undefined);
      }
    }
  }

  async stream(options: any): Promise<StreamTextResult<any, any>> {
    const result = await this.generate(options);
    return buildStreamResult(result);
  }

  protected abstract buildCommand(params: {
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
  }>;
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
