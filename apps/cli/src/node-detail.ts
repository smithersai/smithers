import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import { SmithersError } from "@smithers/errors";

const MAX_TOOL_PAYLOAD_BYTES_HUMAN = 1024;
const MAX_VALIDATED_OUTPUT_BYTES_HUMAN = 10 * 1024;
const DEFAULT_EXPANDED_ATTEMPT_LIMIT = 5;

type DbNodeRow = {
  runId: string;
  nodeId: string;
  iteration: number;
  state: string;
  lastAttempt?: number | null;
  updatedAtMs?: number | null;
  outputTable?: string | null;
  label?: string | null;
};

type DbAttemptRow = {
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  state: string;
  startedAtMs: number;
  finishedAtMs?: number | null;
  errorJson?: string | null;
  metaJson?: string | null;
  responseText?: string | null;
  cached?: boolean | null;
  jjPointer?: string | null;
  jjCwd?: string | null;
};

type DbToolCallRow = {
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  seq: number;
  toolName: string;
  inputJson?: string | null;
  outputJson?: string | null;
  startedAtMs: number;
  finishedAtMs?: number | null;
  status: string;
  errorJson?: string | null;
};

type DbEventRow = {
  runId: string;
  seq: number;
  timestampMs: number;
  type: string;
  payloadJson: string;
};

type DbScorerRow = {
  id: string;
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  scorerId: string;
  scorerName: string;
  source: string;
  score: number;
  reason?: string | null;
  metaJson?: string | null;
  inputJson?: string | null;
  outputJson?: string | null;
  latencyMs?: number | null;
  scoredAtMs: number;
  durationMs?: number | null;
};

type DbCacheRow = {
  cacheKey: string;
  createdAtMs: number;
  workflowName: string;
  nodeId: string;
  outputTable: string;
  schemaSig: string;
  payloadJson: string;
};

type ParsedTokenUsageEvent = {
  attempt: number;
  model: string | null;
  agent: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
};

export type NodeDetailToolCall = {
  attempt: number;
  seq: number;
  name: string;
  status: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  durationMs: number | null;
  input: unknown | null;
  output: unknown | null;
  error: string | null;
};

export type NodeDetailTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
  eventCount: number;
  models: string[];
  agents: string[];
};

export type NodeDetailAttempt = {
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  state: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  durationMs: number | null;
  error: string | null;
  errorDetail: unknown | null;
  tokenUsage: NodeDetailTokenUsage;
  toolCalls: NodeDetailToolCall[];
  meta: unknown | null;
  responseText: string | null;
  cached: boolean;
  jjPointer: string | null;
  jjCwd: string | null;
};

type AttemptSummary = {
  total: number;
  failed: number;
  cancelled: number;
  succeeded: number;
  waiting: number;
};

export type EnrichedNodeDetail = {
  node: {
    runId: string;
    nodeId: string;
    iteration: number;
    state: string;
    lastAttempt: number | null;
    updatedAtMs: number | null;
    outputTable: string | null;
    label: string | null;
  };
  status: string;
  durationMs: number | null;
  attemptsSummary: AttemptSummary;
  attempts: NodeDetailAttempt[];
  toolCalls: NodeDetailToolCall[];
  tokenUsage: NodeDetailTokenUsage & {
    byAttempt: Array<{
      attempt: number;
      usage: NodeDetailTokenUsage;
    }>;
  };
  scorers: Array<{
    id: string;
    attempt: number;
    scorerId: string;
    scorerName: string;
    source: string;
    score: number;
    reason: string | null;
    latencyMs: number | null;
    durationMs: number | null;
    scoredAtMs: number;
    meta: unknown | null;
    input: unknown | null;
    output: unknown | null;
  }>;
  output: {
    validated: unknown | null;
    raw: unknown | null;
    source: "cache" | "output-table" | "none";
    cacheKey: string | null;
  };
  limits: {
    toolPayloadBytesHuman: number;
    validatedOutputBytesHuman: number;
  };
};

export type AggregateNodeDetailParams = {
  runId: string;
  nodeId: string;
  iteration?: number;
};

export type RenderNodeDetailOptions = {
  expandAttempts: boolean;
  expandTools: boolean;
};

const emptyTokenUsage = (): NodeDetailTokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: null,
  eventCount: 0,
  models: [],
  agents: [],
});

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeDurationMs(startedAtMs: number | null, finishedAtMs: number | null) {
  if (startedAtMs == null || finishedAtMs == null) return null;
  const duration = finishedAtMs - startedAtMs;
  return duration >= 0 ? duration : null;
}

