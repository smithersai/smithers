export type WorkspaceId = string;
export type FeedEntryId = string;
export type RunId = string;
export type ProviderProfileId = string;
export type AttachmentId = string;
export type WorkflowId = string;

export type WorkspaceMode = "operator" | "plan" | "direct";
export type FocusRegion = "workspaces" | "feed" | "inspector" | "composer";
export type OverlayKind =
  | "palette"
  | "workflow-picker"
  | "approval-dialog"
  | "none";

export type FeedEntryType =
  | "user"
  | "assistant"
  | "tool"
  | "run"
  | "approval"
  | "artifact"
  | "diff"
  | "warning"
  | "error"
  | "summary";

export interface Workspace {
  id: WorkspaceId;
  title: string;
  cwd: string;
  repoRoot: string;
  mode: WorkspaceMode;
  providerProfileId: ProviderProfileId;
  sessionId: string;
  unreadCount: number;
  attention: "none" | "running" | "approval" | "failed" | "complete";
  pinnedContext: AttachmentId[];
  linkedRuns: RunId[];
  queuedMessages: QueuedMessage[];
  draft: string;
  latestNotification?: string;
  selection: WorkspaceSelectionState;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface FeedEntry {
  id: FeedEntryId;
  workspaceId: WorkspaceId;
  type: FeedEntryType;
  timestampMs: number;
  source: string;
  summary: string;
  body?: string; // Simplification of RichTextBlock
  status?: "running" | "done" | "failed" | "waiting";
  relatedRunId?: RunId;
  relatedWorkflowId?: string;
  relatedAttachmentIds?: AttachmentId[];
  groupKey?: string;
  expanded: boolean;
  metadata: Record<string, unknown>;
}

export interface WorkspaceSelectionState {
  selectedFeedEntryId: FeedEntryId | null;
  follow: boolean;
}

export interface QueuedMessage {
  id: string;
  prompt: string;
  queuedAtMs: number;
}

export interface RunSummary {
  runId: RunId;
  workflowId: string;
  workflowName: string;
  workflowPath?: string | null;
  status: string;
  startedAtMs?: number;
  finishedAtMs?: number;
  currentNodeId?: string | null;
  currentNodeLabel?: string | null;
  completedSteps?: number;
  totalSteps?: number;
  approvalPending?: boolean;
  providerProfileId?: string;
  tokenUsage?: TokenUsage;
  cost?: number;
  errorMessage?: string | null;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface WorkflowRecord {
  id: WorkflowId;
  displayName: string;
  entryFile: string;
  sourceType: "seeded" | "user" | "generated";
}

export interface ApprovalSummary {
  runId: RunId;
  nodeId: string;
  iteration: number;
  requestedAtMs?: number | null;
  note?: string | null;
  decidedBy?: string | null;
}

export interface RunNodeSummary {
  nodeId: string;
  label?: string | null;
  iteration: number;
  state: string;
  lastAttempt?: number | null;
  outputTable?: string | null;
  updatedAtMs?: number;
}

export interface OverlayState {
  kind: OverlayKind;
  selectedIndex?: number;
  query?: string;
  approval?: ApprovalSummary | null;
}

export interface AppState {
  workspaces: Workspace[];
  activeWorkspaceId: WorkspaceId | null;
  activeRunId: RunId | null;
  feed: FeedEntry[];
  runSummaries: Record<RunId, RunSummary>;
  runNodes: Record<RunId, RunNodeSummary[]>;
  approvals: Record<WorkspaceId, ApprovalSummary[]>;
  workflows: WorkflowRecord[];
  selectedFeedEntryId: FeedEntryId | null;
  focusRegion: FocusRegion;
  overlay: OverlayState;
  commandHint: string;
  statusLine: string;
  compactMode: boolean;
  quietHarbor: boolean;
  lastError?: string | null;
}

export interface PersistedAppSnapshot {
  version: number;
  activeWorkspaceId: WorkspaceId | null;
  activeRunId: RunId | null;
  focusRegion: FocusRegion;
  workspaces: Workspace[];
}

export interface UiEventEnvelope {
  seq: number;
  workspaceId: WorkspaceId;
  timeMs: number;
  source: "provider" | "smithers" | "system" | "user" | "broker";
  kind:
    | "token_delta"
    | "message_done"
    | "tool_started"
    | "tool_updated"
    | "tool_done"
    | "run_started"
    | "run_updated"
    | "run_finished"
    | "approval_requested"
    | "approval_resolved"
    | "artifact_created"
    | "notification"
    | "error"
    | "selection_hint";
  payload: any;
}
