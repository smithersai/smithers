import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
  AgentEvent as PiAgentEvent,
} from "@mariozechner/pi-ai";

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type AttachmentDTO = {
  id: string;
  type: "image" | "document";
  fileName: string;
  mimeType: string;
  size: number;
  content: string;
  extractedText?: string;
  preview?: string;
};

export type UserMessageDTO = UserMessage & { attachments?: AttachmentDTO[] };

export type ArtifactMessageDTO = {
  role: "artifact";
  action: "create" | "update" | "delete";
  filename: string;
  content?: string;
  title?: string;
  timestamp: string;
};

export type WorkflowCardMessage = {
  role: "workflow";
  type: "smithers.workflow.card";
  runId: string;
  workflowName: string;
  status: "running" | "waiting-approval" | "finished" | "failed" | "cancelled";
  primaryNodeId?: string;
  approvals?: Array<{ nodeId: string; iteration?: number }>;
  timestamp: number;
};

export type AppMessageDTO =
  | AssistantMessage
  | ToolResultMessage
  | UserMessageDTO
  | ArtifactMessageDTO
  | WorkflowCardMessage
  | Message;

export type ChatSessionSummary = {
  sessionId: string;
  title?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  messageCount: number;
};

export type ChatSessionDTO = {
  sessionId: string;
  title?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  messages: AppMessageDTO[];
};

export type AgentStreamEventDTO = {
  runId: string;
  event: PiAgentEvent;
};

export type WorkflowRef = {
  path: string;
  name?: string;
  description?: string;
};

export type WorkspaceStateDTO = {
  root: string | null;
  workflows: WorkflowRef[];
};

export type RunStatus =
  | "running"
  | "waiting-approval"
  | "finished"
  | "failed"
  | "cancelled";

export type RunSummaryDTO = {
  runId: string;
  workflowPath: string;
  workflowName: string;
  status: RunStatus;
  startedAtMs: number;
  finishedAtMs?: number | null;
  attachedSessionId?: string | null;
  workspaceRoot?: string | null;
  activeNodes?: string[];
  waitingApprovals?: number;
};

export type WorkflowNodeDTO = {
  runId: string;
  nodeId: string;
  iteration: number;
  state: string;
  lastAttempt?: number | null;
  needsApproval?: boolean | null;
  lastError?: unknown;
};

export type ApprovalDTO = {
  runId: string;
  nodeId: string;
  iteration: number;
  decision?: "approved" | "denied";
  note?: string | null;
  requestedAtMs?: number | null;
  decidedAtMs?: number | null;
};

export type RunDetailDTO = {
  run: RunSummaryDTO;
  nodes: WorkflowNodeDTO[];
  approvals: ApprovalDTO[];
  lastSeq: number;
};

export type SmithersEventDTO =
  | { type: "RunStarted"; runId: string; timestampMs: number }
  | { type: "RunStatusChanged"; runId: string; status: RunStatus; timestampMs: number }
  | { type: "RunFinished"; runId: string; timestampMs: number }
  | { type: "RunFailed"; runId: string; error: unknown; timestampMs: number }
  | { type: "RunCancelled"; runId: string; timestampMs: number }
  | { type: "FrameCommitted"; runId: string; frameNo: number; xmlHash: string; timestampMs: number }
  | { type: "NodePending"; runId: string; nodeId: string; iteration: number; timestampMs: number }
  | { type: "NodeStarted"; runId: string; nodeId: string; iteration: number; attempt: number; timestampMs: number }
  | { type: "NodeFinished"; runId: string; nodeId: string; iteration: number; attempt: number; timestampMs: number }
  | { type: "NodeFailed"; runId: string; nodeId: string; iteration: number; attempt: number; error: unknown; timestampMs: number }
  | { type: "NodeCancelled"; runId: string; nodeId: string; iteration: number; attempt?: number; reason?: string; timestampMs: number }
  | { type: "NodeSkipped"; runId: string; nodeId: string; iteration: number; timestampMs: number }
  | { type: "NodeRetrying"; runId: string; nodeId: string; iteration: number; attempt: number; timestampMs: number }
  | { type: "NodeWaitingApproval"; runId: string; nodeId: string; iteration: number; timestampMs: number }
  | { type: "ApprovalRequested"; runId: string; nodeId: string; iteration: number; timestampMs: number }
  | { type: "ApprovalGranted"; runId: string; nodeId: string; iteration: number; timestampMs: number }
  | { type: "ApprovalDenied"; runId: string; nodeId: string; iteration: number; timestampMs: number }
  | { type: "NodeOutput"; runId: string; nodeId: string; iteration: number; attempt: number; text: string; stream: "stdout" | "stderr"; timestampMs: number }
  | { type: "RevertStarted"; runId: string; nodeId: string; jjPointer: string | null; timestampMs: number }
  | { type: "RevertFinished"; runId: string; nodeId: string; jjPointer: string | null; success: boolean; timestampMs: number };