function parseJsonValue(raw: string | null | undefined): unknown | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseErrorSummary(raw: string | null | undefined) {
  if (!raw) return { message: null, detail: null as unknown };
  const parsed = parseJsonValue(raw);
  if (typeof parsed === "string") {
    return { message: parsed, detail: parsed };
  }
  if (parsed && typeof parsed === "object") {
    const name =
      typeof (parsed as Record<string, unknown>).name === "string"
        ? ((parsed as Record<string, unknown>).name as string)
        : null;
    const message =
      typeof (parsed as Record<string, unknown>).message === "string"
        ? ((parsed as Record<string, unknown>).message as string)
        : null;
    if (name && message) {
      return { message: `${name}: ${message}`, detail: parsed };
    }
    if (message) {
      return { message, detail: parsed };
    }
    try {
      return { message: JSON.stringify(parsed), detail: parsed };
    } catch {
      return { message: String(parsed), detail: parsed };
    }
  }
  return { message: String(parsed), detail: parsed };
}

function parseTokenUsageEvent(
  row: DbEventRow,
  params: { nodeId: string; iteration: number },
): ParsedTokenUsageEvent | null {
  if (row.type !== "TokenUsageReported") return null;
  const payload = parseJsonValue(row.payloadJson);
  if (!payload || typeof payload !== "object") return null;
  const entry = payload as Record<string, unknown>;
  if (String(entry.nodeId ?? "") !== params.nodeId) return null;
  const iteration = asNumber(entry.iteration);
  if (iteration == null || Math.trunc(iteration) !== params.iteration) return null;
  const attempt = asNumber(entry.attempt);
  if (attempt == null) return null;

  const model = typeof entry.model === "string" ? entry.model : null;
  const agent = typeof entry.agent === "string" ? entry.agent : null;
  const inputTokens = asNumber(entry.inputTokens) ?? 0;
  const outputTokens = asNumber(entry.outputTokens) ?? 0;
  const cacheReadTokens = asNumber(entry.cacheReadTokens) ?? 0;
  const cacheWriteTokens = asNumber(entry.cacheWriteTokens) ?? 0;
  const reasoningTokens = asNumber(entry.reasoningTokens) ?? 0;
  const costUsd = asNumber(entry.costUsd) ?? asNumber(entry.cost);

  return {
    attempt: Math.trunc(attempt),
    model,
    agent,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    costUsd,
  };
}

function mergeTokenUsage(
  current: NodeDetailTokenUsage,
  event: ParsedTokenUsageEvent,
): NodeDetailTokenUsage {
  const nextModels = new Set(current.models);
  if (event.model) nextModels.add(event.model);
  const nextAgents = new Set(current.agents);
  if (event.agent) nextAgents.add(event.agent);
  const mergedCost =
    current.costUsd == null && event.costUsd == null
      ? null
      : (current.costUsd ?? 0) + (event.costUsd ?? 0);

  return {
    inputTokens: current.inputTokens + event.inputTokens,
    outputTokens: current.outputTokens + event.outputTokens,
    cacheReadTokens: current.cacheReadTokens + event.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens + event.cacheWriteTokens,
    reasoningTokens: current.reasoningTokens + event.reasoningTokens,
    costUsd: mergedCost,
    eventCount: current.eventCount + 1,
    models: [...nextModels],
    agents: [...nextAgents],
  };
}

function summarizeAttempts(attempts: DbAttemptRow[]): AttemptSummary {
  let failed = 0;
  let cancelled = 0;
  let succeeded = 0;
  let waiting = 0;
  for (const attempt of attempts) {
    if (attempt.state === "failed") failed += 1;
    else if (attempt.state === "cancelled") cancelled += 1;
    else if (attempt.state === "finished") succeeded += 1;
    else waiting += 1;
  }
  return {
    total: attempts.length,
    failed,
    cancelled,
    succeeded,
    waiting,
  };
}

