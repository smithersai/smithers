import { Effect } from "effect";
import type { SmithersDb } from "../db/adapter";
import { isRunHeartbeatFresh } from "../engine";
import type { RetryPolicy } from "../RetryPolicy";
import { computeRetryDelayMs } from "../utils/retry";
import { SmithersError } from "../utils/errors";
import { formatAge } from "./format";

type DbRunRow = {
  runId: string;
  status: string;
  createdAtMs?: number | null;
  startedAtMs?: number | null;
  finishedAtMs?: number | null;
  heartbeatAtMs?: number | null;
  workflowPath?: string | null;
  errorJson?: string | null;
};

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

type DbApprovalRow = {
  runId: string;
  nodeId: string;
  iteration: number;
  status: string;
  requestedAtMs?: number | null;
  decidedAtMs?: number | null;
  note?: string | null;
  decidedBy?: string | null;
};

type DbAttemptRow = {
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  state: string;
  startedAtMs?: number | null;
  finishedAtMs?: number | null;
  heartbeatAtMs?: number | null;
  heartbeatDataJson?: string | null;
  errorJson?: string | null;
  metaJson?: string | null;
  responseText?: string | null;
};

type DbEventRow = {
  runId: string;
  seq: number;
  timestampMs: number;
  type: string;
  payloadJson: string;
};

type DbFrameRow = {
  runId: string;
  frameNo: number;
  xmlJson: string;
};

type DescriptorMetadata = {
  nodeId: string;
  kind: "task" | "wait-for-event" | "timer" | "subflow" | "unknown";
  label: string | null;
  dependsOn: string[];
  continueOnFail: boolean;
  retries: number | null;
  heartbeatTimeoutMs: number | null;
  retryPolicy?: RetryPolicy;
  eventName: string | null;
  correlationId: string | null;
  onTimeout: string | null;
  timerDuration: string | null;
  timerUntil: string | null;
};

type ParsedEvent = {
  row: DbEventRow;
  payload: Record<string, unknown> | null;
};

type RetryInsight = {
  failedCount: number;
  maxAttempts: number | null;
  lastError: string | null;
  lastFailedAtMs: number | null;
  exhausted: boolean;
  retrying: boolean;
  nextRetryAtMs: number | null;
};

export type WhyBlockerKind =
  | "waiting-approval"
  | "waiting-event"
  | "waiting-timer"
  | "stale-task-heartbeat"
  | "retry-backoff"
  | "retries-exhausted"
  | "stale-heartbeat"
  | "dependency-failed";

export type WhyBlocker = {
  kind: WhyBlockerKind;
  nodeId: string;
  iteration: number | null;
  reason: string;
  waitingSince: number;
  unblocker: string;
  context?: string;
  signalName?: string | null;
  dependencyNodeId?: string | null;
  firesAtMs?: number | null;
  remainingMs?: number | null;
  attempt?: number | null;
  maxAttempts?: number | null;
};

export type WhyDiagnosis = {
  runId: string;
  status: string;
  summary: string;
  generatedAtMs: number;
  blockers: WhyBlocker[];
  currentNodeId: string | null;
};

type TimerSnapshot = {
  timerId: string;
  firesAtMs: number;
};

const RECENT_EVENTS_LIMIT = 50;
const MAX_CTA_COMMANDS = 5;

function nodeKey(nodeId: string, iteration: number) {
  return `${nodeId}::${iteration}`;
}

function logicalNodeId(nodeId: string) {
  const marker = nodeId.indexOf("@@");
  return marker >= 0 ? nodeId.slice(0, marker) : nodeId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseObjectJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value === "true" || value === "1";
  }
  return false;
}

function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((entry) => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter(Boolean);
      }
    } catch {
      // fall through to comma parsing
    }
  }
  if (trimmed.includes(",")) {
    return trimmed
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [trimmed];
}

function parseRetryPolicy(raw: unknown): RetryPolicy | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return undefined;
    const initialDelayMs = parseNumber(parsed.initialDelayMs);
    const backoffRaw = parseString(parsed.backoff);
    const backoff =
      backoffRaw === "fixed" || backoffRaw === "linear" || backoffRaw === "exponential"
        ? backoffRaw
        : undefined;
    if (initialDelayMs == null && !backoff) return undefined;
    return {
      ...(initialDelayMs != null ? { initialDelayMs: Math.max(0, Math.floor(initialDelayMs)) } : {}),
      ...(backoff ? { backoff } : {}),
    };
  } catch {
    return undefined;
  }
}

