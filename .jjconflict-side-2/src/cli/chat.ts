import { formatTimestamp } from "./format";

export type ChatAttemptMeta = {
  kind?: string | null;
  prompt?: string | null;
  label?: string | null;
  agentId?: string | null;
  agentModel?: string | null;
};

export type ChatAttemptRow = {
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  state: string;
  startedAtMs: number;
  finishedAtMs?: number | null;
  cached?: boolean | null;
  metaJson?: string | null;
  responseText?: string | null;
};

export type ChatOutputEvent = {
  seq: number;
  timestampMs: number;
  type: string;
  payloadJson: string;
};

export type ParsedNodeOutputEvent = {
  seq: number;
  timestampMs: number;
  nodeId: string;
  iteration: number;
  attempt: number;
  stream: "stdout" | "stderr";
  text: string;
};

export function parseChatAttemptMeta(metaJson?: string | null): ChatAttemptMeta {
  if (!metaJson) return {};
  try {
    const parsed = JSON.parse(metaJson);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as ChatAttemptMeta;
  } catch {
    return {};
  }
}

export function chatAttemptKey(attempt: Pick<ChatAttemptRow, "nodeId" | "iteration" | "attempt">) {
  return `${attempt.nodeId}:${attempt.iteration}:${attempt.attempt}`;
}

export function parseNodeOutputEvent(
  event: ChatOutputEvent,
): ParsedNodeOutputEvent | null {
  if (event.type !== "NodeOutput") return null;
  try {
    const payload = JSON.parse(event.payloadJson);
    if (!payload || typeof payload !== "object") return null;
    const text = typeof payload.text === "string" ? payload.text : "";
    const stream = payload.stream === "stderr" ? "stderr" : "stdout";
    if (!text) return null;
    return {
      seq: event.seq,
      timestampMs: event.timestampMs,
      nodeId: String(payload.nodeId ?? ""),
      iteration: Number(payload.iteration ?? 0),
      attempt: Number(payload.attempt ?? 1),
      stream,
      text,
    };
  } catch {
    return null;
  }
}

export function isAgentAttempt(
  attempt: ChatAttemptRow,
  outputAttemptKeys: ReadonlySet<string>,
): boolean {
  const meta = parseChatAttemptMeta(attempt.metaJson);
  if (meta.kind === "agent") return true;
  if (attempt.responseText?.trim()) return true;
  return outputAttemptKeys.has(chatAttemptKey(attempt));
}

export function selectChatAttempts(
  attempts: ChatAttemptRow[],
  outputAttemptKeys: ReadonlySet<string>,
  includeAll: boolean,
): ChatAttemptRow[] {
  const agentAttempts = attempts
    .filter((attempt) => isAgentAttempt(attempt, outputAttemptKeys))
    .sort((a, b) => {
      if (a.startedAtMs !== b.startedAtMs) return a.startedAtMs - b.startedAtMs;
      if (a.nodeId !== b.nodeId) return a.nodeId.localeCompare(b.nodeId);
      if (a.iteration !== b.iteration) return a.iteration - b.iteration;
      return a.attempt - b.attempt;
    });

  if (includeAll) return agentAttempts;
  const latest = agentAttempts[agentAttempts.length - 1];
  return latest ? [latest] : [];
}

export function formatChatAttemptHeader(attempt: ChatAttemptRow): string {
  const meta = parseChatAttemptMeta(attempt.metaJson);
  const title = meta.label?.trim() || attempt.nodeId;
  const agentBits = [meta.agentId, meta.agentModel].filter(Boolean).join(" · ");
  const parts = [
    title,
    `attempt ${attempt.attempt}`,
    attempt.iteration > 0 ? `iteration ${attempt.iteration}` : null,
    attempt.state,
    agentBits || null,
  ].filter(Boolean);
  return `=== ${parts.join(" · ")} ===`;
}

export function formatChatBlock(options: {
  baseMs: number;
  timestampMs: number;
  role: "user" | "assistant" | "stderr";
  attempt: Pick<ChatAttemptRow, "nodeId" | "iteration" | "attempt">;
  text: string;
}): string {
  const { baseMs, timestampMs, role, attempt, text } = options;
  const ts = formatTimestamp(baseMs, timestampMs);
  const ref = `${attempt.nodeId}#${attempt.attempt}${attempt.iteration > 0 ? `.${attempt.iteration}` : ""}`;
  const body = text.replace(/\s+$/, "");
  const prefix = `[${ts}] ${role} ${ref}`;
  if (!body.includes("\n")) {
    return `${prefix}: ${body}`;
  }
  return `${prefix}:\n${indentBlock(body)}`;
}

function indentBlock(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}
