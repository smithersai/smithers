import type {
  ApprovalSummary,
  FeedEntry,
  RunNodeSummary,
  RunSummary,
  Workspace,
} from "./types.js";

export function formatClockTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatElapsed(startMs?: number, endMs?: number): string {
  if (!startMs) return "0s";
  const elapsedMs = Math.max(0, (endMs ?? Date.now()) - startMs);
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatWorkspaceMarker(workspace: Workspace): string {
  switch (workspace.attention) {
    case "running":
      return "◐";
    case "approval":
      return "!";
    case "failed":
      return "×";
    case "complete":
      return "✓";
    default:
      return " ";
  }
}

export function formatProviderTag(providerProfileId: string): string {
  switch (providerProfileId) {
    case "claude":
    case "claude-code":
      return "[CC]";
    case "codex":
      return "[CX]";
    case "gemini":
      return "[GM]";
    case "smithers":
      return "[SM]";
    default:
      return "[AI]";
  }
}

export function summarizeRun(run: RunSummary): string {
  const progress =
    run.totalSteps && run.totalSteps > 0
      ? `${run.completedSteps ?? 0}/${run.totalSteps}`
      : "0/0";
  const currentNode = run.currentNodeLabel ?? run.currentNodeId ?? "starting";
  const elapsed = formatElapsed(run.startedAtMs, run.finishedAtMs);
  return `${run.workflowName} ${run.runId.slice(0, 8)} ${run.status} ${currentNode} ${progress} ${elapsed}`;
}

export function summarizeApproval(approval: ApprovalSummary): string {
  return `Approval required for ${approval.nodeId} on ${approval.runId.slice(0, 8)}`;
}

export function progressBar(done = 0, total = 0, width = 10): string {
  if (total <= 0) return `${"░".repeat(width)} 0/0`;
  const ratio = Math.max(0, Math.min(1, done / total));
  const filled = Math.round(ratio * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)} ${done}/${total}`;
}

export function summarizeNode(node: RunNodeSummary): string {
  const icon =
    node.state === "finished"
      ? "✓"
      : node.state === "failed"
        ? "×"
        : node.state === "in-progress"
          ? "◐"
          : node.state === "waiting-approval"
            ? "!"
            : "○";
  return `${icon} ${node.label ?? node.nodeId}`;
}

export function parseWorkflowMentions(draft: string): string[] {
  const matches = draft.match(/#[a-z0-9-]+/g) ?? [];
  return Array.from(new Set(matches.map((item) => item.slice(1))));
}

export function parseAttachmentMentions(draft: string): string[] {
  const matches = draft.match(/@[^\s]+/g) ?? [];
  return Array.from(new Set(matches.map((item) => item.slice(1))));
}

export function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function entrySourceLabel(entry: FeedEntry): string {
  if (entry.type === "user") return "You";
  if (entry.type === "assistant") return "Smithers";
  if (entry.type === "run") return "Run";
  if (entry.type === "approval") return "Approval";
  if (entry.type === "tool") return "Tool";
  if (entry.type === "artifact") return "Artifact";
  if (entry.type === "error") return "Error";
  if (entry.type === "warning") return "Warn";
  return entry.source;
}