export type FrameSnapshotDTO = {
  runId: string;
  frameNo: number;
  timestampMs: number;
  xmlHash?: string;
  xml?: string;
  graph: {
    nodes: Array<{
      id: string;
      label: string;
      kind: "Task" | "Sequence" | "Parallel" | "Branch" | "Ralph" | "Workflow" | "Unknown";
      state?: string;
      iteration?: number;
      maxIterations?: number;
      ralphId?: string;
    }>;
    edges: Array<{ from: string; to: string }>;
  };
};

export type RunOutputsDTO = {
  runId: string;
  tables: Array<{ name: string; rows: unknown[] }>;
};

export type RunAttemptsDTO = {
  runId: string;
  attempts: Array<{
    nodeId: string;
    iteration: number;
    attempt: number;
    state: string;
    startedAtMs?: number | null;
    finishedAtMs?: number | null;
    errorJson?: string | null;
    jjPointer?: string | null;
    metaJson?: string | null;
    responseText?: string | null;
  }>;
};

export type ToolCallDTO = {
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

export type RunToolCallsDTO = {
  runId: string;
  toolCalls: ToolCallDTO[];
};

export type DbQueryResultDTO = {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
};

export type AgentSettings = {
  provider: "openai" | "anthropic";
  model: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
};

export type SmithersSettings = {
  allowNetwork?: boolean;
};

export type SettingsDTO = {
  ui: {
    workflowPanel: { isOpen: boolean; width: number };
    artifactsPanelOpen: boolean;
    lastWorkspaceRoot: string | null;
  };
  agent: AgentSettings;
  smithers: SmithersSettings;
};

export type SecretKey = "openai.apiKey" | "anthropic.apiKey";

export type SecretStatusDTO = {
  openai: boolean;
  anthropic: boolean;
};

export type RpcProcedures = {
  openWorkspace: { params: { path: string }; response: { ok: true } };
  getWorkspaceState: { params: {}; response: WorkspaceStateDTO };

  listChatSessions: { params: {}; response: ChatSessionSummary[] };
  createChatSession: {
    params: { title?: string };
    response: { sessionId: string };
  };
  getChatSession: {
    params: { sessionId: string };
    response: ChatSessionDTO;
  };
  sendChatMessage: {
    params: {
      sessionId: string;
      text: string;
      attachments?: AttachmentDTO[];
    };
    response: { runId: string };
  };
  abortChatRun: {
    params: { sessionId: string; runId: string };
    response: { ok: true };
  };

  listWorkflows: { params: { root?: string }; response: WorkflowRef[] };
  runWorkflow: {
    params: {
      workflowPath: string;
      input: unknown;
      attachToSessionId?: string;
    };
    response: { runId: string };
  };
  listRuns: {
    params: { status?: "active" | "finished" | "failed" | "all" };
    response: RunSummaryDTO[];
  };
  getRun: { params: { runId: string }; response: RunDetailDTO };
  getRunEvents: {
    params: { runId: string; afterSeq?: number };
    response: { events: SmithersEventDTO[]; lastSeq: number };
  };
  getFrame: {
    params: { runId: string; frameNo?: number };
    response: FrameSnapshotDTO;
  };
  getRunOutputs: { params: { runId: string }; response: RunOutputsDTO };
  getRunAttempts: { params: { runId: string }; response: RunAttemptsDTO };
  getRunToolCalls: { params: { runId: string }; response: RunToolCallsDTO };
  queryRunDb: { params: { runId: string; sql: string }; response: DbQueryResultDTO };
  approveNode: {
    params: { runId: string; nodeId: string; iteration?: number; note?: string };
    response: { ok: true };
  };
  denyNode: {
    params: { runId: string; nodeId: string; iteration?: number; note?: string };
    response: { ok: true };
  };
  cancelRun: { params: { runId: string }; response: { ok: true } };
  resumeRun: { params: { runId: string }; response: { ok: true } };

  getSettings: { params: {}; response: SettingsDTO };
  setSettings: { params: { patch: DeepPartial<SettingsDTO> }; response: SettingsDTO };
  getSecretStatus: { params: {}; response: SecretStatusDTO };
  setSecret: { params: { key: SecretKey; value: string }; response: { ok: true } };
  clearSecret: { params: { key: SecretKey }; response: { ok: true } };

  browseDirectory: { params: { startingFolder?: string }; response: { path: string | null } };
};

export type RpcMessages = {
  agentEvent: AgentStreamEventDTO;
  chatMessage: { sessionId: string; message: AppMessageDTO };
  workflowEvent: SmithersEventDTO & { seq: number };
  workflowFrame: FrameSnapshotDTO;
  workspaceState: WorkspaceStateDTO;
  toast: { level: "info" | "warning" | "error"; message: string };
};