function computeNodeDurationMs(attempts: DbAttemptRow[]) {
  if (attempts.length === 0) return null;
  let minStart: number | null = null;
  let maxFinish: number | null = null;
  for (const attempt of attempts) {
    const startedAtMs = asNumber(attempt.startedAtMs);
    if (startedAtMs != null) {
      minStart = minStart == null ? startedAtMs : Math.min(minStart, startedAtMs);
    }
    const finishedAtMs = asNumber(attempt.finishedAtMs);
    if (finishedAtMs != null) {
      maxFinish = maxFinish == null ? finishedAtMs : Math.max(maxFinish, finishedAtMs);
    }
  }
  return normalizeDurationMs(minStart, maxFinish);
}

function normalizeRawOutput(
  row: Record<string, unknown> | null,
): unknown | null {
  if (!row || typeof row !== "object") return null;
  const clone: Record<string, unknown> = { ...row };
  delete clone.run_id;
  delete clone.node_id;
  delete clone.iteration;
  for (const [key, value] of Object.entries(clone)) {
    if (
      typeof value === "string" &&
      (value.trimStart().startsWith("{") || value.trimStart().startsWith("["))
    ) {
      clone[key] = parseJsonValue(value);
    }
  }
  return clone;
}

function deepJsonString(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function pickValidatedOutput(
  rawOutput: unknown | null,
  cacheRows: DbCacheRow[],
) {
  const parsedCache = cacheRows
    .map((row) => ({
      cacheKey: row.cacheKey,
      payload: parseJsonValue(row.payloadJson),
    }))
    .filter((row) => row.payload !== null);

  const rawEncoded = deepJsonString(rawOutput);
  if (rawEncoded != null) {
    for (const candidate of parsedCache) {
      if (deepJsonString(candidate.payload) === rawEncoded) {
        return {
          validated: candidate.payload,
          source: "cache" as const,
          cacheKey: candidate.cacheKey,
        };
      }
    }
  }

  if (parsedCache.length > 0) {
    return {
      validated: parsedCache[0]!.payload,
      source: "cache" as const,
      cacheKey: parsedCache[0]!.cacheKey,
    };
  }

  if (rawOutput != null) {
    return {
      validated: rawOutput,
      source: "output-table" as const,
      cacheKey: null,
    };
  }

  return {
    validated: null,
    source: "none" as const,
    cacheKey: null,
  };
}

function formatDuration(ms: number | null) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
}

function formatCount(value: number) {
  return value.toLocaleString("en-US");
}

function formatScore(value: number) {
  const rounded = value.toFixed(3);
  return rounded.replace(/\.?0+$/, "");
}

function formatCostUsd(value: number | null) {
  if (value == null) return null;
  return value.toFixed(4);
}

function describeToolResult(tool: NodeDetailToolCall) {
  if (tool.status !== "success") {
    return tool.error ? `${tool.status}: ${tool.error}` : tool.status;
  }
  const output = tool.output;
  if (output == null) return "ok";
  if (Array.isArray(output)) return `${output.length} items`;
  if (typeof output === "object") {
    const record = output as Record<string, unknown>;
    const results = record.results;
    if (Array.isArray(results)) return `${results.length} results`;
    if (typeof record.ok === "boolean") return record.ok ? "ok" : "failed";
    const keys = Object.keys(record);
    return keys.length === 0 ? "ok" : `${keys.length} fields`;
  }
  if (typeof output === "string") {
    const compact = output.replace(/\s+/g, " ").trim();
    if (!compact) return "ok";
    return compact.length > 72 ? `${compact.slice(0, 69)}...` : compact;
  }
  return String(output);
}

function stringifyForHuman(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function truncateForHuman(text: string, maxBytes: number) {
  const suffix = "... (truncated, use --json for full output)";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) {
    return text;
  }
  const clippedBytes = bytes.slice(0, maxBytes);
  const clipped = clippedBytes.toString("utf8");
  return `${clipped}${suffix}`;
}

function appendPrefixedBlock(
  lines: string[],
  prefix: string,
  text: string,
  blockIndent: string,
) {
  if (!text.includes("\n")) {
    lines.push(`${prefix} ${text}`);
    return;
  }
  lines.push(prefix);
  for (const line of text.split(/\r?\n/)) {
    lines.push(`${blockIndent}${line}`);
  }
}