function parseErrorSummary(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (isRecord(parsed)) {
      const name = parseString(parsed.name);
      const message = parseString(parsed.message);
      if (name && message) return `${name}: ${message}`;
      if (message) return message;
      return JSON.stringify(parsed);
    }
    return String(parsed);
  } catch {
    return raw;
  }
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function waitingSinceFallback(now: number, ...candidates: Array<number | null | undefined>): number {
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return now;
}

function parseTimerSnapshot(metaJson?: string | null): TimerSnapshot | null {
  const meta = parseObjectJson(metaJson);
  const timer = isRecord(meta.timer) ? meta.timer : null;
  if (!timer) return null;
  const timerId = parseString(timer.timerId);
  const firesAtMs = parseNumber(timer.firesAtMs);
  if (!timerId || firesAtMs == null) return null;
  return {
    timerId,
    firesAtMs: Math.floor(firesAtMs),
  };
}

function parseEventPayload(row: DbEventRow): Record<string, unknown> | null {
  try {
    const payload = JSON.parse(row.payloadJson);
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

function parseFrameDescriptorMetadata(xmlJson: string | null | undefined): Map<string, DescriptorMetadata> {
  const metadata = new Map<string, DescriptorMetadata>();
  if (!xmlJson) return metadata;

  let parsed: unknown;
  try {
    parsed = JSON.parse(xmlJson);
  } catch {
    return metadata;
  }

  if (!isRecord(parsed) || parsed.kind !== "element") {
    // Non-XML frame payloads (e.g. patch blobs) are ignored.
    return metadata;
  }

  const walk = (node: unknown) => {
    if (!isRecord(node)) return;
    if (node.kind !== "element") return;
    const tag = parseString(node.tag) ?? "";
    const props = isRecord(node.props) ? node.props : {};

    const kind: DescriptorMetadata["kind"] =
      tag === "smithers:task"
        ? "task"
        : tag === "smithers:wait-for-event"
          ? "wait-for-event"
          : tag === "smithers:timer"
            ? "timer"
            : tag === "smithers:subflow"
              ? "subflow"
              : "unknown";

    if (kind !== "unknown") {
      const id = parseString(props.id);
      if (id) {
        metadata.set(id, {
          nodeId: id,
          kind,
          label: parseString(props.label),
          dependsOn: parseStringArray(props.dependsOn),
          continueOnFail: parseBoolean(props.continueOnFail),
          retries: (() => {
            const retries = parseNumber(props.retries);
            return retries == null ? null : Math.max(0, Math.floor(retries));
          })(),
          heartbeatTimeoutMs: (() => {
            const timeout =
              parseNumber(props.heartbeatTimeoutMs) ??
              parseNumber(props.heartbeatTimeout);
            return timeout == null || timeout <= 0
              ? null
              : Math.floor(timeout);
          })(),
          retryPolicy: parseRetryPolicy(props.retryPolicy),
          eventName:
            parseString(props.__smithersEventName) ??
            parseString(props.event) ??
            null,
          correlationId:
            parseString(props.__smithersCorrelationId) ??
            parseString(props.correlationId) ??
            null,
          onTimeout:
            parseString(props.__smithersOnTimeout) ??
            parseString(props.onTimeout) ??
            null,
          timerDuration:
            parseString(props.__smithersTimerDuration) ??
            parseString(props.duration) ??
            null,
          timerUntil:
            parseString(props.__smithersTimerUntil) ??
            parseString(props.until) ??
            null,
        });
      }
    }

    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) {
      walk(child);
    }
  };

  walk(parsed);
  return metadata;
}

function resolveDescriptorMetadata(
  metadataById: Map<string, DescriptorMetadata>,
  nodeId: string,
): DescriptorMetadata | undefined {
  return metadataById.get(nodeId) ?? metadataById.get(logicalNodeId(nodeId));
}

function resolveHeartbeatTimeoutMs(
  descriptor: DescriptorMetadata | undefined,
  attempt: DbAttemptRow | undefined,
): number | null {
  if (descriptor?.heartbeatTimeoutMs != null) {
    return descriptor.heartbeatTimeoutMs;
  }
  if (!attempt?.metaJson) return null;
  const meta = parseObjectJson(attempt.metaJson);
  const timeout =
    parseNumber(meta.heartbeatTimeoutMs) ??
    parseNumber(meta.heartbeatTimeout);
  if (timeout == null || timeout <= 0) return null;
  return Math.floor(timeout);
}

function buildRetryInsight(
  node: DbNodeRow,
  attempts: DbAttemptRow[],
  descriptor: DescriptorMetadata | undefined,
): RetryInsight | null {
  if (attempts.length === 0) return null;

  const failedAttempts = attempts.filter((attempt) => attempt.state === "failed");
  if (failedAttempts.length === 0) return null;

  failedAttempts.sort((a, b) => b.attempt - a.attempt);
  const newestAttempt = attempts[0]!;
  const latestFailed = failedAttempts[0]!;
  const latestFailedMeta = parseObjectJson(latestFailed.metaJson);
  const newestMeta = parseObjectJson(newestAttempt.metaJson);

  const retriesFromDescriptor = descriptor?.retries ?? null;
  const retriesFromAttempt =
    parseNumber(newestMeta.retries) ??
    parseNumber(latestFailedMeta.retries);
  const retries =
    retriesFromDescriptor != null
      ? retriesFromDescriptor
      : retriesFromAttempt != null
        ? Math.max(0, Math.floor(retriesFromAttempt))
        : null;
  const maxAttempts = retries != null ? retries + 1 : null;
  const failedCount = failedAttempts.length;
  const exhausted = maxAttempts != null ? failedCount >= maxAttempts : node.state === "failed";
  const retrying =
    !exhausted &&
    (node.state === "pending" ||
      node.state === "in-progress" ||
      node.state === "waiting-approval" ||
      node.state === "waiting-event" ||
      node.state === "waiting-timer");

  const retryPolicy =
    descriptor?.retryPolicy ??
    (() => {
      const candidate = newestMeta.retryPolicy ?? latestFailedMeta.retryPolicy;
      if (!isRecord(candidate)) return undefined;
      const initialDelayMs = parseNumber(candidate.initialDelayMs);
      const backoffRaw = parseString(candidate.backoff);
      const backoff =
        backoffRaw === "fixed" || backoffRaw === "linear" || backoffRaw === "exponential"
          ? backoffRaw
          : undefined;
      if (initialDelayMs == null && !backoff) return undefined;
      return {
        ...(initialDelayMs != null ? { initialDelayMs: Math.max(0, Math.floor(initialDelayMs)) } : {}),
        ...(backoff ? { backoff } : {}),
      } satisfies RetryPolicy;
    })();

  let nextRetryAtMs: number | null = null;
  const lastFinishedAtMs =
    typeof latestFailed.finishedAtMs === "number"
      ? latestFailed.finishedAtMs
      : typeof latestFailed.startedAtMs === "number"
        ? latestFailed.startedAtMs
        : null;
  if (retrying && retryPolicy && lastFinishedAtMs != null) {
    const delayMs = computeRetryDelayMs(retryPolicy, latestFailed.attempt);
    if (delayMs > 0) {
      nextRetryAtMs = lastFinishedAtMs + delayMs;
    }
  }

  return {
    failedCount,
    maxAttempts,
    lastError: parseErrorSummary(latestFailed.errorJson),
    lastFailedAtMs: lastFinishedAtMs,
    exhausted,
    retrying,
    nextRetryAtMs,
  };
}

function computeSignalName(
  node: DbNodeRow,
  descriptor: DescriptorMetadata | undefined,
  attempts: DbAttemptRow[],
  events: ParsedEvent[],
): { signalName: string | null; correlationId: string | null } {
  let signalName = descriptor?.eventName ?? null;
  let correlationId = descriptor?.correlationId ?? null;

  for (const attempt of attempts) {
    const meta = parseObjectJson(attempt.metaJson);
    signalName =
      signalName ??
      parseString(meta.eventName) ??
      parseString(meta.event) ??
      parseString(meta.signalName) ??
      parseString(meta.signal) ??
      null;
    correlationId =
      correlationId ??
      parseString(meta.correlationId) ??
      null;
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    const payload = event.payload;
    if (!payload) continue;
    if (parseString(payload.nodeId) !== node.nodeId) continue;
    const iteration = parseNumber(payload.iteration);
    if (iteration != null && Math.floor(iteration) !== node.iteration) continue;

    signalName =
      signalName ??
      parseString(payload.eventName) ??
      parseString(payload.event) ??
      parseString(payload.signalName) ??
      parseString(payload.signal) ??
      null;
    correlationId =
      correlationId ??
      parseString(payload.correlationId) ??
      null;

    if (signalName && correlationId) break;
  }

  return { signalName, correlationId };
}

function computeTimerSnapshot(
  node: DbNodeRow,
  attempts: DbAttemptRow[],
  events: ParsedEvent[],
): TimerSnapshot | null {
  for (const attempt of attempts) {
    const parsed = parseTimerSnapshot(attempt.metaJson);
    if (parsed) return parsed;
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    const payload = event.payload;
    if (!payload) continue;
    const payloadNodeId = parseString(payload.nodeId) ?? parseString(payload.timerId);
    if (payloadNodeId !== node.nodeId) continue;
    const firesAtMs = parseNumber(payload.firesAtMs);
    if (firesAtMs == null) continue;
    return { timerId: node.nodeId, firesAtMs: Math.floor(firesAtMs) };
  }

  return null;
}

function firstCurrentNode(nodes: DbNodeRow[]): string | null {
  const inProgress = nodes
    .filter((node) => node.state === "in-progress")
    .sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0));
  if (inProgress.length > 0) return inProgress[0]!.nodeId;

  const pending = nodes
    .filter((node) => node.state === "pending")
    .sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0));
  return pending[0]?.nodeId ?? null;
}

