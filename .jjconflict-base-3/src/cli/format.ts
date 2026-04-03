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
 * Format a single event from _smithers_events into a log line.
 */
export function formatEventLine(event: {
  timestampMs: number;
  type: string;
  payloadJson: string;
}, baseMs: number): string {
  const ts = formatTimestamp(baseMs, event.timestampMs);
  let payload: any;
  try { payload = JSON.parse(event.payloadJson); } catch { payload = {}; }

  switch (event.type) {
    case "NodeStarted":
      return `[${ts}] → ${payload.nodeId ?? "?"} (attempt ${payload.attempt ?? 1}, iteration ${payload.iteration ?? 0})`;
    case "NodeFinished":
      return `[${ts}] ✓ ${payload.nodeId ?? "?"} (attempt ${payload.attempt ?? 1})`;
    case "NodeFailed":
      return `[${ts}] ✗ ${payload.nodeId ?? "?"} (attempt ${payload.attempt ?? 1}): ${payload.error ?? "failed"}`;
    case "NodeRetrying":
      return `[${ts}] ↻ ${payload.nodeId ?? "?"} retrying (attempt ${payload.attempt ?? 1})`;
    case "RunFinished":
      return `[${ts}] ✓ Run finished`;
    case "RunFailed":
      return `[${ts}] ✗ Run failed: ${payload.error ?? "unknown"}`;
    case "RunCancelled":
      return `[${ts}] ⊘ Run cancelled`;
    case "RunHijackRequested":
      return `[${ts}] ⇢ Hijack requested`;
    case "RunHijacked":
      return payload.mode === "conversation"
        ? `[${ts}] ⇢ Hijacked ${payload.engine ?? "agent"} conversation`
        : `[${ts}] ⇢ Hijacked ${payload.engine ?? "agent"} session ${payload.resume ?? ""}`.trim();
    case "ApprovalRequested":
      return `[${ts}] ⏸ Approval requested: ${payload.nodeId ?? "?"}`;
    case "ApprovalGranted":
      return `[${ts}] ✓ Approved: ${payload.nodeId ?? "?"}`;
    case "ApprovalDenied":
      return `[${ts}] ✗ Denied: ${payload.nodeId ?? "?"}`;
    case "WorkflowReloadDetected":
      return `[${ts}] ⟳ File change detected`;
    case "WorkflowReloaded":
      return `[${ts}] ⟳ Workflow reloaded`;
    case "AgentEvent":
      return `[${ts}] ${payload.engine ?? "agent"}: ${payload.event?.type ?? "event"}`;
    default:
      return `[${ts}] ${event.type}`;
  }
}