export function aggregateNodeDetailEffect(
  adapter: SmithersDb,
  params: AggregateNodeDetailParams,
): Effect.Effect<EnrichedNodeDetail, SmithersError> {
  return Effect.gen(function* () {
      const nodeRows = (yield* adapter.listNodeIterationsEffect(
        params.runId,
        params.nodeId,
      )) as DbNodeRow[];
      if (nodeRows.length === 0) {
        return yield* Effect.fail(
          new SmithersError("NODE_NOT_FOUND", `Node not found: ${params.nodeId}`, {
            runId: params.runId,
            nodeId: params.nodeId,
          }),
        );
      }

      const resolvedIteration =
        params.iteration ?? Math.max(...nodeRows.map((row) => row.iteration));
      const node = nodeRows.find((row) => row.iteration === resolvedIteration);
      if (!node) {
        return yield* Effect.fail(
          new SmithersError(
            "NODE_NOT_FOUND",
            `Node not found: ${params.nodeId} (iteration ${resolvedIteration})`,
            {
              runId: params.runId,
              nodeId: params.nodeId,
              iteration: resolvedIteration,
            },
          ),
        );
      }

      const [attemptRows, toolCallRows, tokenEventRows, scorerRows, rawOutputRow, cacheRows] =
        yield* Effect.all([
          adapter.listAttemptsEffect(
            params.runId,
            params.nodeId,
            resolvedIteration,
          ),
          adapter.listToolCallsEffect(
            params.runId,
            params.nodeId,
            resolvedIteration,
          ),
          adapter.listEventsByTypeEffect(params.runId, "TokenUsageReported"),
          adapter.listScorerResultsEffect(params.runId, params.nodeId),
          node.outputTable
            ? adapter.getRawNodeOutputForIterationEffect(
                node.outputTable,
                params.runId,
                params.nodeId,
                resolvedIteration,
              )
            : Effect.succeed(null),
          node.outputTable
            ? adapter.listCacheByNodeEffect(params.nodeId, node.outputTable, 20)
            : Effect.succeed([]),
        ]);

      const attemptsDesc = attemptRows as DbAttemptRow[];
      const attempts = [...attemptsDesc].sort((left, right) => left.attempt - right.attempt);
      const toolCallsRaw = toolCallRows as DbToolCallRow[];
      const eventsRaw = tokenEventRows as DbEventRow[];
      const scorerRowsFiltered = (scorerRows as DbScorerRow[])
        .filter((row) => row.iteration === resolvedIteration)
        .sort((left, right) => left.scoredAtMs - right.scoredAtMs);
      const cacheRowsTyped = cacheRows as DbCacheRow[];

      yield* Effect.logDebug("aggregated node detail").pipe(
        Effect.annotateLogs({
          runId: params.runId,
          nodeId: params.nodeId,
          iteration: resolvedIteration,
          attemptCount: attempts.length,
          toolCallCount: toolCallsRaw.length,
        }),
      );

      const tokenByAttempt = new Map<number, NodeDetailTokenUsage>();
      for (const eventRow of eventsRaw) {
        const parsed = parseTokenUsageEvent(eventRow, {
          nodeId: params.nodeId,
          iteration: resolvedIteration,
        });
        if (!parsed) continue;
        const existing = tokenByAttempt.get(parsed.attempt) ?? emptyTokenUsage();
        tokenByAttempt.set(parsed.attempt, mergeTokenUsage(existing, parsed));
      }

      const toolCalls: NodeDetailToolCall[] = toolCallsRaw.map((call) => {
        const parsedError = parseErrorSummary(call.errorJson);
        const finishedAtMs = asNumber(call.finishedAtMs);
        return {
          attempt: call.attempt,
          seq: call.seq,
          name: call.toolName,
          status: call.status,
          startedAtMs: call.startedAtMs,
          finishedAtMs,
          durationMs: normalizeDurationMs(
            asNumber(call.startedAtMs),
            finishedAtMs,
          ),
          input: parseJsonValue(call.inputJson),
          output: parseJsonValue(call.outputJson),
          error: parsedError.message,
        };
      });

      const toolCallsByAttempt = new Map<number, NodeDetailToolCall[]>();
      for (const toolCall of toolCalls) {
        const list = toolCallsByAttempt.get(toolCall.attempt) ?? [];
        list.push(toolCall);
        toolCallsByAttempt.set(toolCall.attempt, list);
      }

      const attemptsDetailed: NodeDetailAttempt[] = attempts.map((attempt) => {
        const parsedError = parseErrorSummary(attempt.errorJson);
        const finishedAtMs = asNumber(attempt.finishedAtMs);
        const usage = tokenByAttempt.get(attempt.attempt) ?? emptyTokenUsage();
        return {
          runId: attempt.runId,
          nodeId: attempt.nodeId,
          iteration: attempt.iteration,
          attempt: attempt.attempt,
          state: attempt.state,
          startedAtMs: attempt.startedAtMs,
          finishedAtMs,
          durationMs: normalizeDurationMs(
            asNumber(attempt.startedAtMs),
            finishedAtMs,
          ),
          error: parsedError.message,
          errorDetail: parsedError.detail,
          tokenUsage: usage,
          toolCalls:
            toolCallsByAttempt.get(attempt.attempt)?.sort(
              (left, right) => left.seq - right.seq,
            ) ?? [],
          meta: parseJsonValue(attempt.metaJson),
          responseText: attempt.responseText ?? null,
          cached: Boolean(attempt.cached),
          jjPointer: attempt.jjPointer ?? null,
          jjCwd: attempt.jjCwd ?? null,
        };
      });

      const totalUsage = attemptsDetailed.reduce<NodeDetailTokenUsage>(
        (acc, attempt) =>
          mergeTokenUsage(acc, {
            attempt: attempt.attempt,
            model: null,
            agent: null,
            inputTokens: attempt.tokenUsage.inputTokens,
            outputTokens: attempt.tokenUsage.outputTokens,
            cacheReadTokens: attempt.tokenUsage.cacheReadTokens,
            cacheWriteTokens: attempt.tokenUsage.cacheWriteTokens,
            reasoningTokens: attempt.tokenUsage.reasoningTokens,
            costUsd: attempt.tokenUsage.costUsd,
          }),
        emptyTokenUsage(),
      );
      const tokenUsage = {
        ...totalUsage,
        byAttempt: attemptsDetailed.map((attempt) => ({
          attempt: attempt.attempt,
          usage: attempt.tokenUsage,
        })),
      };

      const rawOutput = normalizeRawOutput(
        (rawOutputRow as Record<string, unknown> | null) ?? null,
      );
      const validatedOutput = pickValidatedOutput(rawOutput, cacheRowsTyped);

      return {
        node: {
          runId: node.runId,
          nodeId: node.nodeId,
          iteration: node.iteration,
          state: node.state,
          lastAttempt: node.lastAttempt ?? null,
          updatedAtMs: node.updatedAtMs ?? null,
          outputTable: node.outputTable ?? null,
          label: node.label ?? null,
        },
        status: node.state,
        durationMs: computeNodeDurationMs(attempts),
        attemptsSummary: summarizeAttempts(attempts),
        attempts: attemptsDetailed,
        toolCalls,
        tokenUsage,
        scorers: scorerRowsFiltered.map((row) => ({
          id: row.id,
          attempt: row.attempt,
          scorerId: row.scorerId,
          scorerName: row.scorerName,
          source: row.source,
          score: row.score,
          reason: row.reason ?? null,
          latencyMs: row.latencyMs ?? null,
          durationMs: row.durationMs ?? null,
          scoredAtMs: row.scoredAtMs,
          meta: parseJsonValue(row.metaJson),
          input: parseJsonValue(row.inputJson),
          output: parseJsonValue(row.outputJson),
        })),
        output: {
          validated: validatedOutput.validated,
          raw: rawOutput,
          source: validatedOutput.source,
          cacheKey: validatedOutput.cacheKey,
        },
        limits: {
          toolPayloadBytesHuman: MAX_TOOL_PAYLOAD_BYTES_HUMAN,
          validatedOutputBytesHuman: MAX_VALIDATED_OUTPUT_BYTES_HUMAN,
        },
      };
    }).pipe(
      Effect.annotateLogs({
        runId: params.runId,
        nodeId: params.nodeId,
      }),
      Effect.withLogSpan("cli:node-detail"),
    );
}

