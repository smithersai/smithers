import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { Cause, Effect, Exit, Metric } from "effect";
import type {
  Agent,
  GenerateTextResult,
  StreamTextResult,
} from "ai";
import type { AgentCapabilityRegistry } from "../capability-registry";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import { logDebug, logInfo, logWarning } from "@smithers/observability/logging";
import {
  agentDurationMs,
  agentErrorsTotal,
  agentInvocationsTotal,
  agentRetriesTotal,
  agentTokensTotal,
  toolOutputTruncatedTotal,
} from "@smithers/observability/metrics";
import { SmithersError } from "@smithers/errors/SmithersError";
import { launchDiagnostics, enrichReportWithErrorAnalysis, formatDiagnosticSummary } from "../diagnostics";
import type { BaseCliAgentOptions } from "./BaseCliAgentOptions";
import type { AgentCliEvent } from "./AgentCliEvent";
import type { CliOutputInterpreter } from "./CliOutputInterpreter";
import type { RunCommandResult } from "./RunCommandResult";
import { extractPrompt } from "./extractPrompt";
import { resolveTimeouts } from "./resolveTimeouts";
import { combineNonEmpty } from "./combineNonEmpty";
import { tryParseJson } from "./tryParseJson";
import { extractTextFromJsonValue } from "./extractTextFromJsonValue";
import { createAgentStdoutTextEmitter } from "./createAgentStdoutTextEmitter";
import { buildGenerateResult } from "./buildGenerateResult";
import { runCommandEffect } from "./runCommandEffect";

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

type AgentStdoutTextEmitter = {
  push: (chunk: string) => void;
  flush: (finalText?: string) => void;
};

type AgentInvocationOperation = "generate" | "stream";

export type CliUsageInfo = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
};

type AgentInvocationTags = {
  source: "adapter";
  engine: string;
  operation: AgentInvocationOperation;
  model?: string;
};

type AgentTokenTotals = CliUsageInfo & {
  totalTokens?: number;
};

export async function runAgentPromise<A>(
  effect: Effect.Effect<A, SmithersError, never>,
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "Some") {
    throw failure.value;
  }
  throw Cause.squash(exit.cause);
}

function normalizeMetricTag(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function taggedMetric<A extends Metric.Metric<any, any, any>>(
  metric: A,
  tags: Record<string, string | undefined>,
): A {
  let tagged: any = metric;
  for (const [key, value] of Object.entries(tags)) {
    if (!value) continue;
    tagged = Metric.tagged(tagged, key, value);
  }
  return tagged as A;
}

function resolveAgentEngineTag(
  agent: BaseCliAgent,
  fallbackCommand?: string,
): string {
  return normalizeMetricTag((agent as any).cliEngine)
    ?? normalizeMetricTag((agent as any).model)
    ?? normalizeMetricTag(fallbackCommand)
    ?? normalizeMetricTag(agent.constructor?.name)
    ?? "unknown";
}

function asFiniteTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function extractAgentTokenTotals(usage: any): AgentTokenTotals {
  if (!usage || typeof usage !== "object") {
    return {};
  }

  const inputTokens =
    asFiniteTokenCount(usage.inputTokens)
    ?? asFiniteTokenCount(usage.input_tokens)
    ?? asFiniteTokenCount(usage.prompt_tokens);
  const outputTokens =
    asFiniteTokenCount(usage.outputTokens)
    ?? asFiniteTokenCount(usage.output_tokens)
    ?? asFiniteTokenCount(usage.completion_tokens);
  const cacheReadTokens =
    asFiniteTokenCount(usage.cacheReadTokens)
    ?? asFiniteTokenCount(usage.cached_input_tokens)
    ?? asFiniteTokenCount(usage.cache_read_input_tokens)
    ?? asFiniteTokenCount(usage.inputTokenDetails?.cacheReadTokens);
  const cacheWriteTokens =
    asFiniteTokenCount(usage.cacheWriteTokens)
    ?? asFiniteTokenCount(usage.cache_creation_input_tokens)
    ?? asFiniteTokenCount(usage.inputTokenDetails?.cacheWriteTokens);
  const reasoningTokens =
    asFiniteTokenCount(usage.reasoningTokens)
    ?? asFiniteTokenCount(usage.reasoning_tokens)
    ?? asFiniteTokenCount(usage.outputTokenDetails?.reasoningTokens);
  const totalTokens =
    asFiniteTokenCount(usage.totalTokens)
    ?? asFiniteTokenCount(
      (inputTokens ?? 0)
      + (outputTokens ?? 0)
      + (cacheReadTokens ?? 0)
      + (cacheWriteTokens ?? 0)
      + (reasoningTokens ?? 0),
    );

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
  };
}

