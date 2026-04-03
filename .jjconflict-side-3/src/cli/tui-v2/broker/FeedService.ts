import type { FeedEntry, FeedEntryType, RunSummary, UiEventEnvelope, WorkspaceId } from "../shared/types.js";
import { compactText, summarizeApproval, summarizeRun } from "../shared/format.js";

function parseJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function eventTypeToFeedType(type: string): FeedEntryType | null {
  if (type.startsWith("Approval")) return "approval";
  if (type === "RunFailed") return "error";
  if (type === "WorkflowReloadFailed") return "warning";
  if (type.startsWith("Run")) return "run";
  if (type.startsWith("Node")) return "run";
  if (type === "AgentEvent") return "assistant";
  return null;
}

function summarizeEvent(type: string, payload: Record<string, unknown>, runSummary?: RunSummary): string {
  switch (type) {
    case "RunStarted":
      return `Run ${runSummary?.workflowName ?? payload.workflowName ?? "workflow"} ${String(payload.runId ?? runSummary?.runId ?? "").slice(0, 8)} started`;
    case "RunFinished":
      return `Run ${runSummary?.workflowName ?? "workflow"} finished`;
    case "RunFailed":
      return `Run failed: ${String(payload.error ?? runSummary?.errorMessage ?? "unknown error")}`;
    case "RunCancelled":
      return "Run cancelled";
    case "NodeStarted":
      return `${String(payload.nodeId ?? "node")} started`;
    case "NodeFinished":
      return `${String(payload.nodeId ?? "node")} finished`;
    case "NodeFailed":
      return `${String(payload.nodeId ?? "node")} failed: ${String(payload.error ?? "unknown error")}`;
    case "NodeRetrying":
      return `${String(payload.nodeId ?? "node")} retrying`;
    case "ApprovalRequested":
      return summarizeApproval({
        runId: String(payload.runId ?? runSummary?.runId ?? ""),
        nodeId: String(payload.nodeId ?? "approval"),
        iteration: Number(payload.iteration ?? 0),
      });
    case "ApprovalGranted":
      return `Approved ${String(payload.nodeId ?? "approval")}`;
    case "ApprovalDenied":
      return `Denied ${String(payload.nodeId ?? "approval")}`;
    case "WorkflowReloaded":
      return "Workflow reloaded";
    case "WorkflowReloadFailed":
      return `Workflow reload failed: ${String(payload.error ?? "unknown error")}`;
    case "AgentEvent":
      return `${String(payload.engine ?? "agent")}: ${String((payload.event as { type?: string } | undefined)?.type ?? "event")}`;
    default:
      return type;
  }
}

export class FeedService {
  createUserEntry(workspaceId: WorkspaceId, summary: string): FeedEntry {
    const timestampMs = Date.now();
    return {
      id: `user-${workspaceId}-${timestampMs}`,
      workspaceId,
      type: "user",
      timestampMs,
      source: "You",
      summary,
      expanded: true,
      metadata: {},
    };
  }

  createAssistantEntry(workspaceId: WorkspaceId, summary: string): FeedEntry {
    const timestampMs = Date.now();
    return {
      id: `assistant-${workspaceId}-${timestampMs}`,
      workspaceId,
      type: "assistant",
      timestampMs,
      source: "Smithers",
      summary,
      status: "running",
      expanded: true,
      metadata: {},
    };
  }

  appendAssistantChunk(entry: FeedEntry, chunk: string): FeedEntry {
    return {
      ...entry,
      summary: entry.summary + chunk,
    };
  }

  finalizeAssistantEntry(entry: FeedEntry, status: "done" | "failed") {
    return {
      ...entry,
      summary: compactText(entry.summary || ""),
      status,
    };
  }

  eventRowsToEntries(
    workspaceId: WorkspaceId,
    runSummary: RunSummary | undefined,
    rows: Array<{
      seq: number;
      runId: string;
      timestampMs: number;
      type: string;
      payloadJson: string;
    }>,
  ): FeedEntry[] {
    return rows
      .map((row) => {
        const type = eventTypeToFeedType(row.type);
        if (!type) return null;
        const payload = parseJson(row.payloadJson) as Record<string, unknown>;
        const summary = summarizeEvent(row.type, payload, runSummary);

        return {
          id: `event-${row.runId}-${row.seq}`,
          workspaceId,
          type,
          timestampMs: row.timestampMs,
          source:
            type === "approval"
              ? "Approval"
              : type === "assistant"
                ? "Smithers"
                : type === "error"
                  ? "Error"
                  : "Run",
          summary,
          status:
            row.type === "RunFailed" || row.type === "NodeFailed"
              ? "failed"
              : row.type === "ApprovalRequested"
                ? "waiting"
                : row.type === "RunFinished" ||
                    row.type === "ApprovalGranted"
                  ? "done"
                  : "running",
          relatedRunId: row.runId,
          expanded: false,
          metadata: {
            seq: row.seq,
            eventType: row.type,
            payload,
          },
        } satisfies FeedEntry;
      })
      .filter((entry): entry is FeedEntry => entry !== null);
  }

  summarizeRunEntry(workspaceId: WorkspaceId, run: RunSummary): FeedEntry {
    return {
      id: `run-summary-${run.runId}`,
      workspaceId,
      type: "run",
      timestampMs: run.startedAtMs ?? Date.now(),
      source: "Run",
      summary: summarizeRun(run),
      status:
        run.status === "failed"
          ? "failed"
          : run.status === "finished"
            ? "done"
            : run.approvalPending
              ? "waiting"
              : "running",
      relatedRunId: run.runId,
      expanded: false,
      metadata: {
        summary: run,
      },
    };
  }
}
