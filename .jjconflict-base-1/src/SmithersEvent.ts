import type { RunStatus } from "./RunStatus";
import type { AgentCliEvent } from "./agents/BaseCliAgent";

export type SmithersEvent =
  | { type: "RunStarted"; runId: string; timestampMs: number }
  | {
      type: "RunStatusChanged";
      runId: string;
      status: RunStatus;
      timestampMs: number;
    }
  | { type: "RunFinished"; runId: string; timestampMs: number }
  | { type: "RunFailed"; runId: string; error: unknown; timestampMs: number }
  | { type: "RunCancelled"; runId: string; timestampMs: number }
  | {
      type: "RunHijackRequested";
      runId: string;
      target?: string;
      timestampMs: number;
    }
  | {
      type: "RunHijacked";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      engine: string;
      mode: "native-cli" | "conversation";
      resume?: string | null;
      cwd: string;
      timestampMs: number;
    }
  | {
      type: "FrameCommitted";
      runId: string;
      frameNo: number;
      xmlHash: string;
      timestampMs: number;
    }
  | {
      type: "NodePending";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "NodeStarted";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      timestampMs: number;
    }
  | {
      type: "NodeFinished";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      timestampMs: number;
    }
  | {
      type: "NodeFailed";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      error: unknown;
      timestampMs: number;
    }
  | {
      type: "NodeCancelled";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt?: number;
      reason?: string;
      timestampMs: number;
    }
  | {
      type: "NodeSkipped";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "NodeRetrying";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      timestampMs: number;
    }
  | {
      type: "NodeWaitingApproval";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "ApprovalRequested";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "ApprovalGranted";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "ApprovalDenied";
      runId: string;
      nodeId: string;
      iteration: number;
      timestampMs: number;
    }
  | {
      type: "ToolCallStarted";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      toolName: string;
      seq: number;
      timestampMs: number;
    }
  | {
      type: "ToolCallFinished";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      toolName: string;
      seq: number;
      status: "success" | "error";
      timestampMs: number;
    }
  | {
      type: "NodeOutput";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      text: string;
      stream: "stdout" | "stderr";
      timestampMs: number;
    }
  | {
      type: "AgentEvent";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      engine: string;
      event: AgentCliEvent;
      timestampMs: number;
    }
  | {
      type: "RevertStarted";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      jjPointer: string;
      timestampMs: number;
    }
  | {
      type: "RevertFinished";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      jjPointer: string;
      success: boolean;
      error?: string;
      timestampMs: number;
    }
  | {
      type: "WorkflowReloadDetected";
      runId: string;
      changedFiles: string[];
      timestampMs: number;
    }
  | {
      type: "WorkflowReloaded";
      runId: string;
      generation: number;
      changedFiles: string[];
      timestampMs: number;
    }
  | {
      type: "WorkflowReloadFailed";
      runId: string;
      error: unknown;
      changedFiles: string[];
      timestampMs: number;
    }
  | {
      type: "WorkflowReloadUnsafe";
      runId: string;
      reason: string;
      changedFiles: string[];
      timestampMs: number;
    }
  | {
      type: "ScorerStarted";
      runId: string;
      nodeId: string;
      scorerId: string;
      scorerName: string;
      timestampMs: number;
    }
  | {
      type: "ScorerFinished";
      runId: string;
      nodeId: string;
      scorerId: string;
      scorerName: string;
      score: number;
      timestampMs: number;
    }
  | {
      type: "ScorerFailed";
      runId: string;
      nodeId: string;
      scorerId: string;
      scorerName: string;
      error: unknown;
      timestampMs: number;
    }
  | {
      type: "TokenUsageReported";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      model: string;
      agent: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number;
      timestampMs: number;
    }
  | {
      type: "SnapshotCaptured";
      runId: string;
      frameNo: number;
      contentHash: string;
      timestampMs: number;
    }
  | {
      type: "RunForked";
      runId: string;
      parentRunId: string;
      parentFrameNo: number;
      branchLabel?: string;
      timestampMs: number;
    }
  | {
      type: "ReplayStarted";
      runId: string;
      parentRunId: string;
      parentFrameNo: number;
      restoreVcs: boolean;
      timestampMs: number;
    }
  | {
      type: "VoiceStarted";
      runId: string;
      nodeId: string;
      iteration: number;
      operation: "speak" | "listen";
      provider: string;
      timestampMs: number;
    }
  | {
      type: "VoiceFinished";
      runId: string;
      nodeId: string;
      iteration: number;
      operation: "speak" | "listen";
      provider: string;
      durationMs: number;
      timestampMs: number;
    }
  | {
      type: "VoiceError";
      runId: string;
      nodeId: string;
      iteration: number;
      operation: "speak" | "listen";
      provider: string;
      error: unknown;
      timestampMs: number;
    }
  | {
      type: "RagIngested";
      runId: string;
      documentCount: number;
      chunkCount: number;
      namespace: string;
      timestampMs: number;
    }
  | {
      type: "RagRetrieved";
      runId: string;
      query: string;
      resultCount: number;
      namespace: string;
      topScore: number;
      timestampMs: number;
    }
| {
      type: "MemoryFactSet";
      runId: string;
      namespace: string;
      key: string;
      timestampMs: number;
    }
  | {
      type: "MemoryRecalled";
      runId: string;
      namespace: string;
      query: string;
      resultCount: number;
      timestampMs: number;
    }
  | {
      type: "MemoryMessageSaved";
      runId: string;
      threadId: string;
      role: string;
      timestampMs: number;
    }
  | {
      type: "OpenApiToolCalled";
      runId: string;
      operationId: string;
      method: string;
      path: string;
      durationMs: number;
      status: "success" | "error";
      timestampMs: number;
    };