function recordAgentTokenMetrics(
  tags: AgentInvocationTags,
  totals: AgentTokenTotals,
): Effect.Effect<void> {
  const effects: Effect.Effect<void>[] = [];

  const pushMetric = (kind: string, value: number | undefined) => {
    if (!value || value <= 0) return;
    effects.push(
      Metric.incrementBy(
        taggedMetric(agentTokensTotal, {
          ...tags,
          kind,
        }),
        value,
      ),
    );
  };

  pushMetric("input", totals.inputTokens);
  pushMetric("output", totals.outputTokens);
  pushMetric("cache_read", totals.cacheReadTokens);
  pushMetric("cache_write", totals.cacheWriteTokens);
  pushMetric("reasoning", totals.reasoningTokens);
  pushMetric("total", totals.totalTokens);

  return effects.length > 0 ? Effect.all(effects, { discard: true }) : Effect.void;
}

function resolveRetryHint(options: any): { isRetry: boolean; reason?: string } {
  if (options?.retry === true) return { isRetry: true, reason: "retry" };
  if (options?.isRetry === true) return { isRetry: true, reason: "is_retry" };
  if (typeof options?.retryAttempt === "number" && options.retryAttempt > 0) {
    return { isRetry: true, reason: "retry_attempt" };
  }
  if (typeof options?.schemaRetry === "number" && options.schemaRetry > 0) {
    return { isRetry: true, reason: "schema_retry" };
  }
  return { isRetry: false };
}

function logAgentCliEvent(
  event: AgentCliEvent,
  annotations: Record<string, unknown>,
  span: string,
) {
  switch (event.type) {
    case "started":
      logInfo(
        "agent session started",
        {
          ...annotations,
          eventType: event.type,
          eventEngine: event.engine,
          title: event.title,
          resume: event.resume ?? null,
        },
        span,
      );
      return;

    case "action":
      logDebug(
        "agent action event",
        {
          ...annotations,
          eventType: event.type,
          eventEngine: event.engine,
          phase: event.phase,
          actionId: event.action.id,
          actionKind: event.action.kind,
          actionTitle: event.action.title,
          entryType: event.entryType ?? null,
          level: event.level ?? null,
          ok: event.ok ?? null,
        },
        span,
      );
      return;

    case "completed":
      (event.ok ? logInfo : logWarning)(
        event.ok ? "agent session completed" : "agent session failed",
        {
          ...annotations,
          eventType: event.type,
          eventEngine: event.engine,
          ok: event.ok,
          resume: event.resume ?? null,
          error: event.error ?? null,
          hasUsage: Boolean(event.usage),
        },
        span,
      );
      return;
  }
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
  const parsedLines: any[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      parsedLines.push(parsed);
    } catch {
      continue;
    }
  }

  for (let i = parsedLines.length - 1; i >= 0; i--) {
    const parsed = parsedLines[i];
    const type = typeof parsed?.type === "string" ? parsed.type : "";
    if (
      (type === "turn_end" || type === "message_end") &&
      parsed?.message?.role === "assistant"
    ) {
      const text = extractTextFromJsonValue(parsed.message);
      if (text) return text;
    }
    if (type === "agent_end" && Array.isArray(parsed?.messages)) {
      for (let j = parsed.messages.length - 1; j >= 0; j--) {
        const message = parsed.messages[j];
        if (message?.role !== "assistant") continue;
        const text = extractTextFromJsonValue(message);
        if (text) return text;
      }
    }
  }

  const chunks: string[] = [];
  for (const parsed of parsedLines) {
    const text = extractTextFromJsonValue(parsed);
    if (text) chunks.push(text);
  }
  return chunks.length ? chunks.join("") : undefined;
}

