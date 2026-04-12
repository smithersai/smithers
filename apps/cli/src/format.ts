import pc from "picocolors";
import { eventCategoryForType } from "./event-categories";

function cliColors() {
  return pc.createColors(true);
}

/**
 * Format a timestamp as relative age: "2m ago", "1h ago", "3d ago"
 */
export function formatAge(ms: number): string {
  const now = Date.now();
  const diff = now - ms;
  if (diff < 0) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Format elapsed time compactly: "5m 23s", "1h 2m", "45s"
 */
export function formatElapsedCompact(startMs: number, endMs?: number): string {
  const elapsed = (endMs ?? Date.now()) - startMs;
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Format an elapsed time as HH:MM:SS from a base timestamp.
 */
export function formatTimestamp(baseMs: number, eventMs: number): string {
  const elapsed = eventMs - baseMs;
  const secs = Math.floor(elapsed / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hrs)}:${pad(mins % 60)}:${pad(secs % 60)}`;
}

/**
 * Format an elapsed time as a signed relative offset:
 * +MM:SS.mmm (or +HH:MM:SS.mmm when hours > 0).
 */
export function formatRelativeOffset(baseMs: number, eventMs: number): string {
  const elapsed = Math.max(0, eventMs - baseMs);
  const totalSeconds = Math.floor(elapsed / 1000);
  const millis = elapsed % 1000;
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  if (hours > 0) {
    return `+${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}.${pad3(millis)}`;
  }
  return `+${pad2(minutes)}:${pad2(seconds)}.${pad3(millis)}`;
}

export function colorizeEventText(type: string, text: string): string {
  const color = cliColors();
  if (
    type.endsWith("Failed") ||
    type.endsWith("Denied") ||
    type.endsWith("Error") ||
    type === "RunCancelled" ||
    type === "NodeCancelled"
  ) {
    return color.red(text);
  }
  if (
    type.endsWith("Finished") ||
    type === "ApprovalGranted" ||
    type === "RunAutoResumed"
  ) {
    return color.green(text);
  }
  if (eventCategoryForType(type) === "approval") {
    return color.yellow(text);
  }
  if (
    eventCategoryForType(type) === "tool-call" ||
    eventCategoryForType(type) === "openapi"
  ) {
    return color.blue(text);
  }
  if (type.endsWith("Started")) {
    return color.cyan(text);
  }
  return text;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function summarizePayload(
  payload: unknown,
  rawPayloadJson: string,
  maxLength: number,
): string {
  const value =
    payload === undefined
      ? rawPayloadJson
      : typeof payload === "string"
        ? payload
        : JSON.stringify(payload);
  if (!value) return "";
  return truncateText(value, maxLength);
}

export type FormatEventLineOptions = {
  includeTimestamp?: boolean;
  truncatePayloadAt?: number;
};

/**
 * Format a single event from _smithers_events into a log line.
 */
export function formatEventLine(event: {
  timestampMs: number;
  type: string;
  payloadJson: string;
}, baseMs: number, options?: FormatEventLineOptions): string {
  const ts = formatTimestamp(baseMs, event.timestampMs);
  const prefix = options?.includeTimestamp === false ? "" : `[${ts}] `;
  const truncatePayloadAt = options?.truncatePayloadAt ?? 240;
  let payload: any;
  try {
    payload = JSON.parse(event.payloadJson);
  } catch {
    payload = undefined;
  }

  switch (event.type) {
    case "RunStarted":
      return `${prefix}▶ Run started`;
    case "RunStatusChanged":
      return `${prefix}↺ Run status: ${payload?.status ?? "unknown"}`;
    case "RunFinished":
      return `${prefix}✓ Run finished`;
    case "RunFailed":
      return `${prefix}✗ Run failed: ${truncateText(String(payload?.error ?? "unknown"), truncatePayloadAt)}`;
    case "RunCancelled":
      return `${prefix}⊘ Run cancelled`;
    case "RunContinuedAsNew":
      return `${prefix}⇢ Continued as new: ${payload?.newRunId ?? "?"} (iteration ${payload?.iteration ?? 0})`;
    case "RunHijackRequested":
      return `${prefix}⇢ Hijack requested`;
    case "RunHijacked":
      return payload?.mode === "conversation"
        ? `${prefix}⇢ Hijacked ${payload?.engine ?? "agent"} conversation`
        : `${prefix}⇢ Hijacked ${payload?.engine ?? "agent"} session ${payload?.resume ?? ""}`.trim();
    case "SandboxCreated":
      return `${prefix}🧪 Sandbox created: ${payload?.sandboxId ?? "?"} (${payload?.runtime ?? "bubblewrap"})`;
    case "SandboxShipped":
      return `${prefix}📦 Sandbox shipped: ${payload?.sandboxId ?? "?"} (${payload?.bundleSizeBytes ?? 0} bytes)`;
    case "SandboxHeartbeat":
      return `${prefix}💓 Sandbox heartbeat: ${payload?.sandboxId ?? "?"}`;
    case "SandboxBundleReceived":
      return `${prefix}📥 Sandbox bundle received: ${payload?.sandboxId ?? "?"} (${payload?.patchCount ?? 0} patches)`;
    case "SandboxCompleted":
      return `${prefix}✅ Sandbox completed: ${payload?.sandboxId ?? "?"} (${payload?.status ?? "finished"})`;
    case "SandboxFailed":
      return `${prefix}❌ Sandbox failed: ${payload?.sandboxId ?? "?"}`;
    case "SandboxDiffReviewRequested":
      return `${prefix}📝 Sandbox diff review requested: ${payload?.sandboxId ?? "?"}`;
    case "SandboxDiffAccepted":
      return `${prefix}👍 Sandbox diffs accepted: ${payload?.sandboxId ?? "?"}`;
    case "SandboxDiffRejected":
      return `${prefix}👎 Sandbox diffs rejected: ${payload?.sandboxId ?? "?"}`;
    case "NodePending":
      return `${prefix}… ${payload?.nodeId ?? "?"} pending (iteration ${payload?.iteration ?? 0})`;
    case "NodeStarted":
      return `${prefix}→ ${payload?.nodeId ?? "?"} (attempt ${payload?.attempt ?? 1}, iteration ${payload?.iteration ?? 0})`;
    case "TaskHeartbeat":
      return `${prefix}💓 ${payload?.nodeId ?? "?"} heartbeat (${payload?.dataSizeBytes ?? 0} bytes)`;
    case "TaskHeartbeatTimeout":
      return `${prefix}⏲ ${payload?.nodeId ?? "?"} heartbeat timeout (${payload?.timeoutMs ?? 0}ms)`;
    case "NodeFinished":
      return `${prefix}✓ ${payload?.nodeId ?? "?"} (attempt ${payload?.attempt ?? 1})`;
    case "NodeFailed":
      return `${prefix}✗ ${payload?.nodeId ?? "?"} (attempt ${payload?.attempt ?? 1}): ${truncateText(String(payload?.error ?? "failed"), truncatePayloadAt)}`;
    case "NodeCancelled":
      return `${prefix}⊘ ${payload?.nodeId ?? "?"} cancelled`;
    case "NodeSkipped":
      return `${prefix}↷ ${payload?.nodeId ?? "?"} skipped`;
    case "NodeRetrying":
      return `${prefix}↻ ${payload?.nodeId ?? "?"} retrying (attempt ${payload?.attempt ?? 1})`;
    case "NodeWaitingApproval":
      return `${prefix}⏸ ${payload?.nodeId ?? "?"} waiting for approval`;
    case "NodeWaitingTimer":
      return `${prefix}⏱ Waiting for timer: ${payload?.nodeId ?? "?"}`;
    case "ApprovalRequested":
      return `${prefix}⏸ Approval requested: ${payload?.nodeId ?? "?"}`;
    case "ApprovalGranted":
      return `${prefix}✓ Approved: ${payload?.nodeId ?? "?"}`;
    case "ApprovalAutoApproved":
      return `${prefix}✓ Auto-approved: ${payload?.nodeId ?? "?"}`;
    case "ApprovalDenied":
      return `${prefix}✗ Denied: ${payload?.nodeId ?? "?"}`;
    case "ToolCallStarted":
      return `${prefix}🔧 ${payload?.nodeId ?? "?"} → ${payload?.toolName ?? "tool"} (attempt ${payload?.attempt ?? 1})`;
    case "ToolCallFinished":
      return `${prefix}🔧 ${payload?.nodeId ?? "?"} ← ${payload?.toolName ?? "tool"} (${payload?.status ?? "done"})`;
    case "ScorerStarted":
      return `${prefix}📊 ${payload?.nodeId ?? "?"} scorer ${payload?.scorerName ?? payload?.scorerId ?? "?"} started`;
    case "ScorerFinished":
      return `${prefix}📊 ${payload?.nodeId ?? "?"} scorer ${payload?.scorerName ?? payload?.scorerId ?? "?"} = ${payload?.score ?? "?"}`;
    case "ScorerFailed":
      return `${prefix}📊 ${payload?.nodeId ?? "?"} scorer ${payload?.scorerName ?? payload?.scorerId ?? "?"} failed`;
    case "TokenUsageReported":
      return `${prefix}🧮 ${payload?.nodeId ?? "?"} ${payload?.model ?? "model"} in=${payload?.inputTokens ?? 0} out=${payload?.outputTokens ?? 0}`;
    case "TimerCreated":
      return `${prefix}⏱ Timer created: ${payload?.timerId ?? "?"} (fires ${new Date(payload?.firesAtMs ?? 0).toISOString()})`;
    case "TimerFired":
      return `${prefix}🔔 Timer fired: ${payload?.timerId ?? "?"} (delay ${payload?.delayMs ?? 0}ms)`;
    case "TimerCancelled":
      return `${prefix}⊘ Timer cancelled: ${payload?.timerId ?? "?"}`;
    case "WorkflowReloadDetected":
      return `${prefix}⟳ File change detected`;
    case "WorkflowReloaded":
      return `${prefix}⟳ Workflow reloaded`;
    case "WorkflowReloadFailed":
      return `${prefix}⟳ Workflow reload failed`;
    case "WorkflowReloadUnsafe":
      return `${prefix}⟳ Workflow reload skipped: unsafe`;
    case "AgentEvent":
      return `${prefix}${payload?.engine ?? "agent"}: ${payload?.event?.type ?? "event"}`;
    case "FrameCommitted":
      return `${prefix}🖼 Frame ${payload?.frameNo ?? "?"} committed`;
    case "SnapshotCaptured":
      return `${prefix}📸 Snapshot ${payload?.frameNo ?? "?"} captured`;
    case "RevertStarted":
      return `${prefix}↩ Revert started on ${payload?.nodeId ?? "?"}`;
    case "RevertFinished":
      return `${prefix}${payload?.success ? "✓" : "✗"} Revert ${payload?.success ? "finished" : "failed"} on ${payload?.nodeId ?? "?"}`;
    case "TimeTravelStarted":
      return `${prefix}↺ Time travel started on ${payload?.nodeId ?? "?"}`;
    case "TimeTravelFinished":
      return `${prefix}${payload?.success ? "✓" : "✗"} Time travel ${payload?.success ? "finished" : "failed"} on ${payload?.nodeId ?? "?"}`;
    case "OpenApiToolCalled":
      return `${prefix}🌐 ${payload?.method ?? "?"} ${payload?.path ?? payload?.operationId ?? "?"} (${payload?.status ?? "unknown"})`;

    case "MemoryFactSet":
      return `${prefix}🧠 Memory set ${payload?.namespace ?? "default"}/${payload?.key ?? "?"}`;
    case "MemoryRecalled":
      return `${prefix}🧠 Memory recalled ${payload?.resultCount ?? 0} results`;
    case "MemoryMessageSaved":
      return `${prefix}🧠 Message saved to thread ${payload?.threadId ?? "?"}`;
    default:
      return `${prefix}${event.type} ${summarizePayload(payload, event.payloadJson, truncatePayloadAt)}`.trim();
  }
}
