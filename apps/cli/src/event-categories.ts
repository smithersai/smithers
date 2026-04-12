import type { SmithersEvent } from "@smithers/observability/SmithersEvent";

export type SmithersEventType = SmithersEvent["type"];

export type EventCategory =
  | "agent"
  | "approval"
  | "frame"
  | "memory"
  | "node"
  | "openapi"
  | "output"
  | "revert"
  | "run"
  | "sandbox"
  | "scorer"
  | "snapshot"
  | "supervisor"
  | "timer"
  | "token"
  | "tool-call"

  | "workflow";

const EVENT_CATEGORY_BY_TYPE: Record<SmithersEventType, EventCategory> = {
  SupervisorStarted: "supervisor",
  SupervisorPollCompleted: "supervisor",
  RunAutoResumed: "run",
  RunAutoResumeSkipped: "run",
  RunStarted: "run",
  RunStatusChanged: "run",
  RunFinished: "run",
  RunFailed: "run",
  RunCancelled: "run",
  RunContinuedAsNew: "run",
  RunHijackRequested: "run",
  RunHijacked: "run",
  SandboxCreated: "sandbox",
  SandboxShipped: "sandbox",
  SandboxHeartbeat: "sandbox",
  SandboxBundleReceived: "sandbox",
  SandboxCompleted: "sandbox",
  SandboxFailed: "sandbox",
  SandboxDiffReviewRequested: "sandbox",
  SandboxDiffAccepted: "sandbox",
  SandboxDiffRejected: "sandbox",
  FrameCommitted: "frame",
  NodePending: "node",
  NodeStarted: "node",
  TaskHeartbeat: "node",
  TaskHeartbeatTimeout: "node",
  NodeFinished: "node",
  NodeFailed: "node",
  NodeCancelled: "node",
  NodeSkipped: "node",
  NodeRetrying: "node",
  NodeWaitingApproval: "node",
  NodeWaitingTimer: "node",
  ApprovalRequested: "approval",
  ApprovalGranted: "approval",
  ApprovalAutoApproved: "approval",
  ApprovalDenied: "approval",
  ToolCallStarted: "tool-call",
  ToolCallFinished: "tool-call",
  NodeOutput: "output",
  AgentEvent: "agent",
  RetryTaskStarted: "run",
  RetryTaskFinished: "run",
  RevertStarted: "revert",
  RevertFinished: "revert",
  TimeTravelStarted: "revert",
  TimeTravelFinished: "revert",
  WorkflowReloadDetected: "workflow",
  WorkflowReloaded: "workflow",
  WorkflowReloadFailed: "workflow",
  WorkflowReloadUnsafe: "workflow",
  ScorerStarted: "scorer",
  ScorerFinished: "scorer",
  ScorerFailed: "scorer",
  TokenUsageReported: "token",
  SnapshotCaptured: "snapshot",
  RunForked: "run",
  ReplayStarted: "run",

  MemoryFactSet: "memory",
  MemoryRecalled: "memory",
  MemoryMessageSaved: "memory",
  OpenApiToolCalled: "openapi",
  TimerCreated: "timer",
  TimerFired: "timer",
  TimerCancelled: "timer",
};

const CATEGORY_ALIASES: Record<string, EventCategory> = {
  agent: "agent",
  approval: "approval",
  approvals: "approval",
  frame: "frame",
  memory: "memory",
  node: "node",
  openapi: "openapi",
  output: "output",
  revert: "revert",
  run: "run",
  sandbox: "sandbox",
  scorer: "scorer",
  snapshot: "snapshot",
  supervisor: "supervisor",
  timer: "timer",
  token: "token",
  tool: "tool-call",
  toolcall: "tool-call",
  "tool-call": "tool-call",
  "tool_call": "tool-call",

  workflow: "workflow",
  reload: "workflow",
};

const EVENT_TYPES_BY_CATEGORY = Object.entries(
  EVENT_CATEGORY_BY_TYPE,
).reduce<Record<EventCategory, SmithersEventType[]>>(
  (acc, [type, category]) => {
    if (!acc[category]) acc[category] = [];
    acc[category].push(type as SmithersEventType);
    return acc;
  },
  {
    agent: [],
    approval: [],
    frame: [],
    memory: [],
    node: [],
    openapi: [],
    output: [],
    revert: [],
    run: [],
    sandbox: [],
    scorer: [],
    snapshot: [],
    supervisor: [],
    timer: [],
    token: [],
    "tool-call": [],

    workflow: [],
  },
);

export const EVENT_CATEGORY_VALUES = Object.keys(
  EVENT_TYPES_BY_CATEGORY,
) as EventCategory[];

export function normalizeEventCategory(raw: string): EventCategory | null {
  const key = raw.trim().toLowerCase();
  return CATEGORY_ALIASES[key] ?? null;
}

export function eventCategoryForType(type: string): EventCategory | null {
  return (EVENT_CATEGORY_BY_TYPE as Record<string, EventCategory | undefined>)[
    type
  ] ?? null;
}

export function eventTypesForCategory(
  category: EventCategory,
): readonly SmithersEventType[] {
  return EVENT_TYPES_BY_CATEGORY[category];
}