function inferOutputFormatFromArgs(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--output-format" || arg === "--mode") {
      return args[i + 1];
    }
  }
  return undefined;
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

function buildStreamResult(
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

export function extractUsageFromOutput(raw: string): CliUsageInfo | undefined {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const usage: CliUsageInfo = {};
  let found = false;

  for (const line of lines) {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;

    if (parsed.type === "message_start" && parsed.message?.usage) {
      const u = parsed.message.usage;
      usage.inputTokens = (usage.inputTokens ?? 0) + (u.input_tokens ?? 0);
      if (u.cache_read_input_tokens) {
        usage.cacheReadTokens =
          (usage.cacheReadTokens ?? 0) + u.cache_read_input_tokens;
      }
      if (u.cache_creation_input_tokens) {
        usage.cacheWriteTokens =
          (usage.cacheWriteTokens ?? 0) + u.cache_creation_input_tokens;
      }
      found = true;
      continue;
    }

    if (parsed.type === "message_delta" && parsed.usage) {
      if (parsed.usage.output_tokens) {
        usage.outputTokens =
          (usage.outputTokens ?? 0) + parsed.usage.output_tokens;
      }
      found = true;
      continue;
    }

    if (parsed.type === "turn.completed" && parsed.usage) {
      const u = parsed.usage;
      if (u.input_tokens) {
        usage.inputTokens = (usage.inputTokens ?? 0) + u.input_tokens;
      }
      if (u.output_tokens) {
        usage.outputTokens = (usage.outputTokens ?? 0) + u.output_tokens;
      }
      if (u.cached_input_tokens) {
        usage.cacheReadTokens =
          (usage.cacheReadTokens ?? 0) + u.cached_input_tokens;
      }
      found = true;
      continue;
    }

    if (parsed.usage && typeof parsed.usage === "object") {
      const u = parsed.usage;
      const inTok = u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? 0;
      const outTok =
        u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? 0;
      if (inTok > 0 || outTok > 0) {
        usage.inputTokens = (usage.inputTokens ?? 0) + inTok;
        usage.outputTokens = (usage.outputTokens ?? 0) + outTok;
        if (
          u.cache_read_input_tokens ||
          u.cacheReadTokens ||
          u.cached_input_tokens
        ) {
          usage.cacheReadTokens =
            (usage.cacheReadTokens ?? 0) +
            (u.cache_read_input_tokens ??
              u.cacheReadTokens ??
              u.cached_input_tokens ??
              0);
        }
        if (u.reasoning_tokens ?? u.reasoningTokens) {
          usage.reasoningTokens =
            (usage.reasoningTokens ?? 0) +
            (u.reasoning_tokens ?? u.reasoningTokens ?? 0);
        }
        found = true;
        continue;
      }
    }
  }

  if (!found) {
    try {
      const parsed = JSON.parse(raw.trim());
      if (parsed?.stats?.models && typeof parsed.stats.models === "object") {
        for (const data of Object.values(parsed.stats.models as Record<string, any>)) {
          if (data?.tokens) {
            usage.inputTokens =
              (usage.inputTokens ?? 0) +
              (data.tokens.input ?? data.tokens.prompt ?? 0);
            usage.outputTokens =
              (usage.outputTokens ?? 0) + (data.tokens.output ?? 0);
            found = true;
          }
        }
      }
    } catch {
      // not single JSON
    }
  }

  return found ? usage : undefined;
}

export abstract class BaseCliAgent implements Agent<any, any, any> {
  readonly version = "agent-v1" as const;
  readonly tools: Record<string, never> = {};
  readonly capabilities?: AgentCapabilityRegistry;
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

  private runGenerateEffect(
    options: any,
    operation: AgentInvocationOperation,
  ): Effect.Effect<GenerateTextResult<any, any>, SmithersError> {
    const invocationStart = performance.now();
    const { prompt, systemFromMessages } = extractPrompt(options);
    const callTimeouts = resolveTimeouts(options?.timeout, {
      totalMs: this.timeoutMs,
      idleMs: this.idleTimeoutMs,
    });
    const cwd = this.cwd ?? options?.rootDir ?? process.cwd();
    const env = { ...process.env, ...this.env } as Record<
      string,
      string
    >;
    const combinedSystem = combineNonEmpty([
      this.systemPrompt,
      systemFromMessages,
    ]);
    const retryHint = resolveRetryHint(options);
    const span = `agent.${operation}`;
    let metricTags: AgentInvocationTags = {
      source: "adapter",
      engine: resolveAgentEngineTag(this),
      operation,
      model: normalizeMetricTag(this.model),
    };
    const spanAnnotations = {
      agentEngine: metricTags.engine,
      agentOperation: operation,
      agentModel: metricTags.model ?? "unknown",
      cwd,
      timeoutMs: callTimeouts.totalMs ?? null,
      idleTimeoutMs: callTimeouts.idleMs ?? null,
      hasMessages: Array.isArray(options?.messages),
      hasResumeSession: typeof options?.resumeSession === "string",
      promptBytes: Buffer.byteLength(prompt, "utf8"),
      systemPromptBytes: combinedSystem ? Buffer.byteLength(combinedSystem, "utf8") : 0,
    } as const;

    let diagnosticsPromise: Promise<any> | null | undefined;
    let stdoutEmitter: AgentStdoutTextEmitter | undefined;
    let cleanup: (() => Promise<void>) | undefined;
    let commandLogAnnotations: Record<string, unknown> = {};

    const recordDurationMetric = () =>
      Effect.sync(() => performance.now() - invocationStart).pipe(
        Effect.flatMap((durationMs) =>
          Metric.update(
            taggedMetric(agentDurationMs, metricTags),
            durationMs,
          ),
        ),
      );

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

    const program = Effect.all([
      Metric.increment(taggedMetric(agentInvocationsTotal, metricTags)),
      ...(retryHint.isRetry
        ? [
            Metric.increment(
              taggedMetric(agentRetriesTotal, {
                ...metricTags,
                reason: retryHint.reason ?? "explicit",
              }),
            ),
          ]
        : []),
      Effect.logDebug("agent invocation started").pipe(
        Effect.annotateLogs({
          ...spanAnnotations,
          retryReason: retryHint.reason ?? null,
        }),
      ),
    ], { discard: true }).pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: () =>
            this.buildCommand({
              prompt,
              systemPrompt: combinedSystem,
              cwd,
              options,
            }),
          catch: (cause) => toSmithersError(cause, "build agent command"),
        }),
      ),
      Effect.flatMap((commandSpec) => {
        cleanup = commandSpec.cleanup;
        metricTags = {
          ...metricTags,
          engine: resolveAgentEngineTag(this, commandSpec.command),
          model: normalizeMetricTag(this.model ?? commandSpec.command),
        };
        const outputFormat =
          commandSpec.outputFormat ?? inferOutputFormatFromArgs(commandSpec.args);
        commandLogAnnotations = {
          ...spanAnnotations,
          agentEngine: metricTags.engine,
          agentModel: metricTags.model ?? "unknown",
          agentCommand: commandSpec.command,
          agentArgs: commandSpec.args.join(" "),
          outputFormat: outputFormat ?? "text",
        };

        const commandEnv = commandSpec.env
          ? ({ ...env, ...commandSpec.env } as Record<string, string>)
          : env;
        stdoutEmitter = createAgentStdoutTextEmitter({
          outputFormat,
          onText: options?.onStdout,
        });
        const interpreter = this.createOutputInterpreter();
        let stdoutBuffer = "";
        let stderrBuffer = "";

        const emitEvents = (
          eventPayload: AgentCliEvent[] | AgentCliEvent | null | undefined,
        ) => {
          if (!eventPayload) return;
          const events = Array.isArray(eventPayload) ? eventPayload : [eventPayload];
          for (const event of events) {
            logAgentCliEvent(event, commandLogAnnotations, span);
            if (!options?.onEvent) continue;
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

        diagnosticsPromise = launchDiagnostics(commandSpec.command, commandEnv, cwd);

        return Effect.gen(this, function* () {
          const result = yield* runCommandEffect(commandSpec.command, commandSpec.args, {
            cwd,
            env: commandEnv,
            input: commandSpec.stdin,
            timeoutMs: callTimeouts.totalMs,
            idleTimeoutMs: callTimeouts.idleMs,
            signal: options?.abortSignal,
            maxOutputBytes: this.maxOutputBytes ?? options?.maxOutputBytes,
            onStdout: (chunk) => {
              stdoutEmitter?.push(chunk);
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
            ? yield* Effect.tryPromise({
                try: () => fs.readFile(commandSpec.outputFile!, "utf8"),
                catch: (cause) => toSmithersError(cause, "read output file"),
              }).pipe(Effect.catchAll(() => Effect.succeed(result.stdout)))
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
              "CLI agent error (stdout): output was only a banner with no model response",
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
                  new SmithersError(
                    "AGENT_CLI_ERROR",
                    `CLI agent error (stdout): ${rawText.slice(0, 500)}`,
                  ),
                );
              }
            }
          }

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
          const tokenTotals = extractAgentTokenTotals(usage);
          stdoutEmitter?.flush(extractedText);
          yield* recordAgentTokenMetrics(metricTags, tokenTotals);

          const durationMs = performance.now() - invocationStart;
          yield* Effect.logDebug("agent invocation completed").pipe(
            Effect.annotateLogs({
              ...commandLogAnnotations,
              durationMs,
              textBytes: Buffer.byteLength(extractedText, "utf8"),
              stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
              inputTokens: tokenTotals.inputTokens ?? 0,
              outputTokens: tokenTotals.outputTokens ?? 0,
              totalTokens: tokenTotals.totalTokens ?? 0,
            }),
          );

          return buildGenerateResult(
            extractedText,
            output,
            this.model ?? commandSpec.command,
            usage,
          );
        });
      }),
    ).pipe(
      Effect.tapError((err) =>
        Effect.all([
          Metric.increment(taggedMetric(agentErrorsTotal, metricTags)),
          Effect.logWarning("agent invocation failed").pipe(
            Effect.annotateLogs({
              ...commandLogAnnotations,
              ...spanAnnotations,
              error: err.message,
              durationMs: performance.now() - invocationStart,
            }),
          ),
          Effect.tryPromise({
            try: async () => {
              if (!diagnosticsPromise) return;
              const report = await diagnosticsPromise.catch(() => null);
              if (report && err instanceof SmithersError) {
                enrichReportWithErrorAnalysis(report, err.message);
                err.details = { ...err.details, diagnostics: report };
                logWarning(formatDiagnosticSummary(report), {}, span);
              }
            },
            catch: (cause) => toSmithersError(cause, "enrich diagnostics"),
          }).pipe(Effect.ignore),
        ], { discard: true }),
      ),
      Effect.ensuring(Effect.sync(() => { stdoutEmitter?.flush(); })),
      Effect.ensuring(Effect.suspend(() => {
        const cleanupFn = cleanup;
        return cleanupFn
          ? Effect.tryPromise({
              try: () => cleanupFn(),
              catch: (cause) => toSmithersError(cause, "agent cleanup"),
            }).pipe(Effect.ignore)
          : Effect.void;
      })),
      Effect.ensuring(recordDurationMetric()),
      Effect.annotateLogs(spanAnnotations),
      Effect.withLogSpan(span),
    );

    return program;
  }

  async generate(options: any): Promise<GenerateTextResult<any, any>> {
    return runAgentPromise(this.runGenerateEffect(options, "generate"));
  }

  async stream(options: any): Promise<StreamTextResult<any, any>> {
    const result = await runAgentPromise(
      this.runGenerateEffect(options, "stream").pipe(
        Effect.map((generateResult) => buildStreamResult(generateResult)),
      ),
    );
    return result;
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