function summarizeAttemptStatesForHuman(attempts: NodeDetailAttempt[]) {
  let failed = 0;
  let cancelled = 0;
  let finished = 0;
  let other = 0;
  for (const attempt of attempts) {
    if (attempt.state === "failed") failed += 1;
    else if (attempt.state === "cancelled") cancelled += 1;
    else if (attempt.state === "finished") finished += 1;
    else other += 1;
  }
  const parts: string[] = [];
  if (failed > 0) parts.push(`${failed} failed`);
  if (cancelled > 0) parts.push(`${cancelled} cancelled`);
  if (finished > 0) parts.push(`${finished} succeeded`);
  if (other > 0) parts.push(`${other} other`);
  return parts.join(", ");
}

function renderHumanPayload(payload: unknown, maxBytes: number) {
  return truncateForHuman(stringifyForHuman(payload), maxBytes);
}

export function renderNodeDetailHuman(
  detail: EnrichedNodeDetail,
  options: RenderNodeDetailOptions,
) {
  const lines: string[] = [];
  const attempts = detail.attempts;
  const attemptsSummaryParts = summarizeAttemptStatesForHuman(attempts);

  lines.push(
    `Node: ${detail.node.nodeId} (iteration ${detail.node.iteration})`,
  );
  lines.push(`Status: ${detail.status}`);
  lines.push(`Duration: ${formatDuration(detail.durationMs)}`);
  lines.push(
    attemptsSummaryParts
      ? `Attempts: ${detail.attemptsSummary.total} (${attemptsSummaryParts})`
      : `Attempts: ${detail.attemptsSummary.total}`,
  );

  const expandAll =
    options.expandAttempts ||
    attempts.length <= DEFAULT_EXPANDED_ATTEMPT_LIMIT;
  const expandedAttempts = expandAll ? attempts : attempts.slice(-1);
  const summarizedPrior = expandAll ? [] : attempts.slice(0, Math.max(0, attempts.length - 1));

  if (summarizedPrior.length > 0) {
    const priorSummary = summarizeAttemptStatesForHuman(summarizedPrior);
    lines.push("");
    lines.push(
      priorSummary
        ? `${summarizedPrior.length} prior attempts (${priorSummary})`
        : `${summarizedPrior.length} prior attempts`,
    );
  }

  const latestAttemptNumber = attempts.length > 0
    ? attempts[attempts.length - 1]!.attempt
    : null;

  for (const attempt of expandedAttempts) {
    lines.push("");
    lines.push(
      `Attempt ${attempt.attempt} - ${attempt.state} (${formatDuration(
        attempt.durationMs,
      )})`,
    );
    if (attempt.error) {
      lines.push(`  Error: ${attempt.error}`);
    }
    const usage = attempt.tokenUsage;
    if (
      usage.inputTokens > 0 ||
      usage.outputTokens > 0 ||
      usage.cacheReadTokens > 0 ||
      usage.cacheWriteTokens > 0
    ) {
      const cost = formatCostUsd(usage.costUsd);
      lines.push(
        `  Tokens: ${formatCount(usage.inputTokens)} in / ${formatCount(
          usage.outputTokens,
        )} out${cost ? ` ($${cost})` : ""}`,
      );
    }

    if (attempt.toolCalls.length > 0) {
      lines.push("  Tool calls:");
      for (const toolCall of attempt.toolCalls) {
        const duration = formatDuration(toolCall.durationMs);
        lines.push(
          `    ${toolCall.name} (${duration}) -> ${describeToolResult(toolCall)}`,
        );
        if (options.expandTools) {
          if (toolCall.input != null) {
            appendPrefixedBlock(
              lines,
              "      Input:",
              renderHumanPayload(
                toolCall.input,
                MAX_TOOL_PAYLOAD_BYTES_HUMAN,
              ),
              "        ",
            );
          }
          if (toolCall.output != null) {
            appendPrefixedBlock(
              lines,
              "      Output:",
              renderHumanPayload(
                toolCall.output,
                MAX_TOOL_PAYLOAD_BYTES_HUMAN,
              ),
              "        ",
            );
          }
          if (toolCall.error) {
            lines.push(`      Error: ${toolCall.error}`);
          }
        }
      }
    }

    if (
      latestAttemptNumber != null &&
      attempt.attempt === latestAttemptNumber
    ) {
      if (detail.output.validated != null) {
        appendPrefixedBlock(
          lines,
          "  Output (validated):",
          renderHumanPayload(
            detail.output.validated,
            MAX_VALIDATED_OUTPUT_BYTES_HUMAN,
          ),
          "    ",
        );
      } else if (detail.output.raw != null) {
        appendPrefixedBlock(
          lines,
          "  Output (raw):",
          renderHumanPayload(detail.output.raw, MAX_VALIDATED_OUTPUT_BYTES_HUMAN),
          "    ",
        );
      }
    }
  }

  if (detail.scorers.length > 0) {
    lines.push("");
    for (const scorer of detail.scorers) {
      lines.push(
        `Scorer: ${scorer.scorerName} -> ${formatScore(scorer.score)}`,
      );
    }
  }

  return lines.join("\n");
}
