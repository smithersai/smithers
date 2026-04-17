type RunStatus =
  | "running"
  | "waiting-approval"
  | "waiting-event"
  | "waiting-timer"
  | "finished"
  | "continued"
  | "failed"
  | "cancelled";

type RunState =
  | "running"
  | "waiting-approval"
  | "waiting-event"
  | "waiting-timer"
  | "recovering"
  | "stale"
  | "orphaned"
  | "failed"
  | "cancelled"
  | "succeeded"
  | "unknown";

type AgentCliActionKind =
  | "turn"
  | "command"
  | "tool"
  | "file_change"
  | "web_search"
  | "todo_list"
  | "reasoning"
  | "warning"
  | "note";

type AgentCliActionPhase = "started" | "updated" | "completed";
type AgentCliEventLevel = "debug" | "info" | "warning" | "error";

type AgentCliStartedEvent = {
  type: "started";
  engine: string;
  title: string;
  resume?: string;
  detail?: Record<string, unknown>;
};

type AgentCliActionEvent = {
  type: "action";
  engine: string;
  phase: AgentCliActionPhase;
  entryType?: "thought" | "message";
  action: {
    id: string;
    kind: AgentCliActionKind;
    title: string;
    detail?: Record<string, unknown>;
  };
  message?: string;
  ok?: boolean;
  level?: AgentCliEventLevel;
};

type AgentCliCompletedEvent = {
  type: "completed";
  engine: string;
  ok: boolean;
  answer?: string;
  error?: string;
  resume?: string;
  usage?: Record<string, unknown>;
};

type AgentCliEvent = AgentCliStartedEvent | AgentCliActionEvent | AgentCliCompletedEvent;

export type SmithersEvent =
  | {
      type: "SupervisorStarted";
      runId: string;
      pollIntervalMs: number;
      staleThresholdMs: number;
      timestampMs: number;
    }
  | {
      type: "SupervisorPollCompleted";
      runId: string;
      staleCount: number;
      resumedCount: number;
      skippedCount: number;
      durationMs: number;
      timestampMs: number;
    }
  | {
      type: "RunAutoResumed";
      runId: string;
      lastHeartbeatAtMs: number | null;
      staleDurationMs: number;
      timestampMs: number;
    }
  | {
      type: "RunAutoResumeSkipped";
      runId: string;
      reason: "pid-alive" | "missing-workflow" | "rate-limited";
      timestampMs: number;
    }
  | { type: "RunStarted"; runId: string; timestampMs: number }
  | {
      type: "RunStatusChanged";
      runId: string;
      status: RunStatus;
      timestampMs: number;
    }
  | {
      type: "RunStateChanged";
      runId: string;
      before: RunState;
      after: RunState;
      timestampMs: number;
    }
  | { type: "RunFinished"; runId: string; timestampMs: number }
  | { type: "RunFailed"; runId: string; error: unknown; timestampMs: number }
  | { type: "RunCancelled"; runId: string; timestampMs: number }
  | {
      type: "RunContinuedAsNew";
      runId: string;
      newRunId: string;
      iteration: number;
      carriedStateSize: number;
      ancestryDepth?: number;
      timestampMs: number;
    }
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
      type: "SandboxCreated";
      runId: string;
      sandboxId: string;
      runtime: "bubblewrap" | "docker" | "codeplane";
      configJson: string;
      timestampMs: number;
    }
  | {
      type: "SandboxShipped";
      runId: string;
      sandboxId: string;
      runtime: "bubblewrap" | "docker" | "codeplane";
      bundleSizeBytes: number;
      timestampMs: number;
    }
  | {
      type: "SandboxHeartbeat";
      runId: string;
      sandboxId: string;
      remoteRunId?: string;
      progress?: number;
      timestampMs: number;
    }
  | {
      type: "SandboxBundleReceived";
      runId: string;
      sandboxId: string;
      bundleSizeBytes: number;
      patchCount: number;
      hasOutputs: boolean;
      timestampMs: number;
    }
  | {
      type: "SandboxCompleted";
      runId: string;
      sandboxId: string;
      remoteRunId?: string;
      runtime: "bubblewrap" | "docker" | "codeplane";
      status: "finished" | "failed" | "cancelled";
      durationMs: number;
      timestampMs: number;
    }
  | {
      type: "SandboxFailed";
      runId: string;
      sandboxId: string;
      runtime: "bubblewrap" | "docker" | "codeplane";
      error: unknown;
      timestampMs: number;
    }
  | {
      type: "SandboxDiffReviewRequested";
      runId: string;
      sandboxId: string;
      patchCount: number;
      totalDiffLines: number;
      timestampMs: number;
    }
  | {
      type: "SandboxDiffAccepted";
      runId: string;
      sandboxId: string;
      patchCount: number;
      timestampMs: number;
    }
  | {
      type: "SandboxDiffRejected";
      runId: string;
      sandboxId: string;
      reason?: string;
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
      type: "TaskHeartbeat";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      hasData: boolean;
      dataSizeBytes: number;
      intervalMs?: number;
      timestampMs: number;
    }
  | {
      type: "TaskHeartbeatTimeout";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      lastHeartbeatAtMs: number;
      timeoutMs: number;
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
      type: "NodeWaitingTimer";
      runId: string;
      nodeId: string;
      iteration: number;
      firesAtMs: number;
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
      type: "ApprovalAutoApproved";
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
      type: "RetryTaskStarted";
      runId: string;
      nodeId: string;
      iteration: number;
      resetDependents: boolean;
      resetNodes: string[];
      timestampMs: number;
    }
  | {
      type: "RetryTaskFinished";
      runId: string;
      nodeId: string;
      iteration: number;
      resetNodes: string[];
      success: boolean;
      error?: string;
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
      type: "TimeTravelStarted";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      jjPointer?: string;
      timestampMs: number;
    }
  | {
      type: "TimeTravelFinished";
      runId: string;
      nodeId: string;
      iteration: number;
      attempt: number;
      jjPointer?: string;
      success: boolean;
      vcsRestored: boolean;
      resetNodes: string[];
      error?: string;
      timestampMs: number;
    }
  | {
      type: "TimeTravelJumped";
      runId: string;
      fromFrameNo: number;
      toFrameNo: number;
      timestampMs: number;
      caller?: string;
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
    }
  | {
      type: "TimerCreated";
      runId: string;
      timerId: string;
      firesAtMs: number;
      timerType: "duration" | "absolute";
      timestampMs: number;
    }
  | {
      type: "TimerFired";
      runId: string;
      timerId: string;
      firesAtMs: number;
      firedAtMs: number;
      delayMs: number;
      timestampMs: number;
    }
  | {
      type: "TimerCancelled";
      runId: string;
      timerId: string;
      timestampMs: number;
    };