function describeRetryContext(insight: RetryInsight, nowMs: number): string {
  const lines: string[] = [];
  const attemptCountLabel =
    insight.maxAttempts != null
      ? `attempt ${insight.failedCount} of ${insight.maxAttempts}`
      : `attempt ${insight.failedCount}`;

  if (insight.lastError) {
    lines.push(`Previous attempt failed (${attemptCountLabel}):`);
    lines.push(`  ${insight.lastError}`);
  } else {
    lines.push(`Previous attempt failed (${attemptCountLabel}).`);
  }

  if (insight.retrying) {
    if (insight.nextRetryAtMs != null && insight.nextRetryAtMs > nowMs) {
      lines.push(`Retrying automatically in ${formatDuration(insight.nextRetryAtMs - nowMs)}`);
    } else {
      lines.push("Retrying automatically");
    }
  }

  return lines.join("\n");
}

function shellEscape(value: string): string {
  if (/^[a-zA-Z0-9._/:-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function buildResumeUnblocker(run: DbRunRow, force = false) {
  const workflowArg = run.workflowPath ? shellEscape(run.workflowPath) : "<workflow>";
  const forceFlag = force ? " --force true" : "";
  return `smithers up ${workflowArg} --run-id ${run.runId} --resume true${forceFlag}`;
}

function buildRetryTaskUnblocker(
  run: DbRunRow,
  nodeId: string,
  iteration: number,
  force = false,
) {
  const workflowArg = run.workflowPath ? shellEscape(run.workflowPath) : "<workflow>";
  const forceFlag = force ? " --force true" : "";
  return `smithers retry-task ${workflowArg} --run-id ${run.runId} --node-id ${shellEscape(nodeId)} --iteration ${iteration}${forceFlag}`;
}

function dedupeBlockers(blockers: WhyBlocker[]): WhyBlocker[] {
  const seen = new Set<string>();
  const deduped: WhyBlocker[] = [];
  for (const blocker of blockers) {
    const key = `${blocker.kind}:${blocker.nodeId}:${blocker.iteration ?? 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(blocker);
  }
  return deduped;
}

function buildDiagnosis(params: {
  run: DbRunRow;
  nodes: DbNodeRow[];
  approvals: DbApprovalRow[];
  attempts: DbAttemptRow[];
  events: DbEventRow[];
  lastFrame: DbFrameRow | undefined;
  nowMs: number;
}): WhyDiagnosis {
  const {
    run,
    nodes,
    approvals,
    attempts,
    events,
    lastFrame,
    nowMs,
  } = params;

  const runId = run.runId;
  const status =
    run.status === "continued" && run.finishedAtMs == null
      ? "running"
      : String(run.status ?? "unknown");
  const descriptorMetadata = parseFrameDescriptorMetadata(lastFrame?.xmlJson);

  const parsedEvents: ParsedEvent[] = events.map((row) => ({
    row,
    payload: parseEventPayload(row),
  }));

  const nodesByKey = new Map<string, DbNodeRow>();
  const nodesByLogicalId = new Map<string, DbNodeRow[]>();
  for (const node of nodes) {
    const key = nodeKey(node.nodeId, node.iteration ?? 0);
    nodesByKey.set(key, node);
    const logical = logicalNodeId(node.nodeId);
    const existing = nodesByLogicalId.get(logical);
    if (existing) {
      existing.push(node);
    } else {
      nodesByLogicalId.set(logical, [node]);
    }
  }
  for (const group of nodesByLogicalId.values()) {
    group.sort((left, right) => (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0));
  }

  const attemptsByNode = new Map<string, DbAttemptRow[]>();
  for (const attempt of attempts) {
    const key = nodeKey(attempt.nodeId, attempt.iteration ?? 0);
    const existing = attemptsByNode.get(key);
    if (existing) {
      existing.push(attempt);
    } else {
      attemptsByNode.set(key, [attempt]);
    }
  }
  for (const group of attemptsByNode.values()) {
    group.sort((a, b) => b.attempt - a.attempt);
  }

  const retryInsightsByNode = new Map<string, RetryInsight>();
  for (const node of nodes) {
    const key = nodeKey(node.nodeId, node.iteration ?? 0);
    const insight = buildRetryInsight(
      node,
      attemptsByNode.get(key) ?? [],
      resolveDescriptorMetadata(descriptorMetadata, node.nodeId),
    );
    if (insight) retryInsightsByNode.set(key, insight);
  }

  const blockers: WhyBlocker[] = [];

  for (const approval of approvals) {
    if (approval.status !== "requested") continue;
    const key = nodeKey(approval.nodeId, approval.iteration ?? 0);
    const node = nodesByKey.get(key);
    const retryInsight = retryInsightsByNode.get(key);
    const waitingSince = waitingSinceFallback(
      nowMs,
      approval.requestedAtMs,
      node?.updatedAtMs,
      run.startedAtMs,
      run.createdAtMs,
    );
    const contextParts: string[] = [];
    if (retryInsight && !retryInsight.exhausted) {
      contextParts.push(describeRetryContext(retryInsight, nowMs));
    }
    contextParts.push(
      `Deny instead: smithers deny ${runId} --node ${approval.nodeId} --iteration ${approval.iteration ?? 0}`,
    );

    blockers.push({
      kind: "waiting-approval",
      nodeId: approval.nodeId,
      iteration: approval.iteration ?? 0,
      reason: "Approval requested — no decision yet",
      waitingSince,
      unblocker:
        approvals.length > 1
          ? `smithers approve ${runId} --node ${approval.nodeId} --iteration ${approval.iteration ?? 0}`
          : `smithers approve ${runId}`,
      context: contextParts.join("\n\n"),
      ...(retryInsight
        ? {
            attempt: retryInsight.failedCount,
            maxAttempts: retryInsight.maxAttempts,
          }
        : {}),
    });
  }

  for (const node of nodes.filter((entry) => entry.state === "waiting-event")) {
    const key = nodeKey(node.nodeId, node.iteration ?? 0);
    const descriptor = resolveDescriptorMetadata(descriptorMetadata, node.nodeId);
    const nodeAttempts = attemptsByNode.get(key) ?? [];
    const { signalName, correlationId } = computeSignalName(
      node,
      descriptor,
      nodeAttempts,
      parsedEvents,
    );

    const signalArg = signalName ? shellEscape(signalName) : "<signal-name>";
    const correlationFlag = correlationId ? ` --correlation ${shellEscape(correlationId)}` : "";
    const retryInsight = retryInsightsByNode.get(key);
    const contextParts: string[] = [];
    if (correlationId) {
      contextParts.push(`Correlation: ${correlationId}`);
    }
    if (descriptor?.onTimeout) {
      contextParts.push(`On timeout: ${descriptor.onTimeout}`);
    }
    if (retryInsight && !retryInsight.exhausted) {
      contextParts.push(describeRetryContext(retryInsight, nowMs));
    }

    blockers.push({
      kind: "waiting-event",
      nodeId: node.nodeId,
      iteration: node.iteration ?? 0,
      reason: signalName
        ? `waiting for signal '${signalName}'`
        : "waiting for signal",
      waitingSince: waitingSinceFallback(
        nowMs,
        node.updatedAtMs,
        run.startedAtMs,
        run.createdAtMs,
      ),
      unblocker: `smithers signal ${runId} ${signalArg} --data '{}'${correlationFlag}`,
      ...(contextParts.length > 0 ? { context: contextParts.join("\n") } : {}),
      signalName,
      ...(retryInsight
        ? {
            attempt: retryInsight.failedCount,
            maxAttempts: retryInsight.maxAttempts,
          }
        : {}),
    });
  }

  for (const node of nodes.filter((entry) => entry.state === "waiting-timer")) {
    const key = nodeKey(node.nodeId, node.iteration ?? 0);
    const snapshot = computeTimerSnapshot(
      node,
      attemptsByNode.get(key) ?? [],
      parsedEvents,
    );
    const firesAtMs = snapshot?.firesAtMs ?? null;
    const remainingMs = firesAtMs == null ? null : Math.max(0, firesAtMs - nowMs);
    const timerLabel = snapshot?.timerId ?? node.nodeId;
    const contextParts: string[] = [];
    if (firesAtMs != null) {
      contextParts.push(`Fires at: ${new Date(firesAtMs).toISOString()}`);
      contextParts.push(`Time remaining: ${formatDuration(Math.max(0, firesAtMs - nowMs))}`);
    }
    blockers.push({
      kind: "waiting-timer",
      nodeId: node.nodeId,
      iteration: node.iteration ?? 0,
      reason: `waiting for timer '${timerLabel}'`,
      waitingSince: waitingSinceFallback(
        nowMs,
        node.updatedAtMs,
        run.startedAtMs,
        run.createdAtMs,
      ),
      unblocker: buildResumeUnblocker(run),
      ...(contextParts.length > 0 ? { context: contextParts.join("\n") } : {}),
      firesAtMs,
      remainingMs,
    });
  }

  for (const node of nodes.filter((entry) => entry.state === "in-progress")) {
    const key = nodeKey(node.nodeId, node.iteration ?? 0);
    const nodeAttempts = attemptsByNode.get(key) ?? [];
    const inProgressAttempt = nodeAttempts.find((attempt) => attempt.state === "in-progress");
    if (!inProgressAttempt) continue;
    const descriptor = resolveDescriptorMetadata(descriptorMetadata, node.nodeId);
    const heartbeatTimeoutMs = resolveHeartbeatTimeoutMs(
      descriptor,
      inProgressAttempt,
    );
    if (heartbeatTimeoutMs == null) continue;
    const lastHeartbeatAtMs =
      typeof inProgressAttempt.heartbeatAtMs === "number"
        ? inProgressAttempt.heartbeatAtMs
        : typeof inProgressAttempt.startedAtMs === "number"
          ? inProgressAttempt.startedAtMs
          : null;
    if (lastHeartbeatAtMs == null) continue;
    const staleForMs = Math.max(0, nowMs - lastHeartbeatAtMs);
    if (staleForMs <= heartbeatTimeoutMs) continue;

    blockers.push({
      kind: "stale-task-heartbeat",
      nodeId: node.nodeId,
      iteration: node.iteration ?? 0,
      reason: `task ${node.nodeId} hasn't heartbeated in ${formatDuration(staleForMs)} (timeout: ${formatDuration(heartbeatTimeoutMs)})`,
      waitingSince: waitingSinceFallback(
        nowMs,
        lastHeartbeatAtMs,
        node.updatedAtMs,
        run.startedAtMs,
      ),
      unblocker: buildRetryTaskUnblocker(
        run,
        node.nodeId,
        node.iteration ?? 0,
        run.status === "running",
      ),
      context: `Attempt ${inProgressAttempt.attempt}`,
      attempt: inProgressAttempt.attempt,
      maxAttempts:
        descriptor?.retries != null ? descriptor.retries + 1 : null,
    });
  }

  for (const node of nodes.filter((entry) => entry.state === "failed")) {
    const key = nodeKey(node.nodeId, node.iteration ?? 0);
    const insight = retryInsightsByNode.get(key);
    if (!insight) continue;
    if (!insight.exhausted && status !== "failed") continue;
    blockers.push({
      kind: "retries-exhausted",
      nodeId: node.nodeId,
      iteration: node.iteration ?? 0,
      reason: insight.lastError
        ? `All retries exhausted. Last error: ${insight.lastError}`
        : "All retries exhausted.",
      waitingSince: waitingSinceFallback(
        nowMs,
        insight.lastFailedAtMs,
        node.updatedAtMs,
        run.finishedAtMs,
        run.startedAtMs,
      ),
      unblocker: buildResumeUnblocker(run),
      context:
        insight.maxAttempts != null
          ? `Attempt ${insight.failedCount} of ${insight.maxAttempts}`
          : `Attempt ${insight.failedCount}`,
      attempt: insight.failedCount,
      maxAttempts: insight.maxAttempts,
    });
  }

  const primaryBlockedNodes = new Set(
    blockers.map((blocker) => nodeKey(blocker.nodeId, blocker.iteration ?? 0)),
  );

  for (const node of nodes) {
    const key = nodeKey(node.nodeId, node.iteration ?? 0);
    if (primaryBlockedNodes.has(key)) continue;
    const insight = retryInsightsByNode.get(key);
    if (!insight || insight.exhausted || !insight.retrying) continue;
    blockers.push({
      kind: "retry-backoff",
      nodeId: node.nodeId,
      iteration: node.iteration ?? 0,
      reason:
        insight.nextRetryAtMs != null && insight.nextRetryAtMs > nowMs
          ? `Previous attempt failed — retrying automatically in ${formatDuration(
              insight.nextRetryAtMs - nowMs,
            )}`
          : "Previous attempt failed — retrying automatically",
      waitingSince: waitingSinceFallback(
        nowMs,
        insight.lastFailedAtMs,
        node.updatedAtMs,
        run.startedAtMs,
      ),
      unblocker: buildRetryTaskUnblocker(
        run,
        node.nodeId,
        node.iteration ?? 0,
        run.status === "running",
      ),
      context: describeRetryContext(insight, nowMs),
      attempt: insight.failedCount,
      maxAttempts: insight.maxAttempts,
    });
  }

  for (const node of nodes.filter((entry) => entry.state === "pending")) {
    const descriptor = resolveDescriptorMetadata(descriptorMetadata, node.nodeId);
    const dependsOn = descriptor?.dependsOn ?? [];
    if (dependsOn.length === 0) continue;

    for (const dependencyId of dependsOn) {
      const candidateNodes =
        nodesByLogicalId.get(logicalNodeId(dependencyId)) ?? [];
      const failedDependency = candidateNodes.find((candidate) => candidate.state === "failed");
      if (!failedDependency) continue;

      const failedDescriptor = resolveDescriptorMetadata(
        descriptorMetadata,
        failedDependency.nodeId,
      );
      if (failedDescriptor?.continueOnFail) continue;

      blockers.push({
        kind: "dependency-failed",
        nodeId: node.nodeId,
        iteration: node.iteration ?? 0,
        reason: `Node ${node.nodeId} is blocked because dependency ${failedDependency.nodeId} failed.`,
        waitingSince: waitingSinceFallback(
          nowMs,
          node.updatedAtMs,
          failedDependency.updatedAtMs,
          run.startedAtMs,
        ),
        unblocker: buildResumeUnblocker(run),
        dependencyNodeId: failedDependency.nodeId,
      });
      break;
    }
  }

  if (status === "running" && !isRunHeartbeatFresh(run, nowMs)) {
    const lastHeartbeatAtMs =
      typeof run.heartbeatAtMs === "number" ? run.heartbeatAtMs : null;
    blockers.push({
      kind: "stale-heartbeat",
      nodeId: "(run-level)",
      iteration: null,
      reason:
        lastHeartbeatAtMs != null
          ? `Run appears orphaned (last heartbeat ${formatDuration(
              Math.max(0, nowMs - lastHeartbeatAtMs),
            )} ago)`
          : "Run appears orphaned (no heartbeat recorded)",
      waitingSince: waitingSinceFallback(
        nowMs,
        lastHeartbeatAtMs,
        run.startedAtMs,
        run.createdAtMs,
      ),
      unblocker: buildResumeUnblocker(run, true),
    });
  }

  const dedupedBlockers = dedupeBlockers(blockers);

  let summary: string;
  if (status === "finished") {
    summary = "Run is finished, nothing is blocked.";
  } else if (status === "cancelled") {
    summary =
      typeof run.finishedAtMs === "number"
        ? `Run was cancelled at ${new Date(run.finishedAtMs).toISOString()}.`
        : "Run was cancelled.";
  } else if (
    status === "running" &&
    isRunHeartbeatFresh(run, nowMs) &&
    dedupedBlockers.length === 0
  ) {
    const currentNode = firstCurrentNode(nodes);
    summary = currentNode
      ? `Run is executing normally. Currently on node ${currentNode}.`
      : "Run is executing normally.";
  } else if (dedupedBlockers.length === 0) {
    summary = `Run is ${status}. No blockers were identified.`;
  } else {
    summary = `Run ${runId} is ${status}`;
  }

  return {
    runId,
    status,
    summary,
    generatedAtMs: nowMs,
    blockers: dedupedBlockers.sort((left, right) => left.waitingSince - right.waitingSince),
    currentNodeId: firstCurrentNode(nodes),
  };
}

export function diagnoseRunEffect(
  adapter: SmithersDb,
  runId: string,
  nowMs = Date.now(),
): Effect.Effect<WhyDiagnosis, SmithersError> {
  return Effect.withLogSpan("why:diagnose")(
    Effect.gen(function* () {
      const [run, nodes, approvals, attempts, lastSeq, lastFrame] = yield* Effect.all([
        adapter.getRunEffect(runId),
        adapter.listNodesEffect(runId),
        adapter.listPendingApprovalsEffect(runId),
        adapter.listAttemptsForRunEffect(runId),
        adapter.getLastEventSeqEffect(runId),
        adapter.getLastFrameEffect(runId),
      ]);

      if (!run) {
        return yield* Effect.fail(
          new SmithersError("RUN_NOT_FOUND", `Run not found: ${runId}`),
        );
      }

      const afterSeq = Math.max(-1, (lastSeq ?? -1) - RECENT_EVENTS_LIMIT);
      const events = yield* adapter.listEventHistoryEffect(runId, {
        afterSeq,
        limit: RECENT_EVENTS_LIMIT,
      });

      const diagnosis = buildDiagnosis({
        run: run as DbRunRow,
        nodes: (nodes as DbNodeRow[]) ?? [],
        approvals: (approvals as DbApprovalRow[]) ?? [],
        attempts: (attempts as DbAttemptRow[]) ?? [],
        events: (events as DbEventRow[]) ?? [],
        lastFrame: lastFrame as DbFrameRow | undefined,
        nowMs,
      });

      return yield* Effect.succeed(diagnosis).pipe(
        Effect.annotateLogs({
          status: diagnosis.status,
          blockerCount: diagnosis.blockers.length,
        }),
      );
    }),
  ).pipe(Effect.annotateLogs({ runId }));
}

export function renderWhyDiagnosisHuman(diagnosis: WhyDiagnosis): string {
  if (diagnosis.status === "finished") {
    return "Run is finished, nothing is blocked.";
  }
  if (diagnosis.status === "cancelled") {
    return diagnosis.summary;
  }
  if (
    diagnosis.status === "running" &&
    diagnosis.blockers.length === 0 &&
    diagnosis.summary.startsWith("Run is executing normally")
  ) {
    return diagnosis.summary;
  }

  const lines: string[] = [];
  lines.push(`Run ${diagnosis.runId} is ${diagnosis.status}`);

  if (diagnosis.blockers.length === 0) {
    lines.push("");
    lines.push(diagnosis.summary);
    return lines.join("\n");
  }

  for (const blocker of diagnosis.blockers) {
    lines.push("");
    lines.push(`  Blocked node:  ${blocker.nodeId} (iteration ${blocker.iteration ?? 0})`);
    lines.push(
      `  Waiting since: ${formatAge(blocker.waitingSince)} (${new Date(blocker.waitingSince).toISOString()})`,
    );
    lines.push(`  Reason:        ${blocker.reason}`);
    lines.push(`  Unblock:       ${blocker.unblocker}`);
    if (typeof blocker.firesAtMs === "number") {
      lines.push(`  Fires at:      ${new Date(blocker.firesAtMs).toISOString()}`);
    }
    if (typeof blocker.remainingMs === "number") {
      lines.push(`  Time remaining:${blocker.remainingMs >= 0 ? " " : ""}${formatDuration(Math.max(0, blocker.remainingMs))}`);
    }
    if (blocker.context) {
      lines.push("");
      for (const line of blocker.context.split("\n")) {
        lines.push(`  ${line}`);
      }
    }
  }

  return lines.join("\n");
}

function stripSmithersPrefix(command: string): string {
  return command.startsWith("smithers ") ? command.slice("smithers ".length) : command;
}

export function diagnosisCtaCommands(
  diagnosis: WhyDiagnosis,
): Array<{ command: string; description: string }> {
  const mapping: Record<WhyBlockerKind, string> = {
    "waiting-approval": "Approve pending gate",
    "waiting-event": "Send expected signal",
    "waiting-timer": "Resume once timer is due",
    "stale-task-heartbeat": "Retry timed-out task",
    "retry-backoff": "Retry blocked node",
    "retries-exhausted": "Resume run after fixing failure",
    "stale-heartbeat": "Force resume orphaned run",
    "dependency-failed": "Resume after dependency fix",
  };

  const unique = new Map<string, { command: string; description: string }>();
  for (const blocker of diagnosis.blockers) {
    const command = stripSmithersPrefix(blocker.unblocker);
    if (!command || command.includes("<")) continue;
    if (!unique.has(command)) {
      unique.set(command, {
        command,
        description: mapping[blocker.kind] ?? "Unblock run",
      });
    }
    if (unique.size >= MAX_CTA_COMMANDS) break;
  }

  const ctas = [...unique.values()];
  ctas.push(
    { command: `inspect ${diagnosis.runId}`, description: "Inspect run state" },
    { command: `logs ${diagnosis.runId}`, description: "Tail run logs" },
  );

  const deduped = new Map<string, { command: string; description: string }>();
  for (const entry of ctas) {
    if (!deduped.has(entry.command)) deduped.set(entry.command, entry);
  }
  return [...deduped.values()].slice(0, MAX_CTA_COMMANDS + 2);
}
